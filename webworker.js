// webworker.js - runs Pyodide + Datasette in a dedicated Web Worker.
//
// The shell page (index.html) owns this worker. Once Datasette has started, the
// shell forwards every request that the service worker (sw.js) intercepts under
// the app prefix to this worker, which answers it by calling Datasette's ASGI
// application directly - links, form submissions (GET and POST), fetch() calls
// made by Datasette's own JavaScript and by plugins, static assets, downloads.
//
// Python source lives in String.raw blocks so the pure-Python unit tests can
// extract and exercise the exact code that runs in the browser. Constraint:
// those blocks must contain no backticks and no "${".

const PYODIDE_VERSION = "0.27.2";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
importScripts(PYODIDE_URL + "pyodide.js");

function log(line) {
  console.log({line});
  self.postMessage({type: 'log', line: line});
}

function databaseFiles(sqliteUrls) {
  const baseNames = sqliteUrls.map(
    url => url.split('.db')[0].split('/').slice(-1)[0]
  );
  const reservedNames = new Set(baseNames);
  const usedNames = new Set();

  return sqliteUrls.map((url, index) => {
    const baseName = baseNames[index];
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${baseName}_${suffix}`;
      suffix += 1;
      // Do not take the name of another, differently named input file.
      while (reservedNames.has(name) || usedNames.has(name)) {
        name = `${baseName}_${suffix}`;
        suffix += 1;
      }
    }
    usedNames.add(name);
    return [name + ".db", url];
  });
}

// PYTHON-BEGIN bridge
const BRIDGE_PY = String.raw`
import asyncio
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


def _default_cookie_path(request_path):
    # RFC 6265 section 5.1.4
    if not request_path.startswith("/") or request_path.count("/") == 1:
        return "/"
    return request_path.rsplit("/", 1)[0]


def _path_matches(request_path, cookie_path):
    if request_path == cookie_path:
        return True
    if request_path.startswith(cookie_path):
        return cookie_path.endswith("/") or request_path[len(cookie_path)] == "/"
    return False


class CookieJar:
    """A minimal per-tab cookie jar.

    A service worker can neither read the Cookie request header nor set the
    Set-Cookie response header (both are forbidden header names), so cookies
    can never reach the browser's own cookie store. Instead the bridge keeps
    them here: Set-Cookie headers from Datasette are stored, and a Cookie
    header is synthesized for every subsequent request. This is what makes
    CSRF tokens, ds_actor sign-in, flash messages and plugin logins work."""

    def __init__(self):
        self._cookies = {}  # (name, path) -> value

    def header_for(self, request_path):
        matches = [
            (name, path, value)
            for (name, path), value in self._cookies.items()
            if _path_matches(request_path, path)
        ]
        # Longer paths first, as browsers do
        matches.sort(key=lambda item: -len(item[1]))
        return "; ".join("{}={}".format(name, value) for name, path, value in matches)

    def store(self, set_cookie, request_path):
        parts = [part.strip() for part in set_cookie.split(";")]
        if not parts or "=" not in parts[0]:
            return
        name, _, value = parts[0].partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            return
        attrs = {}
        for part in parts[1:]:
            key, _, attr_value = part.partition("=")
            attrs[key.strip().lower()] = attr_value.strip()
        path = attrs.get("path") or ""
        if not path.startswith("/"):
            path = _default_cookie_path(request_path)
        expired = False
        if "max-age" in attrs:
            try:
                expired = int(attrs["max-age"]) <= 0
            except ValueError:
                pass
        elif attrs.get("expires"):
            try:
                expires = parsedate_to_datetime(attrs["expires"])
                if expires.tzinfo is None:
                    expires = expires.replace(tzinfo=timezone.utc)
                expired = expires <= datetime.now(timezone.utc)
            except (TypeError, ValueError, IndexError):
                pass
        if expired:
            self._cookies.pop((name, path), None)
        else:
            self._cookies[(name, path)] = value

    def as_dict(self):
        return {name: value for (name, path), value in self._cookies.items()}


class ASGIBridge:
    """Drives an ASGI app: runs the lifespan protocol once and handles HTTP
    requests one message-cycle at a time, returning a plain dict response."""

    def __init__(self, app, root_path=""):
        self.app = app
        self.root_path = root_path
        self.cookies = CookieJar()
        self._lifespan_task = None
        self._startup_complete = None
        self._recv_queue = None

    async def startup(self):
        loop = asyncio.get_event_loop()
        self._recv_queue = asyncio.Queue()
        self._startup_complete = loop.create_future()
        scope = {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}}
        await self._recv_queue.put({"type": "lifespan.startup"})

        async def receive():
            return await self._recv_queue.get()

        async def send(message):
            t = message["type"]
            if t == "lifespan.startup.complete":
                if not self._startup_complete.done():
                    self._startup_complete.set_result(True)
            elif t == "lifespan.startup.failed":
                if not self._startup_complete.done():
                    self._startup_complete.set_exception(
                        RuntimeError(message.get("message", "lifespan startup failed"))
                    )

        async def run():
            try:
                await self.app(scope, receive, send)
            except Exception as exc:
                # Apps without lifespan support may raise; that's fine
                if not self._startup_complete.done():
                    self._startup_complete.set_result(False)
            finally:
                if not self._startup_complete.done():
                    self._startup_complete.set_result(False)

        self._lifespan_task = asyncio.ensure_future(run())
        await self._startup_complete

    async def handle(self, method, path, query_string, headers, body=b"",
                     scheme="http", host="localhost", port=80, raw_path=None):
        if isinstance(query_string, str):
            query_string = query_string.encode("latin-1")
        if isinstance(body, str):
            body = body.encode("utf-8")
        if body is None:
            body = b""

        raw_headers = []
        have_host = False
        cookie_values = []
        for name, value in headers:
            lower = name.lower()
            if lower == "host":
                have_host = True
            if lower == "cookie":
                cookie_values.append(value)
                continue
            raw_headers.append((lower.encode("latin-1"), value.encode("latin-1")))
        jar_cookies = self.cookies.header_for(path)
        if jar_cookies:
            cookie_values.append(jar_cookies)
        if cookie_values:
            raw_headers.append((b"cookie", "; ".join(cookie_values).encode("latin-1")))
        if not have_host:
            # A service worker cannot forward the browser-managed Host header,
            # so synthesize one - including any non-default port, otherwise
            # absolute URLs generated by the app point at the wrong place.
            host_header = host
            if int(port) not in (80, 443):
                host_header = host + ":" + str(int(port))
            raw_headers.append((b"host", host_header.encode("latin-1")))

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method.upper(),
            "scheme": scheme,
            "path": path,
            "raw_path": (raw_path if raw_path is not None else path).encode("utf-8"),
            "query_string": query_string,
            "root_path": self.root_path,
            "headers": raw_headers,
            "server": (host, int(port)),
            "client": ("127.0.0.1", 0),
        }

        request_messages = [{"type": "http.request", "body": body, "more_body": False}]
        response_complete = asyncio.Event()

        async def receive():
            if request_messages:
                return request_messages.pop(0)
            # Block like a real server until the response has been sent
            await response_complete.wait()
            return {"type": "http.disconnect"}

        response = {"status": 500, "headers": [], "body": bytearray()}

        async def send(message):
            t = message["type"]
            if t == "http.response.start":
                response["status"] = message["status"]
                response["headers"] = [
                    [k.decode("latin-1"), v.decode("latin-1")]
                    for k, v in message.get("headers", [])
                ]
            elif t == "http.response.body":
                chunk = message.get("body", b"") or b""
                response["body"].extend(chunk)
                if not message.get("more_body"):
                    response_complete.set()

        try:
            await self.app(scope, receive, send)
        finally:
            response_complete.set()

        headers_out = []
        for name, value in response["headers"]:
            if name.lower() == "set-cookie":
                self.cookies.store(value, path)
            else:
                headers_out.append([name, value])
        return {
            "status": response["status"],
            "headers": headers_out,
            "body": bytes(response["body"]),
        }


HARDCODED_ATTRIBUTE_RE = re.compile(
    rb"""(\s(?:href|action|src|formaction)=["'])/-/""", re.IGNORECASE
)


def datasette_base_url_fixes(app, base_url):
    """Work around places where Datasette does not fully honor base_url.

    1. Datasette 1.0a base.html hardcodes the "Jump to" navigation search
       endpoint as url="/-/jump", so its fetch() escapes the app prefix.
    2. Some URLs double-apply base_url, because urls.path() is passed a path
       derived from request.path, which already includes base_url: the
       table/row/query export links, and the redirect after submitting the
       table filter form in Datasette 0.x.
    3. Some redirects (e.g. the 1.0a /db?sql= -> /db/-/query redirect) send
       a Location without the base_url prefix.

    base_url includes a random per-tab session id, so a doubled prefix such as
    /app/3f2a9c/app/3f2a9c/ can only ever be this bug - it is safe to collapse
    it everywhere."""
    prefix = base_url.rstrip("/").encode("latin-1")
    doubled = prefix + prefix + b"/"
    single = prefix + b"/"
    rewrite_types = (b"text/html", b"application/json")

    def fix_body(body):
        if doubled in body:
            body = body.replace(doubled, single)
        return body

    def fix_location(value):
        value = fix_body(value)
        if (
            value.startswith(b"/")
            and not value.startswith(b"//")
            and value != prefix
            and not value.startswith(single)
        ):
            value = prefix + value
        return value

    async def wrapped(scope, receive, send):
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        state = {"rewrite": False, "html": False}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = []
                for key, value in message.get("headers", []):
                    lower = key.lower()
                    if lower == b"location":
                        value = fix_location(value)
                    elif lower == b"content-type":
                        content_type = value.lower()
                        state["rewrite"] = any(t in content_type for t in rewrite_types)
                        state["html"] = b"text/html" in content_type
                    headers.append((key, value))
                if state["rewrite"]:
                    # Body length may change
                    headers = [(k, v) for k, v in headers if k.lower() != b"content-length"]
                await send({**message, "headers": headers})
            elif message["type"] == "http.response.body" and state["rewrite"]:
                body = fix_body(message.get("body", b"") or b"")
                if state["html"]:
                    body = body.replace(b'"/-/jump"', b'"' + prefix + b'/-/jump"')
                    # Plugins sometimes hardcode root-relative /-/ URLs, e.g.
                    # action="/-/password-tool". If Datasette Lite is served
                    # from a subdirectory those navigations would escape the
                    # service worker's scope entirely, so fix them here.
                    body = HARDCODED_ATTRIBUTE_RE.sub(
                        lambda m: m.group(1) + prefix + b"/-/", body
                    )
                await send({**message, "body": body})
            else:
                await send(message)

        await app(scope, receive, send_wrapper)

    return wrapped
`;
// PYTHON-END bridge

// PYTHON-BEGIN startup
const STARTUP_PY = String.raw`
# https://github.com/pyodide/pyodide/issues/3880#issuecomment-1560130092
import os, sys
import csv
import json
os.link = os.symlink
# Recent platformdirs releases (imported by Datasette's vendored pint) call
# os.geteuid(), which Pyodide does not provide
if not hasattr(os, "geteuid"):
    os.geteuid = os.getuid

settings = json.loads(settings_json)
to_load = settings["to_load"]
sources = settings["sources"]

# Increase CSV field size limit to maximim possible
# https://stackoverflow.com/a/15063941
field_size_limit = sys.maxsize

while True:
    try:
        csv.field_size_limit(field_size_limit)
        break
    except OverflowError:
        field_size_limit = int(field_size_limit / 10)


async def fetch_bytes(url):
    response = await pyfetch(url)
    if not response.ok:
        raise ValueError("Could not load {}: HTTP {}".format(url, response.status))
    return await response.bytes()


import sqlite3
from pyodide.http import pyfetch
names = []
for name, url in to_load:
    if url:
        content = await fetch_bytes(url)
        with open(name, "wb") as fp:
            fp.write(content)
    else:
        sqlite3.connect(name).execute("vacuum")
    names.append(name)

import micropip
await micropip.install("python-multipart==0.0.15")
# To avoid possible 'from typing_extensions import deprecated' error:
await micropip.install('typing-extensions>=4.12.2')
try:
    await micropip.install(settings["datasette_to_install"], pre=settings["pre"])
except ValueError:
    # Older Datasette releases: workaround for "Requested 'h11<0.13,>=0.11',
    # but h11==0.13.0 is already installed". Not used by default because
    # httpx==0.23 pulls in Pyodide's bundled idna 3.7, which conflicts with
    # recent 1.0 alphas (they need idna>=3.18)
    await micropip.install("h11==0.12.0")
    await micropip.install("httpx==0.23")
    await micropip.install(settings["datasette_to_install"], pre=settings["pre"])
import re


async def install_resolving_conflicts(requirement, attempts=5):
    """micropip can't upgrade an already installed package, so a plugin that
    needs e.g. click>=8.3.1 fails if Datasette already pulled in Pyodide's
    bundled click 8.1.7. Nothing has been imported yet at this point, so it is
    safe to uninstall the conflicting package and install what was asked for."""
    for _ in range(attempts):
        try:
            await micropip.install(requirement)
            return
        except ValueError as ex:
            match = re.search(r"Requested '(.+?)', but (\S+)==\S+ is already installed", str(ex))
            if not match:
                raise
            micropip.uninstall(match.group(2))
            await micropip.install(match.group(1))
    await micropip.install(requirement)


# Install any extra ?install= dependencies
for install_url in settings["install_urls"]:
    await install_resolving_conflicts(install_url)
# Execute any ?sql=URL SQL
for sql_url in [url for kind, urls in sources if kind == "sql" for url in urls]:
    # Fetch that SQL and execute it
    sql = (await fetch_bytes(sql_url)).decode("utf-8")
    sqlite3.connect("data.db").executescript(sql)
metadata = {
    "about": "Datasette Lite",
    "about_url": "https://github.com/simonw/datasette-lite"
}
from datasette.utils import parse_metadata
if settings["metadata_url"]:
    content = (await fetch_bytes(settings["metadata_url"])).decode("utf-8")
    metadata = parse_metadata(content)
config = None
if settings["config_url"]:
    content = (await fetch_bytes(settings["config_url"])).decode("utf-8")
    config = parse_metadata(content)

# Import data from ?csv=URL CSV files/?json=URL JSON files
import_sources = [source for source in sources if source[0] in ("csv", "json", "parquet")]
if import_sources:
    try:
        # Datasette 1.0 alphas already depend on sqlite-utils 4
        import sqlite_utils
    except ImportError:
        await install_resolving_conflicts("sqlite-utils==3.28")
        import sqlite_utils
    from sqlite_utils.utils import rows_from_file, TypeTracker, Format
    db = sqlite_utils.Database("data.db")
    table_names = set()
    for source_type, urls in import_sources:
        for url in urls:
            # Derive table name from URL
            bit = url.split("/")[-1].split(".")[0].split("?")[0]
            bit = bit.strip()
            if not bit:
                bit = "table"
            prefix = 0
            base_bit = bit
            while bit in table_names:
                prefix += 1
                bit = "{}_{}".format(base_bit, prefix)
            table_names.add(bit)

            if source_type == "csv":
                tracker = TypeTracker()
                csv_bytes = await fetch_bytes(url)
                with open("csv.csv", "wb") as fp:
                    fp.write(csv_bytes)

                # Auto-detect CSV delimiter (comma vs semicolon)
                sample_lines = csv_bytes.decode('utf-8', errors='ignore').splitlines()[:5]

                # Count semicolons vs commas in the sample
                semicolon_count = sum(line.count(';') for line in sample_lines)
                comma_count = sum(line.count(',') for line in sample_lines)

                if semicolon_count > comma_count and semicolon_count > 0:
                    # Use semicolon as delimiter
                    import csv as csv_module
                    from io import StringIO

                    csv_content = csv_bytes.decode('utf-8', errors='ignore')
                    csv_reader = csv_module.reader(StringIO(csv_content), delimiter=';')
                    rows = list(csv_reader)

                    if rows:
                        headers = rows[0]
                        data_rows = rows[1:]
                        dict_rows = [dict(zip(headers, row)) for row in data_rows]

                        db[bit].insert_all(
                            tracker.wrap(dict_rows),
                            alter=True
                        )
                else:
                    # Use default comma delimiter
                    db[bit].insert_all(
                        tracker.wrap(rows_from_file(open("csv.csv", "rb"), Format.CSV)[0]),
                        alter=True
                    )

                db[bit].transform(
                    types=tracker.types
                )
            elif source_type == "json":
                pk = None
                json_bytes = await fetch_bytes(url)
                try:
                    json_data = json.loads(json_bytes)
                except json.decoder.JSONDecodeError:
                    # Maybe it's newline-delimited JSON?
                    # This will raise an unhandled exception if not
                    json_data = [json.loads(line) for line in json_bytes.splitlines() if line.strip()]
                if isinstance(json_data, dict) and all(isinstance(v, dict) for v in json_data.values()):
                    fixed = []
                    pk = "_key"
                    for key, value in json_data.items():
                        value["_key"] = key
                        fixed.append(value)
                    json_data = fixed
                elif isinstance(json_data, dict):
                    object_lists = [
                        value for value in json_data.values()
                        if (
                            isinstance(value, list)
                            and value
                            and all(isinstance(item, dict) for item in value)
                        )
                    ]
                    if object_lists:
                        json_data = max(object_lists, key=len)
                assert isinstance(json_data, list), "JSON data must be a list of objects"
                db[bit].insert_all(json_data, pk=pk, alter=True)
            elif source_type == "parquet":
                await micropip.install("fastparquet")
                import fastparquet
                with open("parquet.parquet", "wb") as fp:
                    fp.write(await fetch_bytes(url))
                df = fastparquet.ParquetFile("parquet.parquet").to_pandas()
                # sqlite-utils can't store pandas Timestamps - use ISO strings
                for column in df.select_dtypes(include=["datetime", "datetimetz"]).columns:
                    df[column] = df[column].map(
                        lambda value: None if value != value else value.isoformat()
                    )
                db[bit].insert_all(df.to_dict(orient="records"), alter=True)

from datasette.app import Datasette
import inspect

datasette_kwargs = {}
if config is not None:
    if "config" not in inspect.signature(Datasette.__init__).parameters:
        raise ValueError(
            "?config= requires Datasette 1.0a8 or later - try adding &ref=pre"
        )
    if isinstance(config.get("settings"), dict):
        # These are controlled by Datasette Lite itself
        for key in ("base_url", "num_sql_threads"):
            config["settings"].pop(key, None)
    datasette_kwargs["config"] = config

ds = Datasette(names, settings={
    # Keep every URL Datasette generates inside the service worker's scope
    "base_url": settings["base_url"],
    # Pyodide has no threads: run SQLite queries inline on the event loop
    "num_sql_threads": 0,
}, metadata=metadata, memory=settings["memory"], **datasette_kwargs)
await ds.invoke_startup()

bridge = ASGIBridge(datasette_base_url_fixes(ds.app(), settings["base_url"]))
await bridge.startup()

if settings["root"]:
    # The equivalent of "datasette --root": enable the root actor and sign in
    # by visiting the one-time token URL, so the ds_actor cookie lands in the
    # bridge's cookie jar - exactly as it would in a real browser.
    import secrets
    ds.root_enabled = True
    ds._root_token = secrets.token_hex(32)
    _response = await bridge.handle(
        "GET", settings["base_url"] + "-/auth-token",
        "token=" + ds._root_token, [], b"",
        host="localhost",
    )
    if "ds_actor" not in bridge.cookies.as_dict():
        raise ValueError("Could not sign in as root: HTTP {}".format(_response["status"]))
`;
// PYTHON-END startup

const HANDLE_PY = String.raw`
import json
from urllib.parse import unquote
from js import Object
from pyodide.ffi import to_js


async def handle_request(method, raw_path, query, headers_json, body_buf, scheme, host, port):
    headers = json.loads(headers_json)
    body = b"" if body_buf is None else body_buf.to_py().tobytes()
    resp = await bridge.handle(
        method, unquote(raw_path), query, headers, body,
        scheme=scheme, host=host, port=int(port), raw_path=raw_path,
    )
    return to_js(
        {"status": resp["status"], "headers": resp["headers"], "body": resp["body"]},
        dict_converter=Object.fromEntries,
    )
`;

async function startDatasette(settings) {
  let toLoad = [];
  let sources = [];
  let needsDataDb = false;
  let shouldLoadDefaults = true;
  // Which version of Datasette to install?
  let datasetteToInstall = 'datasette';
  let pre = false;
  if (settings.ref) {
    if (settings.ref == 'pre') {
      pre = true;
    } else {
      datasetteToInstall = `datasette==${settings.ref}`;
    }
  }
  const sqliteUrls = (settings.sqliteUrls || []).filter(Boolean);
  if (sqliteUrls.length) {
    toLoad.push(...databaseFiles(sqliteUrls));
    shouldLoadDefaults = false;
  }
  ['csv', 'sql', 'json', 'parquet'].forEach(sourceType => {
    const urls = (settings[`${sourceType}Urls`] || []).filter(Boolean);
    if (urls.length) {
      sources.push([sourceType, urls]);
      needsDataDb = true;
      shouldLoadDefaults = false;
    }
  });
  if (settings.memory) {
    shouldLoadDefaults = false;
  }
  if (needsDataDb) {
    toLoad.push(["data.db", null]);
  }
  if (shouldLoadDefaults) {
    toLoad.push(["fixtures.db", "https://latest.datasette.io/fixtures.db"]);
    toLoad.push(["content.db", "https://datasette.io/content.db"]);
  }
  self.pyodide = await loadPyodide({
    indexURL: PYODIDE_URL,
    fullStdLib: true
  });
  await pyodide.loadPackage('micropip', {messageCallback: log});
  await pyodide.loadPackage('ssl', {messageCallback: log});
  await pyodide.loadPackage('setuptools', {messageCallback: log}); // For pkg_resources
  // Values are passed as data, never interpolated into Python source
  pyodide.globals.set("settings_json", JSON.stringify({
    to_load: toLoad,
    sources,
    datasette_to_install: datasetteToInstall,
    pre,
    install_urls: (settings.installUrls || []).filter(Boolean),
    metadata_url: settings.metadataUrl || null,
    config_url: settings.configUrl || null,
    memory: !!settings.memory,
    root: !!settings.root,
    base_url: settings.baseUrl,
  }));
  log("Installing Datasette...");
  await pyodide.runPythonAsync(BRIDGE_PY);
  await pyodide.runPythonAsync(STARTUP_PY);
  await pyodide.runPythonAsync(HANDLE_PY);
  self.pyHandleRequest = pyodide.globals.get("handle_request");
}

async function handleRequest(msg) {
  const url = new URL(msg.url);
  const port = url.port
    ? parseInt(url.port, 10)
    : (url.protocol === "https:" ? 443 : 80);
  const result = await self.pyHandleRequest(
    msg.method,
    url.pathname,
    url.search.replace(/^\?/, ""),
    JSON.stringify(msg.headers || []),
    msg.body ? new Uint8Array(msg.body) : new Uint8Array(),
    url.protocol.replace(":", ""),
    url.hostname,
    port,
  );
  // Copy the body out of the WASM heap so it can be transferred
  const body = result.body ? result.body.slice() : new Uint8Array();
  return {status: result.status, headers: result.headers, body: body.buffer};
}

let readyPromise = null;

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type == 'startup') {
    readyPromise = startDatasette(data);
    try {
      await readyPromise;
      self.postMessage({type: 'ready'});
    } catch (error) {
      self.postMessage({type: 'error', error: error.message});
    }
    return;
  }
  if (data.type == 'request') {
    try {
      await readyPromise;
      const response = await handleRequest(data);
      self.postMessage({type: 'response', id: data.id, ...response}, [response.body]);
    } catch (error) {
      const body = new TextEncoder().encode(
        "Datasette Lite error: " + ((error && error.message) || error)
      ).buffer;
      self.postMessage({
        type: 'response', id: data.id, status: 500,
        headers: [["content-type", "text/plain; charset=utf-8"]], body
      }, [body]);
    }
  }
};

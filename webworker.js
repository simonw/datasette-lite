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

const PYODIDE_VERSION = "314.0.8";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// ?sqlite=3.54.1 swaps the SQLite built into Pyodide for that version, using
// a pysqlite3 wheel built by https://github.com/datasette/pysqlite3-wasm-wheels
// wheels.json at this URL lists the wheels, with paths relative to it.
const SQLITE_WHEELS_URL = "https://datasette.github.io/pysqlite3-wasm-wheels/";
// The wheel tags for PYODIDE_VERSION. A wheel works on any Pyodide release
// that has these tags, not only the one it was built against.
const PYODIDE_PYTHON_TAG = "cp314";
const PYODIDE_PLATFORM_TAG = "pyemscripten_2026_0_wasm32";
// ?ref=main (or any other branch, tag or commit) runs Datasette from a zip of
// its source on GitHub, and ?install=owner/repo does the same for a plugin.
// GitHub does not serve those zips with CORS headers, so they are fetched
// through this proxy, which adds them:
// https://<proxy>/<owner>/<repo>/<ref>
const GITHUB_ZIP_PROXY = "https://github-zip-cors-proxy.simonw.workers.dev";
const DATASETTE_REPO = "simonw/datasette";
// This file is a module worker - shell.js starts it with {type: "module"} -
// because Pyodide no longer runs in classic workers. Pyodide itself is
// imported in startDatasette() rather than here: a top-level await would
// delay self.onmessage being set until after the shell's "startup" message
// had arrived, and the message would be lost.

// --- Startup progress ----------------------------------------------------------
//
// Starting up is a number of steps, several of which are in progress at the
// same time: files download while Pyodide loads and packages are installed.
// The shell shows each step on the loading screen, with a spinner until it is
// told the step is done. A step is {id, label}; later messages with the same
// id change its label, report the bytes downloaded so far, or finish it.

let stepCount = 0;

function startStep(label, id) {
  id = id || `step-${++stepCount}`;
  console.log({step: label});
  self.postMessage({type: 'step', id, label});
  return id;
}

function updateStep(id, changes) {
  self.postMessage({type: 'step', id, ...changes});
}

function finishStep(id, changes) {
  self.postMessage({type: 'step', id, done: true, ...changes});
}

// The startup Python calls these with "from js import startStep". A function
// declared in a module is not a global, so make them global.
self.startStep = (label) => startStep(label);
self.finishStep = (id) => finishStep(id);
self.renameStep = (id, label) => updateStep(id, {label});

// --- Downloads -----------------------------------------------------------------
//
// Files are downloaded here, with fetch(), rather than by Python - so that
// every file named in the page's URL can start downloading the moment the
// worker starts, before there is a Python to ask for it. Python collects each
// one with download() when it gets to the point of needing it, by which time
// it has usually arrived.

// URL -> Promise of the download, for those nothing has collected yet
const downloads = new Map();

// Resolves to {ok, status, bytes}: bytes is a Uint8Array, missing if the
// server answered with an error status. Rejects if there was no answer.
async function fetchFile(url) {
  const step = startStep("Downloading " + url);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Could not load ${url}: ${(error && error.message) || error}`);
  }
  if (!response.ok) {
    return {ok: false, status: response.status};
  }
  // Read in pieces, to show how much has arrived so far
  const chunks = [];
  let received = 0;
  let reported = 0;
  // A response with nothing in it - a 204, say - has no body to read
  const reader = response.body && response.body.getReader();
  for (;;) {
    const {done, value} = reader ? await reader.read() : {done: true};
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    const now = performance.now();
    if (now - reported > 100) {
      reported = now;
      updateStep(step, {bytes: received});
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  finishStep(step, {bytes: received});
  return {ok: true, status: response.status, bytes};
}

// Start downloading a file that download() will be called for later
function prefetch(url) {
  if (url && !downloads.has(url)) {
    const started = fetchFile(url);
    // A failure is reported when the file is collected. Until then it must
    // not count as an unhandled rejection.
    started.catch(() => {});
    downloads.set(url, started);
  }
}

// The download of a file: the one prefetch() started, or a new one. Each
// download is handed out once, so the file can be freed once it has been used.
function download(url) {
  const started = downloads.get(url);
  if (started) {
    downloads.delete(url);
    return started;
  }
  return fetchFile(url);
}
self.download = download;

// A file name without its extension, as Python's Path(name).stem - which is
// how Datasette names a database: "chinook.sqlite" is the database "chinook"
function stem(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(0, dot) : fileName;
}

// Is this ?ref= a release to install from PyPI - 0.64.2, 1.0a11, 1.0rc1?
// A short commit SHA made only of digits looks like one too: use the full
// SHA for those.
function isVersionNumber(ref) {
  return /^\d+(\.\d+)*((a|b|rc)\d+)?(\.?(post|dev)\d+)*$/.test(ref);
}

// JS-BEGIN install
// Is this ?ref= something GitHub could have a branch, tag or commit for?
// Mirrors what the zip proxy accepts.
function isGitRef(ref) {
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(ref) &&
    ref.split("/").every(part => part !== "" && !part.startsWith("."));
}

// ?install=simonw/datasette-cluster-map and
// ?install=https://github.com/simonw/datasette-cluster-map both name a GitHub
// repository, to run a plugin from the source in it rather than from a
// release on PyPI. Either can end in @ref for a branch, tag or commit other
// than the default branch, and the URLs of GitHub's own pages for those -
// /tree/<branch or tag>, /commit/<sha>, /pull/<number> - work too.
//
// Returns {repo: "owner/repo", ref} - ref is null for the default branch -
// or null for anything else: a package name, a requirement such as
// datasette-leaflet>=0.3 or the URL of a wheel. None of those can be
// mistaken for a repository - a package name has no / in it.
function githubSource(install) {
  const match = /^(https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(\/|@.+|\/(?:tree|commit|pull)\/.+)?$/.exec(install);
  if (!match) {
    return null;
  }
  const [, isUrl, owner, repo, rest] = match;
  // dist/plugin.whl is a wheel, and . and .. are not repositories
  if (/^\.+$/.test(repo) || repo.endsWith(".whl")) {
    return null;
  }
  let ref = null;
  if (rest && rest !== "/") {
    if (rest.startsWith("@")) {
      ref = rest.slice(1);
    } else if (!isUrl) {
      return null;
    } else {
      const [, page, value] = /^\/(tree|commit|pull)\/(.+?)\/?$/.exec(rest);
      if (page == "pull") {
        // The pull request itself, not its /files or /commits tab. GitHub
        // keeps a ref for each one, which works for those from forks too.
        if (!/^\d+$/.test(value)) {
          return null;
        }
        ref = `refs/pull/${value}/head`;
      } else {
        // All of it: a branch can have a / in its name
        ref = value;
      }
    }
    if (!isGitRef(ref)) {
      return null;
    }
  }
  return {repo: `${owner}/${repo}`, ref};
}

// Any other github.com URL that is not a wheel - an issue, a file, a list of
// releases - is a mistake, and micropip's error for it would not say why
function isOtherGithubUrl(install) {
  return /^https?:\/\/(www\.)?github\.com(\/|$)/.test(install) &&
    !githubSource(install) && !/\.whl([?#]|$)/.test(install);
}
// JS-END install

// JS-BEGIN sqlite
// Is this ?sqlite= a SQLite version number - 3.54.1, 3.54, 3.8.11.1?
function isSqliteVersion(value) {
  return /^\d+\.\d+(\.\d+){0,2}$/.test(value);
}

function sqliteVersionError(value) {
  return new Error(
    `?sqlite=${value} is not a SQLite version number, e.g. ?sqlite=3.54.1`
  );
}

// The wheel in wheels.json to use for ?sqlite=version on a Pyodide with these
// tags. Where there are several, the one built most recently.
function chooseSqliteWheel(index, version, pythonTag, platformTag) {
  const wheels = ((index && index.wheels) || []).filter(
    wheel => wheel.python_tag === pythonTag && wheel.platform_tag === platformTag
  );
  const matches = wheels.filter(wheel => wheel.sqlite_version === version);
  if (!matches.length) {
    // Most recent version first
    const numbers = v => String(v).split(".").map(Number);
    const available = [...new Set(wheels.map(wheel => wheel.sqlite_version))].sort(
      (a, b) => {
        const [x, y] = [numbers(a), numbers(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
          if ((x[i] || 0) !== (y[i] || 0)) {
            return (y[i] || 0) - (x[i] || 0);
          }
        }
        return 0;
      }
    );
    throw new Error(
      `?sqlite=${version} is not available: there is no SQLite ${version} ` +
      `wheel for ${pythonTag} ${platformTag}. ` + (
        available.length
          ? `Available versions: ${available.join(", ")}`
          : "No SQLite versions are available for it."
      )
    );
  }
  // Date.parse() rather than comparing strings, in case the format changes
  const built = wheel => Date.parse(wheel.built) || 0;
  return matches.reduce((best, wheel) => (built(wheel) > built(best) ? wheel : best));
}

// The URL of the wheel for ?sqlite=version, looked up in wheels.json
async function findSqliteWheelUrl(version, baseUrl, pythonTag, platformTag) {
  if (!isSqliteVersion(version)) {
    throw sqliteVersionError(version);
  }
  const indexUrl = new URL("wheels.json", baseUrl).href;
  let index;
  try {
    const response = await fetch(indexUrl);
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    index = await response.json();
  } catch (error) {
    throw new Error(
      `?sqlite=${version} could not be used. Could not load ${indexUrl}: ` +
      ((error && error.message) || error)
    );
  }
  const wheel = chooseSqliteWheel(index, version, pythonTag, platformTag);
  return new URL(wheel.path, baseUrl).href;
}
// JS-END sqlite

function databaseFiles(sqliteUrls) {
  // Each database is saved as <name>.db, so <name> is what Datasette calls it.
  // Names must stay stable: they are part of every shared #/name/table link.
  const baseNames = sqliteUrls.map(
    url => stem(url.split('.db')[0].split('/').slice(-1)[0])
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


class ResponseStream:
    """Where the bridge delivers a response that the app sends in more than
    one piece - a server-sent events endpoint, a streaming CSV export - so
    that it reaches the browser as it is produced, not once it is complete.

    on_start(status, headers) is called once, followed by on_chunk(bytes) any
    number of times. Pieces sent in quick succession are combined, so that an
    export of a million rows is not a million messages: a chunk is passed on
    once FLUSH_BYTES have built up, or FLUSH_SECONDS after its first piece."""

    FLUSH_BYTES = 64 * 1024
    FLUSH_SECONDS = 0.02

    def __init__(self, on_start, on_chunk):
        self._on_start = on_start
        self._on_chunk = on_chunk
        self.started = False
        self.disconnected = False
        self._on_disconnect = []
        self._buffer = bytearray()
        self._timer = None

    def start(self, status, headers):
        self.started = True
        if not self.disconnected:
            self._on_start(status, headers)

    def write(self, chunk):
        if self.disconnected or not chunk:
            return
        self._buffer.extend(chunk)
        if len(self._buffer) >= self.FLUSH_BYTES:
            self.flush()
        elif self._timer is None:
            self._timer = asyncio.get_event_loop().call_later(
                self.FLUSH_SECONDS, self.flush
            )

    def flush(self):
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._buffer:
            chunk = bytes(self._buffer)
            del self._buffer[:]
            if not self.disconnected:
                self._on_chunk(chunk)

    def disconnect(self):
        """The browser has stopped reading the response: it navigated away,
        or aborted the fetch(). The app is told with http.disconnect, as a
        server would tell it, and anything it still sends is discarded."""
        if self.disconnected:
            return
        self.disconnected = True
        self.flush()
        for callback in self._on_disconnect:
            callback()


class ASGIBridge:
    """Drives an ASGI app: runs the lifespan protocol once and handles HTTP
    requests one message-cycle at a time, returning a plain dict response.

    Pass handle() a ResponseStream to have a response that arrives in several
    pieces delivered through it instead - the dict returned then has an empty
    body and "streamed": True. A response sent in one piece is returned in
    the dict as usual."""

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
                     scheme="http", host="localhost", port=80, raw_path=None,
                     stream=None):
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
        # Set once the response has been sent, or the browser stops reading it
        response_complete = asyncio.Event()
        if stream is not None:
            stream._on_disconnect.append(response_complete.set)

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
                response["headers"] = []
                for name, value in message.get("headers", []):
                    name = name.decode("latin-1")
                    value = value.decode("latin-1")
                    if name.lower() == "set-cookie":
                        self.cookies.store(value, path)
                    else:
                        response["headers"].append([name, value])
            elif t == "http.response.body":
                chunk = message.get("body", b"") or b""
                more_body = bool(message.get("more_body"))
                if stream is not None and (more_body or stream.started):
                    # More than one piece: pass each on as it arrives
                    if not stream.started:
                        stream.start(response["status"], response["headers"])
                    stream.write(chunk)
                else:
                    response["body"].extend(chunk)
                if not more_body:
                    response_complete.set()

        try:
            await self.app(scope, receive, send)
        finally:
            response_complete.set()
            if stream is not None:
                stream.flush()

        result = {
            "status": response["status"],
            "headers": response["headers"],
            "body": bytes(response["body"]),
        }
        if stream is not None and stream.started:
            result["streamed"] = True
        return result


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
        state = {"rewrite": False, "html": False, "chunks": []}

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
                # Buffer the whole body and rewrite it once, so a pattern
                # split across two chunks is not missed
                state["chunks"].append(message.get("body", b"") or b"")
                if message.get("more_body"):
                    return
                body = fix_body(b"".join(state["chunks"]))
                state["chunks"] = []
                if state["html"]:
                    body = body.replace(b'"/-/jump"', b'"' + prefix + b'/-/jump"')
                    # Plugins sometimes hardcode root-relative /-/ URLs, e.g.
                    # action="/-/password-tool". If Datasette Lite is served
                    # from a subdirectory those navigations would escape the
                    # service worker's scope entirely, so fix them here.
                    # The regular expression is slow - seconds, for a page
                    # of tens of megabytes - so it is only run on a body
                    # that has something in it for it to match.
                    if b'="/-/' in body or b"='/-/" in body:
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

# Pyodide is built without OpenSSL, so hashlib lacks the functions OpenSSL
# provides. datasette-auth-passwords (and anything else that hashes passwords
# the standard way) needs pbkdf2_hmac: this is the pure Python implementation
# CPython itself shipped as a fallback until Python 3.12.
import hashlib
if not hasattr(hashlib, "pbkdf2_hmac"):
    _trans_5C = bytes((x ^ 0x5C) for x in range(256))
    _trans_36 = bytes((x ^ 0x36) for x in range(256))

    def _pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None):
        if not isinstance(hash_name, str):
            raise TypeError(hash_name)
        if not isinstance(password, (bytes, bytearray)):
            password = bytes(memoryview(password))
        if not isinstance(salt, (bytes, bytearray)):
            salt = bytes(memoryview(salt))
        inner = hashlib.new(hash_name)
        outer = hashlib.new(hash_name)
        blocksize = getattr(inner, "block_size", 64)
        if len(password) > blocksize:
            password = hashlib.new(hash_name, password).digest()
        password = password + b"\x00" * (blocksize - len(password))
        inner.update(password.translate(_trans_36))
        outer.update(password.translate(_trans_5C))

        def prf(msg, inner=inner, outer=outer):
            icpy = inner.copy()
            ocpy = outer.copy()
            icpy.update(msg)
            ocpy.update(icpy.digest())
            return ocpy.digest()

        if iterations < 1:
            raise ValueError(iterations)
        if dklen is None:
            dklen = outer.digest_size
        if dklen < 1:
            raise ValueError(dklen)
        dkey = b""
        loop = 1
        while len(dkey) < dklen:
            prev = prf(salt + loop.to_bytes(4, "big"))
            rkey = int.from_bytes(prev, "big")
            for _ in range(iterations - 1):
                prev = prf(prev)
                rkey ^= int.from_bytes(prev, "big")
            loop += 1
            dkey += rkey.to_bytes(inner.digest_size, "big")
        return dkey[:dklen]

    hashlib.pbkdf2_hmac = _pbkdf2_hmac

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


import contextlib
from js import download, startStep, finishStep, renameStep


@contextlib.contextmanager
def step(label):
    """A step shown on the loading screen: in progress for as long as the
    with block runs. Steps can overlap - the downloads are steps too, and
    carry on while these run. Yields an id for renameStep()."""
    step_id = startStep(label)
    yield step_id
    finishStep(step_id)


async def fetch_bytes(url):
    # The worker started downloading every file named in the page's URL
    # before Python was loaded: this waits for the one asked for, which is
    # its own step on the loading screen
    result = await download(url)
    if not result.ok:
        raise ValueError("Could not load {}: HTTP {}".format(url, result.status))
    return result.bytes.to_bytes()


def file_name(url):
    "The last part of a URL's path, for naming a file on the loading screen"
    return url.split("?")[0].split("#")[0].rstrip("/").split("/")[-1] or url


class SourceZipError(ValueError):
    "A repository that cannot be installed straight from its source"


def install_source_zip(zip_bytes, site_packages):
    """Install a pure Python package from a zip of its GitHub repository, as
    served by https://github.com/<owner>/<repo>/archive/<ref>.zip

    Nothing is built: this copies the package (or single module) out of the
    zip into site_packages and writes a .dist-info directory next to it.
    That directory is what makes the package count as installed - it is
    where Datasette finds a plugin's entry point, and without it anything
    that requires the package would have micropip install a second copy
    from PyPI.

    The code is looked for where build backends look by default: a package
    or module named after the project, at the top of the repository or in
    src/. Failing that, any packages found in one of those two places.

    Returns (name, version, dependencies, commit). The dependencies are the
    requirement strings from the zip's pyproject.toml, which the caller needs
    to install. commit is the SHA GitHub records in the zip, or None.

    Raises SourceZipError, before anything is written, for a repository that
    cannot be installed this way."""
    import io
    import pathlib
    import re
    import tomllib
    import zipfile

    archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    names = [name for name in archive.namelist() if not name.endswith("/")]
    # Everything is inside one directory, named after the repository and ref
    roots = set(name.split("/", 1)[0] for name in archive.namelist())
    if len(roots) != 1:
        raise ValueError("Not a GitHub source zip: expected one top level directory")
    root = roots.pop() + "/"
    for name in names:
        if any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("Unsafe path in zip: " + name)
    files = set(names)
    if root + "pyproject.toml" not in files:
        raise SourceZipError("it has no pyproject.toml")
    project = tomllib.loads(archive.read(root + "pyproject.toml").decode("utf-8")).get("project") or {}
    name = project.get("name")
    if not name:
        raise SourceZipError("its pyproject.toml has no [project] name")
    dependencies = list(project.get("dependencies") or [])

    # Where is the code? (directory it is in, package directory or module file)
    normalized = re.sub(r"[-_.]+", "_", name).lower()
    found = []
    bases = (root + "src/", root)
    for base in bases:
        if base + normalized + "/__init__.py" in files:
            found = [(base, normalized + "/")]
            break
        if base + normalized + ".py" in files:
            found = [(base, normalized + ".py")]
            break
    for base in bases:
        if found:
            break
        # Not named after the project: any packages there are, other than
        # the ones that are never the code itself
        packages = set(
            path[len(base):].split("/")[0]
            for path in files
            if path.startswith(base) and path[len(base):].count("/") == 1
            and path.endswith("/__init__.py")
        ) - {"tests", "test", "docs", "doc", "examples", "example", "scripts", "tools", "benchmarks"}
        found = [(base, package + "/") for package in sorted(packages)]
    if not found:
        raise SourceZipError(
            "could not find its Python code - looked for {0}/__init__.py and "
            "{0}.py, at the top of the repository and in src/".format(normalized)
        )

    version = project.get("version")
    if not version:
        # A dynamic version: look for __version__ = "..." in the code
        for base, code in found:
            candidates = [code] if code.endswith(".py") else [
                code + "version.py", code + "__version__.py", code + "__about__.py", code + "__init__.py"
            ]
            for candidate in candidates:
                if base + candidate in files:
                    match = re.search(
                        r"""^__version__\s*=\s*["']([^"']+)["']""",
                        archive.read(base + candidate).decode("utf-8"),
                        re.M,
                    )
                    if match:
                        version = match.group(1)
                        break
            if version:
                break
    if not version:
        raise SourceZipError(
            "could not find its version number - it needs a version in "
            "pyproject.toml, or a __version__ in the package"
        )
    # GitHub stores the commit the zip was made from as the zip's comment
    comment = archive.comment.decode("ascii", "replace").strip()
    commit = comment if re.fullmatch(r"[0-9a-f]{40}", comment) else None

    site_packages = pathlib.Path(site_packages)
    for base, code in found:
        for path in names:
            if path.startswith(base + code):
                target = site_packages.joinpath(*path[len(base):].split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(path))

    dist_info = site_packages / "{}-{}.dist-info".format(normalized, version)
    dist_info.mkdir(parents=True, exist_ok=True)
    metadata = ["Metadata-Version: 2.1", "Name: " + name, "Version: " + version]
    metadata.extend("Requires-Dist: " + dependency for dependency in dependencies)
    (dist_info / "METADATA").write_text("\n".join(metadata) + "\n")
    (dist_info / "INSTALLER").write_text("datasette-lite\n")
    entry_points = {"console_scripts": project.get("scripts") or {}}
    entry_points.update(project.get("entry-points") or {})
    lines = []
    for group, entries in entry_points.items():
        if entries:
            lines.append("[{}]".format(group))
            lines.extend("{} = {}".format(key, value) for key, value in entries.items())
            lines.append("")
    (dist_info / "entry_points.txt").write_text("\n".join(lines))
    return name, version, dependencies, commit


def install_datasette_source(zip_bytes, site_packages):
    """Install Datasette from a zip of its GitHub repository, for ?ref=.
    Returns (version, dependencies, commit) - see install_source_zip()."""
    try:
        return install_source_zip(zip_bytes, site_packages)[1:]
    except SourceZipError as ex:
        raise ValueError(
            "This version of Datasette cannot be run from source: {}. For an "
            "older release use its version number, e.g. ?ref=0.64.2".format(ex)
        )


def use_pysqlite3_as_sqlite3():
    """Make "import sqlite3" give pysqlite3, which has the SQLite version
    that ?sqlite= asked for compiled in.

    Datasette and sqlite-utils use pysqlite3 by themselves if it is
    installed. Plugins do not, and nor does the code below that loads CSV
    and SQL files: without this they would use the SQLite built into Pyodide,
    and "except sqlite3.OperationalError" in a plugin would not catch an
    error raised by pysqlite3."""
    import sys
    import pysqlite3
    import pysqlite3.dbapi2
    sys.modules["sqlite3"] = pysqlite3
    sys.modules["sqlite3.dbapi2"] = pysqlite3.dbapi2


import micropip
import importlib, importlib.metadata
import site
if settings["sqlite_wheel_url"]:
    # ?sqlite= - before Datasette is installed, and before anything has
    # imported sqlite3
    with step("Installing SQLite " + settings["sqlite_version"]):
        try:
            await micropip.install(settings["sqlite_wheel_url"])
        except Exception as ex:
            raise ValueError("?sqlite={} could not be used. Could not install {}: {}".format(
                settings["sqlite_version"], settings["sqlite_wheel_url"], ex
            ))
        use_pysqlite3_as_sqlite3()
with step("Installing Datasette") as install_step:
    # One call, so that all three are looked up and downloaded together.
    # They cannot go in the call that installs Datasette as well: micropip
    # resolves the requirements of one call concurrently, and a dependency
    # of Datasette that asks for any idna can be given the one bundled with
    # Pyodide before idna>=3.18 has been found on PyPI.
    await micropip.install([
        # Pyodide bundles idna 3.11, but httpx2 (used by Datasette 1.0 alphas) needs >=3.18
        "idna>=3.18",
        "python-multipart==0.0.15",
        # To avoid possible 'from typing_extensions import deprecated' error:
        "typing-extensions>=4.12.2",
    ])
    if settings["datasette_source_url"]:
        # ?ref= named a branch, tag or commit: run Datasette from its source
        try:
            source_zip = await fetch_bytes(settings["datasette_source_url"])
        except ValueError as ex:
            if "HTTP 404" in str(ex):
                raise ValueError(
                    "?ref={} is not a branch, tag or commit in the Datasette "
                    "repository on GitHub".format(settings["datasette_source_ref"])
                )
            raise
        source_version, source_dependencies, source_commit = install_datasette_source(
            source_zip, site.getsitepackages()[0]
        )
        del source_zip
        importlib.invalidate_caches()
        renameStep(install_step, "Installing Datasette {}{}".format(
            source_version, " (commit {})".format(source_commit[:7]) if source_commit else ""
        ))
        await micropip.install(source_dependencies, pre=True)
    else:
        try:
            await micropip.install(settings["datasette_to_install"], pre=settings["pre"])
        except ValueError:
            # Older Datasette releases: workaround for "Requested 'h11<0.13,>=0.11',
            # but h11==0.13.0 is already installed". Only used as a fallback, as
            # recent releases don't need these pins
            await micropip.install("h11==0.12.0")
            await micropip.install("httpx==0.23")
            await micropip.install(settings["datasette_to_install"], pre=settings["pre"])
        renameStep(install_step, "Installing Datasette " + importlib.metadata.version("datasette"))
import re


async def install_resolving_conflicts(requirement, attempts=5, pre=False):
    """micropip can't upgrade an already installed package, so a plugin that
    needs e.g. click>=8.3.1 fails if Datasette already pulled in Pyodide's
    bundled click 8.1.7. Nothing has been imported yet at this point, so it is
    safe to uninstall the conflicting package and install what was asked for."""
    for _ in range(attempts):
        try:
            await micropip.install(requirement, pre=pre)
            return
        except ValueError as ex:
            match = re.search(r"Requested '(.+?)', but (\S+)==\S+ is already installed", str(ex))
            if not match:
                raise
            micropip.uninstall(match.group(2))
            await micropip.install(match.group(1))
    await micropip.install(requirement, pre=pre)


# Install any extra ?install= dependencies. When Datasette itself is a preview
# release so are the plugins: plugin releases that support a Datasette alpha
# are published as alphas too, and the stable ones often do not work with it.
for install in settings["installs"]:
    if not install["source_url"]:
        with step("Installing " + install["requirement"]):
            await install_resolving_conflicts(install["requirement"], pre=settings["pre"])
        continue
    # ?install=owner/repo, owner/repo@ref or a GitHub URL: run the plugin
    # from the source in that repository
    with step("Installing " + install["repo"]) as plugin_step:
        try:
            plugin_zip = await fetch_bytes(install["source_url"])
        except ValueError as ex:
            if "HTTP 404" in str(ex):
                if install["ref"]:
                    raise ValueError(
                        "?install={} could not be used: {} is not a branch, tag or commit in "
                        "a public {} repository on GitHub".format(
                            install["requirement"], install["ref"], install["repo"].split("@")[0]
                        )
                    )
                raise ValueError("?install={} could not be used: there is no public {} repository on GitHub".format(
                    install["requirement"], install["repo"]
                ))
            if "HTTP 403" in str(ex):
                raise ValueError(
                    "?install={} could not be used: the proxy that Datasette Lite downloads "
                    "GitHub repositories through does not serve {}".format(
                        install["requirement"], install["repo"].split("@")[0]
                    )
                )
            raise
        try:
            plugin_name, plugin_version, plugin_dependencies, plugin_commit = install_source_zip(
                plugin_zip, site.getsitepackages()[0]
            )
        except SourceZipError as ex:
            raise ValueError("?install={} cannot be installed from its source: {}".format(
                install["requirement"], ex
            ))
        del plugin_zip
        importlib.invalidate_caches()
        renameStep(plugin_step, "Installing {} {} from {}{}".format(
            plugin_name, plugin_version, install["repo"],
            " (commit {})".format(plugin_commit[:7]) if plugin_commit else ""
        ))
        if plugin_dependencies:
            await install_resolving_conflicts(plugin_dependencies, pre=settings["pre"])


async def install_missing_requirements():
    """Some packages built into the Pyodide distribution do not list their
    dependencies - starlette lists none, so a plugin that needs starlette gets
    it without anyio and fails on import. micropip trusts that list, so check
    what is installed against each package's own metadata and install
    anything that is missing."""
    from importlib.metadata import distributions
    try:
        from packaging.requirements import Requirement
    except ImportError:
        try:
            # micropip carries its own copy
            from micropip._vendored.packaging.src.packaging.requirements import Requirement
        except ImportError:
            return

    def normalize(name):
        return re.sub(r"[-_.]+", "-", name).lower()

    # A fix can itself bring in a package with the same problem
    for _ in range(3):
        installed = {normalize(dist.metadata["Name"]) for dist in distributions()}
        missing = set()
        for dist in distributions():
            for line in dist.requires or []:
                requirement = Requirement(line)
                # Skips optional extras, and requirements for other platforms
                if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                    continue
                if normalize(requirement.name) not in installed:
                    missing.add(requirement.name)
        if not missing:
            return
        with step("Installing missing dependencies: " + ", ".join(sorted(missing))):
            for name in sorted(missing):
                try:
                    await micropip.install(name)
                except Exception:
                    # Not installable here - leave it to fail where it is used,
                    # as it would have without this check
                    pass


if settings["installs"]:
    await install_missing_requirements()

# The database files. These have been downloading since the worker started:
# they are collected here, after the installs, so that neither waits for
# the other.
import sqlite3
names = []
for name, url in to_load:
    if url:
        content = await fetch_bytes(url)
        with open(name, "wb") as fp:
            fp.write(content)
        del content
    else:
        sqlite3.connect(name).execute("vacuum")
    names.append(name)

# Execute any ?sql=URL SQL
for sql_url in [url for kind, urls in sources if kind == "sql" for url in urls]:
    # Fetch that SQL and execute it
    sql = (await fetch_bytes(sql_url)).decode("utf-8")
    with step("Running SQL from " + file_name(sql_url)):
        sqlite3.connect("data.db").executescript(sql)

# Import data from ?csv=URL CSV files/?json=URL JSON files
import_sources = [source for source in sources if source[0] in ("csv", "json", "parquet")]
if import_sources:
    try:
        # Datasette 1.0 alphas already depend on sqlite-utils 4
        import sqlite_utils
    except ImportError:
        with step("Installing sqlite-utils"):
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

            source_bytes = await fetch_bytes(url)
            import_step = startStep(
                "Importing {} into table {}".format(file_name(url), bit)
            )
            if source_type == "csv":
                tracker = TypeTracker()
                csv_bytes = source_bytes
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
                json_bytes = source_bytes
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
                # pyarrow and pandas come from the Pyodide distribution
                await micropip.install("pyarrow")
                import pyarrow.parquet
                with open("parquet.parquet", "wb") as fp:
                    fp.write(source_bytes)
                df = pyarrow.parquet.read_table("parquet.parquet").to_pandas()
                # sqlite-utils can't store pandas Timestamps - use ISO strings
                for column in df.select_dtypes(include=["datetime", "datetimetz"]).columns:
                    df[column] = df[column].map(
                        lambda value: None if value != value else value.isoformat()
                    )
                db[bit].insert_all(df.to_dict(orient="records"), alter=True)
            del source_bytes
            finishStep(import_step)

starting_step = startStep("Starting Datasette")
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

from datasette.app import Datasette
import inspect

def config_from_pairs(pairs, config=None):
    """?s.key=value, the equivalent of datasette -s key value, using
    Datasette's own code for it: a bare setting name such as template_debug
    means settings.template_debug, any other key is a path into the
    configuration, and values that parse as JSON are treated as JSON. The
    pairs are merged into config, as they are on top of a -c file."""
    try:
        import click
        from datasette.cli import Setting
        from datasette.utils import pairs_to_nested_config, deep_dict_update
    except ImportError:
        raise ValueError(
            "?s.{}= requires Datasette 1.0a8 or later - try removing &ref=".format(pairs[0][0])
        )
    converted = []
    for key, value in pairs:
        try:
            converted.append(Setting().convert((key, value), None, None))
        except click.ClickException as ex:
            raise ValueError("?s.{}={}: {}".format(key, value, ex.format_message()))
    return deep_dict_update(config or {}, pairs_to_nested_config(converted))


if settings["config_pairs"]:
    config = config_from_pairs(settings["config_pairs"], config)

def register_datasette_lite_plugin():
    """Datasette Lite's own plugin, which adds "Manage plugins" to the menu
    at the top right of every page. The shell page (shell.js) opens a dialog
    when that link is clicked, and builds it with Datasette's DatasetteModal
    JavaScript API - new in Datasette 1.0a41, so the link is only added to a
    Datasette that ships modal.js. The link goes to the list of installed
    plugins, which is what it shows if the shell does not get the click.
    Returns True if the plugin was registered."""
    import pathlib
    import types
    import datasette
    from datasette import hookimpl
    from datasette.plugins import pm

    if not (pathlib.Path(datasette.__file__).parent / "static" / "modal.js").exists():
        return False
    # A module, as plugins are - Datasette lists them by their __name__
    plugin = types.ModuleType("datasette_lite")

    @hookimpl
    def menu_links(datasette):
        return [{
            "href": datasette.urls.path("/-/plugins") + "#manage-plugins",
            "label": "Manage plugins",
        }]

    plugin.menu_links = menu_links
    pm.register(plugin, name="datasette_lite")
    return True


register_datasette_lite_plugin()

datasette_kwargs = {}
if config is not None:
    if "config" not in inspect.signature(Datasette.__init__).parameters:
        raise ValueError(
            "?config= requires Datasette 1.0a8 or later - try removing &ref="
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
finishStep(starting_step)
`;
// PYTHON-END startup

const HANDLE_PY = String.raw`
import json
from urllib.parse import unquote
from js import Object
from pyodide.ffi import to_js


# Responses that are being streamed, so cancel_request() can find them
streams = {}


async def handle_request(
    request_id, method, raw_path, query, headers_json, body_buf, scheme, host, port,
    streaming, on_start, on_chunk,
):
    headers = json.loads(headers_json)
    body = b"" if body_buf is None else body_buf.to_py().tobytes()
    stream = None
    if streaming:
        stream = ResponseStream(
            lambda status, response_headers: on_start(status, json.dumps(response_headers)),
            lambda chunk: on_chunk(to_js(chunk)),
        )
        streams[request_id] = stream
    try:
        resp = await bridge.handle(
            method, unquote(raw_path), query, headers, body,
            scheme=scheme, host=host, port=int(port), raw_path=raw_path,
            stream=stream,
        )
    finally:
        streams.pop(request_id, None)
    return to_js(
        {
            "status": resp["status"],
            "headers": resp["headers"],
            "body": resp["body"],
            "streamed": bool(resp.get("streamed")),
        },
        dict_converter=Object.fromEntries,
    )


def cancel_request(request_id):
    stream = streams.get(request_id)
    if stream is not None:
        stream.disconnect()
`;

async function startDatasette(settings) {
  let toLoad = [];
  let sources = [];
  let needsDataDb = false;
  let shouldLoadDefaults = true;
  // Which version of Datasette to install? By default the most recent release
  // of any kind, alphas and betas included. ?ref=stable is the most recent
  // stable release, ?ref=1.0a11 (or any version number) is that exact release.
  // ?ref=pre is what the default used to be called, and still works.
  // Anything else - ?ref=main, another branch, a tag that is not a version
  // number, a commit SHA - is run from its source on GitHub.
  let datasetteToInstall = 'datasette';
  let datasetteSourceUrl = null;
  let pre = true;
  if (settings.ref == 'stable') {
    pre = false;
  } else if (settings.ref && settings.ref != 'pre') {
    if (isVersionNumber(settings.ref)) {
      datasetteToInstall = `datasette==${settings.ref}`;
      pre = false;
    } else if (isGitRef(settings.ref)) {
      // Development code needs the preview releases of plugins, as the
      // default does
      datasetteSourceUrl = `${GITHUB_ZIP_PROXY}/${DATASETTE_REPO}/${settings.ref}`;
    } else {
      throw new Error(
        `?ref=${settings.ref} is not a version number, branch, tag or commit`
      );
    }
  }
  // ?sqlite=3.54.1 - find the wheel for it while Pyodide loads. A value that
  // is not a version number fails here, before anything is downloaded.
  let sqliteWheelUrl = null;
  if (settings.sqlite) {
    if (!isSqliteVersion(settings.sqlite)) {
      throw sqliteVersionError(settings.sqlite);
    }
    sqliteWheelUrl = findSqliteWheelUrl(
      settings.sqlite, SQLITE_WHEELS_URL, PYODIDE_PYTHON_TAG, PYODIDE_PLATFORM_TAG
    );
  }
  // ?install= is something for micropip to install - the name of a package
  // on PyPI, usually - or a GitHub repository to run a plugin from the source
  // of. HEAD is the repository's default branch.
  const installs = (settings.installUrls || []).filter(Boolean).map(requirement => {
    if (isOtherGithubUrl(requirement)) {
      throw new Error(
        `?install=${requirement} is not the URL of a GitHub repository or of a wheel. ` +
        `To install a plugin from its repository use ?install=owner/repo, ` +
        `?install=owner/repo@ref or the URL of the repository, or of a branch, ` +
        `tag, commit or pull request in it`
      );
    }
    const source = githubSource(requirement);
    return {
      requirement,
      // What the loading screen calls it: owner/repo or owner/repo@ref
      repo: source && source.repo + (source.ref ? "@" + source.ref : ""),
      ref: source && source.ref,
      source_url: source ? `${GITHUB_ZIP_PROXY}/${source.repo}/${source.ref || "HEAD"}` : null,
    };
  });
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
    toLoad.push(["content.db", "https://datasette-io-files.s3.amazonaws.com/content.db"]);
  }
  // Start every download now, alongside Pyodide. None of them needs Python,
  // and waiting for them is most of what a first visit spends its time on.
  [
    ...toLoad.map(([name, url]) => url),
    datasetteSourceUrl,
    ...installs.map(install => install.source_url),
    ...sources.flatMap(([sourceType, urls]) => urls),
    settings.metadataUrl,
    settings.configUrl,
  ].forEach(prefetch);
  // "pyodide" is the step the loading screen starts out showing
  const loadingPyodide = (async () => {
    const { loadPyodide } = await import(PYODIDE_URL + "pyodide.mjs");
    return loadPyodide({
      indexURL: PYODIDE_URL,
      fullStdLib: true
    });
  })();
  // Together, so that a ?sqlite= with no wheel is reported straight away
  // rather than once Pyodide has loaded
  [self.pyodide, sqliteWheelUrl] = await Promise.all([loadingPyodide, sqliteWheelUrl]);
  finishStep("pyodide");
  // One call, so the packages download together. setuptools is for
  // pkg_resources. What Pyodide reports as it loads them goes to the console.
  const packagesStep = startStep("Loading micropip and setuptools");
  await pyodide.loadPackage(['micropip', 'setuptools'], {
    messageCallback: (line) => console.log({line}),
  });
  finishStep(packagesStep);
  // Values are passed as data, never interpolated into Python source
  pyodide.globals.set("settings_json", JSON.stringify({
    to_load: toLoad,
    sources,
    datasette_to_install: datasetteToInstall,
    datasette_source_url: datasetteSourceUrl,
    datasette_source_ref: datasetteSourceUrl ? settings.ref : null,
    pre,
    sqlite_version: sqliteWheelUrl ? settings.sqlite : null,
    sqlite_wheel_url: sqliteWheelUrl,
    installs,
    metadata_url: settings.metadataUrl || null,
    config_url: settings.configUrl || null,
    config_pairs: settings.configPairs || [],
    memory: !!settings.memory,
    root: !!settings.root,
    base_url: settings.baseUrl,
  }));
  await pyodide.runPythonAsync(BRIDGE_PY);
  await pyodide.runPythonAsync(STARTUP_PY);
  await pyodide.runPythonAsync(HANDLE_PY);
  self.pyHandleRequest = pyodide.globals.get("handle_request");
  self.pyCancelRequest = pyodide.globals.get("cancel_request");
}

// Answers one request. A response that Datasette sends in a single piece is
// returned whole. One sent in several pieces - server-sent events, a CSV
// export - is posted to the shell as it is produced, provided the request
// said it can take that (msg.stream): a "response-start" message, then
// "response-chunk" messages, with "response-end" posted by the caller.
// Returns {streamed: true} in that case, having called onStreamStart() first.
async function handleRequest(msg, onStreamStart) {
  const url = new URL(msg.url);
  const port = url.port
    ? parseInt(url.port, 10)
    : (url.protocol === "https:" ? 443 : 80);
  const onStart = (status, headersJson) => {
    onStreamStart && onStreamStart();
    self.postMessage({
      type: 'response-start', id: msg.id, status, headers: JSON.parse(headersJson)
    });
  };
  const onChunk = (chunk) => {
    // Copy the chunk out of the WASM heap so it can be transferred
    const copy = chunk.slice();
    self.postMessage({type: 'response-chunk', id: msg.id, chunk: copy.buffer}, [copy.buffer]);
  };
  const result = await self.pyHandleRequest(
    msg.id,
    msg.method,
    url.pathname,
    url.search.replace(/^\?/, ""),
    JSON.stringify(msg.headers || []),
    msg.body ? new Uint8Array(msg.body) : new Uint8Array(),
    url.protocol.replace(":", ""),
    url.hostname,
    port,
    !!msg.stream,
    onStart,
    onChunk,
  );
  if (result.streamed) {
    return {streamed: true};
  }
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
    // Set once the response has started to be streamed to the shell, after
    // which a failure can no longer be reported as a 500
    let streaming = false;
    try {
      await readyPromise;
      const response = await handleRequest(data, () => { streaming = true; });
      if (response.streamed) {
        self.postMessage({type: 'response-end', id: data.id});
      } else {
        self.postMessage({type: 'response', id: data.id, ...response}, [response.body]);
      }
    } catch (error) {
      const message = "Datasette Lite error: " + ((error && error.message) || error);
      if (streaming) {
        self.postMessage({type: 'response-end', id: data.id, error: message});
        return;
      }
      const body = new TextEncoder().encode(message).buffer;
      self.postMessage({
        type: 'response', id: data.id, status: 500,
        headers: [["content-type", "text/plain; charset=utf-8"]], body
      }, [body]);
    }
    return;
  }
  if (data.type == 'cancel') {
    // The browser stopped reading a streamed response
    self.pyCancelRequest && self.pyCancelRequest(data.id);
  }
};

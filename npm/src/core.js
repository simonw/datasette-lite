// core.js - starts Datasette inside Pyodide from the files bundled in this
// package. No DOM, no worker, no Node APIs: worker.js runs this in a browser
// Web Worker and node.js runs it directly in Node.

import { BRIDGE_PY, RUNTIME_PY, MANIFEST } from "./python.js";

export { MANIFEST };

const ARCHIVE_PATH = "/tmp/datasette-lite-site-packages.tar.xz";
const UNPACK_PY = `
import importlib, os, tarfile
with tarfile.open("${ARCHIVE_PATH}", "r:xz") as archive:
    archive.extractall("/", filter="fully_trusted")
os.remove("${ARCHIVE_PATH}")
importlib.invalidate_caches()
`;

const canonical = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

// "https://example.com/data/Trees.csv?x=1" -> "Trees"
function nameFromUrl(url, fallback) {
  const file = String(url || "").split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
  const name = decodeURIComponent(file).replace(/\.[^.]*$/, "").trim();
  return name || fallback;
}

function uniqueName(name, used) {
  let candidate = name;
  for (let suffix = 2; used.has(candidate); suffix++) {
    candidate = `${name}_${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function toBytes(value) {
  if (typeof value == "string") return new TextEncoder().encode(value);
  // Not subclasses: Pyodide does not know what to do with a Node Buffer
  if (value.constructor === Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected a string, ArrayBuffer or typed array");
}

/**
 * @param {object} env
 * @param {Function} env.loadPyodide  from pyodide/pyodide.mjs
 * @param {string} env.indexURL       where the bundled pyodide/ directory is
 * @param {Function} env.readUrl      async (url) => Uint8Array
 * @param {Function} [env.log]        called with one line per startup step
 * @param {object} options            see README: databases, csv, json, sql...
 */
export async function boot({ loadPyodide, indexURL, readUrl, prepare, log = () => {} }, options = {}) {
  const baseUrl = options.baseUrl || "/";
  if (!baseUrl.startsWith("/") || !baseUrl.endsWith("/")) {
    throw new Error('baseUrl must start and end with "/"');
  }

  // Start fetching the data while Python loads
  let inputCount = 0;
  const pendingFiles = [];
  function input(source, describe) {
    const path = `/tmp/datasette-lite-input-${inputCount++}`;
    let bytes;
    if (source.data != null) bytes = Promise.resolve(toBytes(source.data));
    else if (source.text != null) bytes = Promise.resolve(toBytes(source.text));
    else if (source.url) {
      log(`Loading ${source.url}`);
      bytes = readUrl(source.url);
    } else throw new Error(`${describe} needs a url, text or data`);
    // Not awaited until Pyodide is ready - don't let a failure go unhandled
    bytes.catch(() => {});
    pendingFiles.push({ path, bytes });
    return path;
  }
  const entry = (source) => (typeof source == "string" ? { url: source } : source);

  const databaseNames = new Set();
  const databases = (options.databases || []).map(entry).map((source) => {
    if (source.path) {
      // Already in the Pyodide file system (node.js mounts real directories)
      return { name: source.name, path: source.path, in_place: true };
    }
    return {
      name: uniqueName(source.name || nameFromUrl(source.url, "database"), databaseNames),
      path: input(source, "A database"),
    };
  });
  const imports = [];
  // SQL first, so CSV and JSON can be loaded into tables it creates
  for (const type of ["sql", "csv", "json"]) {
    for (const source of (options[type] || []).map(entry)) {
      imports.push({
        type,
        database: source.database || "data",
        table: source.table || nameFromUrl(source.url, "table"),
        path: input(source, `A ${type} source`),
      });
    }
  }
  const document = (value, name) => {
    if (!value) return null;
    if (typeof value == "string") return input({ url: value }, name);
    // Already read, by a page that could reach it when this worker cannot
    if (typeof value.__text == "string") return input({ text: value.__text }, name);
    return input({ text: JSON.stringify(value) }, name);
  };
  const metadata = document(options.metadata, "metadata");
  const config = document(options.config, "config");

  log(`Loading Python ${MANIFEST.python} (Pyodide ${MANIFEST.pyodide})`);
  const archive = readUrl(indexURL + MANIFEST.archive.file);
  archive.catch(() => {});
  const pyodide = await loadPyodide({ indexURL });
  // node.js uses this to mount real directories into the Pyodide file system
  if (prepare) databases.push(...((await prepare(pyodide)) || []));
  const packageLog = { messageCallback: (line) => line.startsWith("Loading ") && log(line) };

  // The base packages - Datasette and everything it needs - are one archive
  log(`Loading Datasette ${MANIFEST.datasette}`);
  if (MANIFEST.load.length) await pyodide.loadPackage(MANIFEST.load, packageLog);
  pyodide.FS.writeFile(ARCHIVE_PATH, await archive);
  pyodide.runPython(UNPACK_PY);
  for (const lib of MANIFEST.archive.dynlibs) {
    // What pyodide.loadPackage() does for a wheel that contains .so files
    await pyodide._api.loadDynlib(lib.path, lib.global, []);
  }

  // Plugins: from the bundle if they were built into it, otherwise from PyPI
  const bundled = [];
  const micropip = [];
  for (const requirement of options.install || []) {
    const name = canonical(requirement.split(/[=<>!~ \[;@]/)[0]);
    if (MANIFEST.wheels.includes(name)) bundled.push(name);
    else if (!MANIFEST.packages[name]) micropip.push(requirement);
  }
  if (bundled.length || micropip.length) {
    await pyodide.loadPackage([...bundled, ...(micropip.length ? ["micropip"] : [])], packageLog);
  }

  for (const file of pendingFiles) {
    pyodide.FS.writeFile(file.path, await file.bytes);
  }

  await pyodide.runPythonAsync(BRIDGE_PY);
  await pyodide.runPythonAsync(RUNTIME_PY);
  const settings = {
    base_url: baseUrl,
    databases,
    imports,
    metadata,
    config,
    micropip,
    pre: options.pre ?? /[a-z]/.test(MANIFEST.datasette),
    memory: !!options.memory || (!databases.length && !imports.length),
    root: !!options.root,
    settings: options.settings || {},
  };
  const start = pyodide.globals.get("start");
  await start(JSON.stringify(settings), log);
  start.destroy();
  const handleRequest = pyodide.globals.get("handle_request");
  const add = pyodide.globals.get("add");

  let added = 0;
  return {
    manifest: MANIFEST,
    pyodide,
    baseUrl,

    /** One HTTP request through Datasette's ASGI app */
    async request({ method = "GET", url, headers = [], body = null }) {
      const parsed = new URL(url, "http://localhost");
      const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol == "https:" ? 443 : 80;
      const result = await handleRequest(
        method,
        parsed.pathname,
        parsed.search.replace(/^\?/, ""),
        JSON.stringify(headers),
        body ? toBytes(body) : new Uint8Array(),
        parsed.protocol.replace(":", ""),
        parsed.hostname,
        port,
      );
      // Copy the body out of the WASM heap so it can be transferred
      const bytes = result.body ? result.body.slice() : new Uint8Array();
      return { status: result.status, headers: result.headers, body: bytes.buffer };
    },

    /**
     * Add data to the running Datasette.
     * {type: "database", name, data} or {type: "csv"|"json"|"sql", data|text, table, database}
     */
    async add(item) {
      const path = `/tmp/datasette-lite-added-${added++}`;
      const bytes = item.url ? await readUrl(item.url) : toBytes(item.data ?? item.text);
      pyodide.FS.writeFile(path, bytes);
      const name = item.name || nameFromUrl(item.url, item.type == "database" ? "database" : "table");
      const request =
        item.type == "database"
          ? { type: "database", name, path }
          : { type: item.type, database: item.database || "data", table: item.table || name, path };
      return JSON.parse(await add(JSON.stringify(request)));
    },

    /** The bytes of a database as it is now, including any changes made to it */
    readDatabase(name) {
      return pyodide.FS.readFile(`${name}.db`);
    },
  };
}

/**
 * Run SQL through Datasette's JSON API, returning a list of objects.
 * fetchFn is fetch() against Datasette, with paths relative to its root.
 */
export async function queryRows(fetchFn, sql, { database, params = {} } = {}) {
  if (!database) {
    const body = await (await fetchFn("/-/databases.json")).json();
    const databases = Array.isArray(body) ? body : body.databases || [];
    const first = databases.find((db) => db.name != "_internal" && db.name != "_memory") || databases[0];
    if (!first) throw new Error("There are no databases to query");
    database = first.name;
  }
  const query = new URLSearchParams({ sql, _shape: "array", ...params });
  let response = await fetchFn(`/${encodeURIComponent(database)}/-/query.json?${query}`);
  if (response.status == 404) {
    // Datasette 0.x
    response = await fetchFn(`/${encodeURIComponent(database)}.json?${query}`);
  }
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body && body.error) || `HTTP ${response.status}`);
  }
  return body;
}

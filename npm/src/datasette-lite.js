// datasette-lite.js - Datasette in the browser, from files bundled in this
// package. Exports the DatasetteLite class (run Datasette, query it, fetch from
// it) and defines the <datasette-lite> element (show its UI on a page).
//
// Everything is loaded relative to this file: worker.js, sw.js and pyodide/
// must be served from the same directory.

const ASSETS = new URL("./", import.meta.url);
// Version of the messages exchanged with sw.js - see PROTOCOL there
const PROTOCOL = 1;
const NULL_BODY = new Set([101, 204, 205, 304]);

const DATABASE_EXTENSIONS = ["db", "sqlite", "sqlite3"];
const IMPORT_EXTENSIONS = { csv: "csv", json: "json", ndjson: "json", jsonl: "json", sql: "sql" };

function randomSession() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- The service worker ------------------------------------------------------
//
// sw.js answers every request under <assets>app/<session>/ by asking the page
// that owns that session. One listener per page answers for every instance on
// it: sw.js takes the first reply it gets from a page as that page's answer.

const sessions = new Map();
let listening = false;

function listenToServiceWorker() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    const port = event.ports[0];
    if (data.type == "datasette-lite-owner") {
      port.postMessage({ owner: sessions.has(data.session), protocol: PROTOCOL });
    } else if (data.type == "datasette-lite-request" && sessions.has(data.session)) {
      sessions.get(data.session)._request(data.request).then((response) => {
        port.postMessage(response, response.body ? [response.body] : []);
      });
    }
  });
  navigator.serviceWorker.startMessages();
}

const registrations = new Map();

function registerServiceWorker(assets) {
  if (!registrations.has(assets.href)) {
    registrations.set(assets.href, (async () => {
      if (!("serviceWorker" in navigator)) {
        throw new Error(
          "Showing Datasette needs a browser with service worker support. " +
          "Service workers are unavailable in some private browsing modes.",
        );
      }
      if (assets.origin != location.origin) {
        throw new Error(
          `Showing Datasette needs ${assets.href} to be on the same origin as this page ` +
          "(a service worker cannot be loaded from another origin). Copy the package's " +
          "dist/ directory to your own site. DatasetteLite's fetch() and query() work cross-origin.",
        );
      }
      listenToServiceWorker();
      const registration = await navigator.serviceWorker.register(new URL("sw.js", assets), {
        scope: assets.pathname,
      });
      // Not navigator.serviceWorker.ready: that waits for a worker that
      // controls *this* page, which is usually outside the scope
      const worker = registration.active || registration.waiting || registration.installing;
      if (worker.state != "activated") {
        await new Promise((resolve, reject) => {
          worker.addEventListener("statechange", () => {
            if (worker.state == "activated") resolve();
            if (worker.state == "redundant") reject(new Error("The service worker failed to install"));
          });
        });
      }
    })());
  }
  return registrations.get(assets.href);
}

// --- DatasetteLite -----------------------------------------------------------

function createWorker(assets) {
  const url = new URL("worker.js", assets);
  if (url.origin == location.origin) {
    return new Worker(url, { type: "module" });
  }
  // A worker script has to be same-origin, but a same-origin blob can import
  // a module from anywhere that sends CORS headers - a CDN, say
  const source = `import ${JSON.stringify(url.href)};`;
  return new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), {
    type: "module",
  });
}

async function normalizeSource(source) {
  if (typeof source == "string") {
    return { url: new URL(source, document.baseURI).href };
  }
  if (source instanceof Blob) {
    source = { file: source };
  }
  const { file, ...rest } = source;
  if (file) {
    rest.data = await file.arrayBuffer();
    if (file.name && !rest.url) {
      // Only used to name the database or table after the file
      rest.url = file.name;
      rest.named = true;
    }
  } else if (rest.url) {
    rest.url = new URL(rest.url, document.baseURI).href;
  }
  return rest;
}

export class DatasetteLite extends EventTarget {
  /** Start Datasette and wait until it is ready */
  static async start(options) {
    const datasette = new DatasetteLite(options);
    await datasette.ready;
    return datasette;
  }

  /**
   * @param {object} [options]
   * @param {Array} [options.databases]  URLs, Files or {url|file|data, name}
   * @param {Array} [options.csv]        URLs, Files or {url|file|text|data, table, database}
   * @param {Array} [options.json]       as csv
   * @param {Array} [options.sql]        as csv - scripts to run, before csv and json are imported
   * @param {string|object} [options.metadata]  URL of a JSON/YAML file, or an object
   * @param {string|object} [options.config]    datasette.yaml, the same way
   * @param {string[]} [options.install] plugins: bundled ones load offline, others come from PyPI
   * @param {object} [options.settings]  Datasette settings, e.g. {default_page_size: 20}
   * @param {boolean} [options.root]     sign in as root
   * @param {boolean} [options.memory]   add the _memory database
   * @param {boolean} [options.ui]       set up the service worker so appUrl() can be shown in an iframe
   * @param {string|URL} [options.assets] where the package's dist/ directory is served
   */
  constructor(options = {}) {
    super();
    this.assets = new URL(options.assets || ASSETS, document.baseURI);
    if (!this.assets.pathname.endsWith("/")) this.assets.pathname += "/";
    this.session = randomSession();
    this.ui = !!options.ui;
    // Datasette's base_url. With a UI every URL it generates has to stay
    // inside the service worker's scope.
    this.baseUrl = this.ui ? `${this.assets.pathname}app/${this.session}/` : "/";
    this.manifest = null;
    this._pending = new Map();
    this._nextId = 1;
    this._worker = createWorker(this.assets);
    this._worker.onmessage = (event) => {
      const data = event.data;
      if (data.log) {
        this.dispatchEvent(new CustomEvent("log", { detail: data.log }));
        return;
      }
      const call = this._pending.get(data.id);
      this._pending.delete(data.id);
      if (!call) return;
      if ("error" in data) call.reject(new Error(data.error));
      else call.resolve(data.result);
    };
    this._worker.onerror = (event) => {
      // If the worker dies nothing will ever answer the calls waiting on it
      const reason = (event && event.message) || "worker.js could not be loaded or run";
      this._failAll(new Error("The Datasette worker failed: " + reason));
    };
    this.ready = this._start(options);
    // Reported through await datasette.ready, or the element's error screen
    this.ready.catch(() => {});
  }

  async _start(options) {
    const sources = (list) => Promise.all((list || []).map(normalizeSource));
    const document_ = (value) =>
      typeof value == "string" ? new URL(value, document.baseURI).href : value || null;
    const [databases, csv, json, sql] = await Promise.all([
      sources(options.databases), sources(options.csv), sources(options.json), sources(options.sql),
    ]);
    const start = this._call("start", [{
      baseUrl: this.baseUrl,
      databases, csv, json, sql,
      metadata: document_(options.metadata),
      config: document_(options.config),
      install: options.install || [],
      settings: options.settings || {},
      memory: !!options.memory,
      root: !!options.root,
      pre: options.pre,
    }]);
    if (this.ui) {
      sessions.set(this.session, this);
      await Promise.all([registerServiceWorker(this.assets), start]);
    }
    this.manifest = await start;
    return this;
  }

  _call(method, args, transfer = []) {
    return new Promise((resolve, reject) => {
      if (!this._worker) {
        reject(new Error("This Datasette has been stopped"));
        return;
      }
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, method, args }, transfer);
    });
  }

  _failAll(error) {
    for (const call of this._pending.values()) call.reject(error);
    this._pending.clear();
  }

  // One request, as sw.js sends it: {method, url, headers, body}. Always
  // resolves to {status, headers, body} - sw.js is waiting for an answer.
  async _request(request) {
    try {
      await this.ready;
      return await this._call("request", [request], request.body ? [request.body] : []);
    } catch (error) {
      return {
        status: 500,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        body: new TextEncoder().encode("Datasette Lite error: " + error.message).buffer,
      };
    }
  }

  /** The URL that shows a Datasette path, for an iframe. Needs {ui: true}. */
  appUrl(path = "/") {
    if (!this.ui) throw new Error("appUrl() needs the ui option");
    return new URL(this.baseUrl.slice(0, -1) + (path.startsWith("/") ? path : "/" + path), this.assets).href;
  }

  /**
   * fetch() against Datasette, without the network or the service worker:
   * datasette.fetch("/fixtures/facetable.json?_size=5")
   */
  async fetch(path, init = {}) {
    await this.ready;
    const url = new URL(this.baseUrl.slice(0, -1) + (path.startsWith("/") ? path : "/" + path), location.origin);
    const request = new Request(url, init);
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const body = hasBody ? await request.arrayBuffer() : null;
    const response = await this._call(
      "request",
      [{ method: request.method, url: request.url, headers: [...request.headers.entries()], body }],
      body ? [body] : [],
    );
    return new Response(NULL_BODY.has(response.status) ? null : response.body, {
      status: response.status,
      headers: response.headers,
    });
  }

  /** Run SQL, returning a list of objects. options: {database, params} */
  async query(sql, { database, params = {} } = {}) {
    if (!database) {
      const body = await (await this.fetch("/-/databases.json")).json();
      const databases = Array.isArray(body) ? body : body.databases || [];
      const first = databases.find((db) => !db.name.startsWith("_")) || databases[0];
      if (!first) throw new Error("There are no databases to query");
      database = first.name;
    }
    const query = new URLSearchParams({ sql, _shape: "array", ...params });
    let response = await this.fetch(`/${encodeURIComponent(database)}/-/query.json?${query}`);
    if (response.status == 404) {
      // Datasette 0.x
      response = await this.fetch(`/${encodeURIComponent(database)}.json?${query}`);
    }
    const body = await response.json();
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  }

  /**
   * Add data while Datasette is running. Resolves to {database, table}.
   * {type: "database", name, url|file|data}
   * {type: "csv"|"json"|"sql", url|file|text|data, table, database}
   */
  async add(item) {
    await this.ready;
    const source = await normalizeSource(item);
    if (source.named) {
      // Read from the File already - the url was only there for its name
      source.name = source.name || (source.type == "database" ? stem(source.url) : undefined);
      source.table = source.table || stem(source.url);
      delete source.url;
    }
    return this._call("add", [source], source.data instanceof ArrayBuffer ? [source.data] : []);
  }

  /** Add a File the way its extension suggests: .db, .sqlite, .csv, .json, .sql */
  addFile(file, options = {}) {
    const extension = file.name.split(".").pop().toLowerCase();
    const type = DATABASE_EXTENSIONS.includes(extension) ? "database" : IMPORT_EXTENSIONS[extension];
    if (!type) {
      return Promise.reject(new Error(`Don't know how to load ${file.name}`));
    }
    return this.add({ type, file, ...options });
  }

  /** A database as it is now - including changes made in this session */
  async readDatabase(name) {
    await this.ready;
    return new Uint8Array(await this._call("readDatabase", [name]));
  }

  /** Stop the worker and free its memory */
  terminate() {
    sessions.delete(this.session);
    if (this._worker) this._worker.terminate();
    this._worker = null;
    this._failAll(new Error("This Datasette has been stopped"));
  }
}

function stem(name) {
  return name.split("/").pop().replace(/\.[^.]*$/, "") || "data";
}

// --- <datasette-lite> --------------------------------------------------------

const STYLE = `
:host {
  display: block;
  position: relative;
  box-sizing: border-box;
  height: 36rem;
  overflow: hidden;
  border: 1px solid #d8e6f5;
  background-color: #F8FAFB;
  color: #111A35;
  font-family: "Helvetica Neue", sans-serif;
  font-size: 1rem;
  line-height: 1.5;
}
:host([hidden]) { display: none; }
iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
[hidden] { display: none !important; }
/* The loading screen borrows Datasette's own header and colours, so the
   page that replaces it looks like the same page filling in */
.header {
  box-sizing: border-box;
  min-height: 2.6rem;
  padding: 0.6rem 1rem 0.5rem 1rem;
  background: #276890 linear-gradient(180deg, rgba(96,144,173,1) 0%, rgba(39,104,144,1) 50%);
  color: rgba(255,255,244,0.9);
}
.body { padding: 0 1rem 1rem 1rem; }
h2 { margin: 1rem 0 0.75rem 0; font-size: 1.5rem; line-height: 1.2; }
ol {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 14rem;
  overflow-y: auto;
  font-size: 0.9rem;
}
li {
  position: relative;
  padding: 0.15rem 0 0.15rem 1.6rem;
  color: #5c6b7a;
  overflow-wrap: anywhere;
}
/* Finished steps get a tick, the step in progress a spinner */
li::before {
  content: "";
  position: absolute;
  left: 0.2rem;
  top: 0.45rem;
  width: 0.35rem;
  height: 0.65rem;
  border: solid #54AC8E;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
li:last-child { color: #111A35; font-weight: 600; }
li:last-child::before {
  left: 0;
  top: 0.4rem;
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid #c5d6e2;
  border-top-color: #276890;
  border-radius: 50%;
  transform: none;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  li:last-child::before { animation-duration: 4s; }
}
.note { margin: 1.25rem 0 0 0; font-size: 0.85rem; color: #5c6b7a; }
.error { margin-top: 1rem; padding: 1rem; background-color: rgba(208,2,27,0.3); }
.error h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; }
.error p { margin: 0; overflow-wrap: anywhere; }
.error details { margin-top: 0.75rem; font-size: 0.85rem; }
.error pre { margin: 0.5rem 0 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.drop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 3px dashed #276890;
  background: rgba(248,250,251,0.92);
  color: #276890;
  font-size: 1.25rem;
  font-weight: 600;
  pointer-events: none;
}
`;

const TEMPLATE = `
<style>${STYLE}</style>
<div class="loading" part="loading">
  <div class="header">Datasette</div>
  <div class="body">
    <h2>Loading Datasette</h2>
    <ol role="log" aria-label="Startup progress"></ol>
    <p class="note">Datasette is starting up inside your browser, using Python compiled to WebAssembly.</p>
  </div>
</div>
<div class="body failed" part="error" hidden></div>
<iframe part="frame" title="Datasette" hidden></iframe>
<div class="drop" part="drop" hidden>Drop to load into Datasette</div>
`;

const words = (value) => (value || "").split(/\s+/).filter(Boolean);

export class DatasetteLiteElement extends HTMLElement {
  static observedAttributes = ["path"];

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = TEMPLATE;
    this._frame = this.shadowRoot.querySelector("iframe");
    this._path = null;
    /** The DatasetteLite instance, once the element is connected */
    this.datasette = null;
    this._frame.addEventListener("load", () => this._onFrameLoad());
    this.addEventListener("dragover", (event) => this._onDragOver(event));
    this.addEventListener("dragleave", () => this._showDrop(false));
    this.addEventListener("drop", (event) => this._onDrop(event));
    window.addEventListener("hashchange", () => {
      if (this.hasAttribute("hash") && this.datasette && this._path !== hashPath()) {
        this.navigate(hashPath(), { replace: true });
      }
    });
  }

  connectedCallback() {
    if (this.datasette) return;
    const options = this._options();
    this.datasette = new DatasetteLite({ ...options, ui: true });
    this.datasette.addEventListener("log", (event) => this._log(event.detail));
    /** Resolves to this element when Datasette is showing */
    this.ready = this.datasette.ready.then(() => {
      const path = (this.hasAttribute("hash") && location.hash.length > 1 && hashPath()) ||
        this.getAttribute("path") || "/";
      this._frame.hidden = false;
      this.shadowRoot.querySelector(".loading").hidden = true;
      this.navigate(path, { replace: true });
      this.dispatchEvent(new CustomEvent("datasette-ready", { detail: this.datasette.manifest }));
      return this;
    });
    this.ready.catch((error) => {
      this._showError(error.message);
      this.dispatchEvent(new CustomEvent("datasette-error", { detail: error }));
    });
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name == "path" && this._frame && !this._frame.hidden && value != null && value !== this._path) {
      this.navigate(value);
    }
  }

  // Attributes, and data written into the page as <script> children
  _options() {
    const options = {
      databases: words(this.getAttribute("src")),
      csv: words(this.getAttribute("csv")),
      json: words(this.getAttribute("json")),
      sql: words(this.getAttribute("sql")),
      install: words(this.getAttribute("install")),
      metadata: this.getAttribute("metadata"),
      config: this.getAttribute("config"),
      memory: this.hasAttribute("memory"),
      root: this.hasAttribute("root"),
      assets: this.getAttribute("assets") || undefined,
    };
    for (const script of this.querySelectorAll(":scope > script")) {
      const type = (script.getAttribute("type") || "").toLowerCase();
      const text = script.textContent.trim();
      const inline = { text };
      if (script.dataset.table) inline.table = script.dataset.table;
      if (script.dataset.database) inline.database = script.dataset.database;
      if (type == "text/csv") options.csv.push(inline);
      else if (type == "application/sql") options.sql.push(inline);
      else if (type == "application/json" && "metadata" in script.dataset) options.metadata = JSON.parse(text);
      else if (type == "application/json" && "config" in script.dataset) options.config = JSON.parse(text);
      else if (type == "application/json" && "settings" in script.dataset) options.settings = JSON.parse(text);
      else if (type == "application/json") options.json.push(inline);
    }
    return options;
  }

  /** The Datasette path being shown, e.g. "/fixtures/facetable?_facet=state" */
  get path() {
    return this._path;
  }

  /** Show a Datasette path */
  navigate(path, { replace = false } = {}) {
    const url = this.datasette.appUrl(path);
    if (replace && this._frame.contentWindow) {
      this._frame.contentWindow.location.replace(url);
    } else {
      this._frame.src = url;
    }
  }

  fetch(path, init) {
    return this.datasette.fetch(path, init);
  }

  query(sql, options) {
    return this.datasette.query(sql, options);
  }

  /** Load a File (a database, CSV, JSON or SQL) and show it */
  async addFile(file, options) {
    const added = await this.datasette.addFile(file, options);
    this.navigate("/" + [added.database, added.table].filter(Boolean).map(encodeURIComponent).join("/"));
    return added;
  }

  readDatabase(name) {
    return this.datasette.readDatabase(name);
  }

  disconnectedCallback() {
    // Moving an element disconnects and reconnects it in the same task -
    // only stop Datasette if it has really been removed
    queueMicrotask(() => {
      if (!this.isConnected && this.datasette) {
        this.datasette.terminate();
        this.datasette = null;
      }
    });
  }

  _log(line) {
    const steps = this.shadowRoot.querySelector("ol");
    const step = document.createElement("li");
    step.textContent = line;
    steps.appendChild(step);
    steps.scrollTop = steps.scrollHeight;
    this.dispatchEvent(new CustomEvent("datasette-log", { detail: line }));
  }

  _showError(message) {
    // An error raised by Python arrives as a whole traceback. Its last line
    // says what went wrong, so lead with that and keep the rest a click away.
    const lines = message.trim().split("\n");
    const box = this.shadowRoot.querySelector(".failed");
    box.innerHTML = '<div class="error" role="alert"><h2>Error</h2><p></p></div>';
    box.querySelector("p").textContent = lines[lines.length - 1];
    if (lines.length > 1) {
      const details = document.createElement("details");
      details.innerHTML = "<summary>Details</summary><pre></pre>";
      details.querySelector("pre").textContent = message;
      box.firstChild.appendChild(details);
    }
    box.hidden = false;
    this._frame.hidden = true;
    this.shadowRoot.querySelector(".loading").hidden = true;
  }

  _onFrameLoad() {
    let doc, location_;
    try {
      doc = this._frame.contentDocument;
      location_ = this._frame.contentWindow.location;
      if (location_.href == "about:blank") return;
    } catch (error) {
      // The iframe is on another origin (a plugin redirected to an OAuth
      // provider, say) - reading its location throws a SecurityError
      return;
    }
    const root = this.datasette.baseUrl.slice(0, -1);
    if (location_.origin != location.origin || !(location_.pathname + "/").startsWith(root + "/")) {
      return;
    }
    this._path = (location_.pathname.slice(root.length) || "/") + location_.search;
    if (this.hasAttribute("hash") && location.hash != "#" + this._path) {
      // replaceState: the iframe navigation already created a history entry
      history.replaceState(null, "", "#" + this._path);
    }
    if (doc && doc.contentType == "text/html" && doc.body) {
      this._enhance(doc);
    }
    this.dispatchEvent(new CustomEvent("datasette-navigate", {
      detail: { path: this._path, title: (doc && doc.title) || "" },
    }));
  }

  // Called for every HTML page Datasette renders in the iframe
  _enhance(doc) {
    // Links to other sites open in a new window: they would not load inside
    // the iframe, and link targets come from arbitrary data
    doc.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const link = event.target.closest && event.target.closest("a[href]");
      const target = link && (link.getAttribute("target") || "").toLowerCase();
      if (!link || (target && target != "_self")) return;
      let url;
      try {
        url = new URL(link.href);
      } catch (error) {
        return;
      }
      if (/^https?:$/.test(url.protocol) && url.origin != location.origin) {
        event.preventDefault();
        window.open(url.href, "_blank", "noopener");
      }
    });
    // Files dragged over the iframe never reach the element itself
    doc.addEventListener("dragover", (event) => this._onDragOver(event));
    doc.addEventListener("dragleave", () => this._showDrop(false));
    doc.addEventListener("drop", (event) => this._onDrop(event));
    if (this.hasAttribute("autoheight")) {
      const resize = () => {
        this.style.height = doc.documentElement.scrollHeight + 2 + "px";
      };
      new ResizeObserver(resize).observe(doc.documentElement);
      resize();
    }
  }

  _showDrop(show) {
    this.shadowRoot.querySelector(".drop").hidden = !show;
  }

  _onDragOver(event) {
    if (!this.hasAttribute("drop") || !event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) {
      return;
    }
    event.preventDefault();
    this._showDrop(true);
  }

  async _onDrop(event) {
    if (!this.hasAttribute("drop") || !event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    this._showDrop(false);
    try {
      for (const file of event.dataTransfer.files) {
        await this.addFile(file);
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("datasette-error", { detail: error }));
      window.alert(error.message);
    }
  }
}

function hashPath() {
  const path = location.hash.replace(/^#/, "") || "/";
  return path.startsWith("/") ? path : "/" + path;
}

if (!customElements.get("datasette-lite")) {
  customElements.define("datasette-lite", DatasetteLiteElement);
}

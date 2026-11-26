// shell.js - the Datasette Lite "shell" page logic.
//
// Datasette Lite runs the real Datasette ASGI application in Pyodide, in a Web
// Worker owned by this page. Datasette's pages are displayed in an <iframe>
// pointed at <scope>/app/<session>/... - URLs that don't exist on the server:
// the service worker (sw.js) intercepts every request under that prefix and
// this page relays it to the Pyodide worker, which answers it via ASGI.
//
// The iframe keeps the Pyodide worker alive across navigations. The iframe's
// location is mirrored into this page's #fragment, so URLs such as
//   https://lite.datasette.io/?url=...#/fixtures/facetable?_facet=state
// keep working, are shareable, and the back button works.

const SCOPE_PATH = new URL("./", location.href).pathname;
const SESSION = (
  (self.crypto && crypto.randomUUID && crypto.randomUUID()) ||
  String(Math.random()).slice(2) + String(Date.now())
).replace(/-/g, "").slice(0, 12);
// Version of the messages exchanged with sw.js - see PROTOCOL there. The
// service worker is replaced as soon as a new release is deployed, while this
// page keeps running the release it was loaded from, so this page tells the
// service worker which protocol it speaks. Bump both together.
const PROTOCOL = 1;
// Datasette's base_url: every URL Datasette generates starts with this.
const APP_BASE = SCOPE_PATH + "app/" + SESSION + "/";
const APP_ROOT = APP_BASE.slice(0, -1);

const githubUrl = /^https:\/\/github.com\/(.*)\/(.*)\/blob\/(.*)(\?raw=true)?$/;
const gistUrl = /^https:\/\/gist.github.com\/(.*)\/(.*)$/;

function fixUrl(url) {
  if (!url) {
    return url;
  }
  const githubMatch = githubUrl.exec(url);
  if (githubMatch) {
    return `https://raw.githubusercontent.com/${githubMatch[1]}/${githubMatch[2]}/${githubMatch[3]}`;
  }
  const gistMatch = gistUrl.exec(url);
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
  }
  return url;
}

const urlParams = new URLSearchParams(location.search);
// What the worker is started with. Replaced when Datasette is restarted with
// different plugins - see restartWithInstalls()
let startup = {
  type: "startup",
  ref: urlParams.get("ref"),
  sqlite: urlParams.get("sqlite"),
  sqliteUrls: urlParams.getAll("url").map(fixUrl),
  memory: !!urlParams.get("memory"),
  metadataUrl: fixUrl(urlParams.get("metadata")),
  configUrl: fixUrl(urlParams.get("config")),
  csvUrls: urlParams.getAll("csv").map(fixUrl),
  sqlUrls: urlParams.getAll("sql").map(fixUrl),
  jsonUrls: urlParams.getAll("json").map(fixUrl),
  parquetUrls: urlParams.getAll("parquet").map(fixUrl),
  installUrls: urlParams.getAll("install"),
  // ?s.key=value, any number of times: the same as datasette -s key value
  configPairs: [...urlParams].filter(([key]) => key.startsWith("s.") && key.length > 2)
    .map(([key, value]) => [key.slice(2), value]),
  root: !!urlParams.get("root"),
  baseUrl: APP_BASE,
};

const useAnalytics = (location.hostname == "lite.datasette.io") && (urlParams.get("analytics") != "off");
useAnalytics && plausible("pageview");

const frame = document.getElementById("datasette");
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- The loading screen ----------------------------------------------------------

// The worker reports each step of starting up - see "Startup progress" in
// webworker.js. Several are in progress at once: each is listed with a
// spinner until the worker says it is done, then a tick. Next to it is how
// long it has taken and, for a download, how much has arrived.
const steps = new Map(); // id -> {item, label, detail, started, finished, bytes}

function formatBytes(bytes) {
  if (bytes < 1000) {
    return bytes + " B";
  }
  if (bytes < 1000 * 1000) {
    return Math.round(bytes / 1000) + " kB";
  }
  return (bytes / (1000 * 1000)).toFixed(1) + " MB";
}

function showStepDetail(step) {
  const seconds = ((step.finished || performance.now()) - step.started) / 1000;
  const parts = [];
  if (step.bytes != null) {
    parts.push(formatBytes(step.bytes));
  }
  if (step.finished) {
    // Not worth saying of a step that took no time at all
    if (seconds >= 0.05) {
      parts.push(seconds.toFixed(1) + " s");
    }
  } else if (seconds >= 1) {
    parts.push(Math.floor(seconds) + " s");
  }
  const text = parts.join(" \u00b7 ");
  if (step.detail.textContent != text) {
    step.detail.textContent = text;
  }
}

// Show a new step, or change one already shown: {id, label, bytes, done}
function showStep({id, label, bytes, done}) {
  let step = steps.get(id);
  if (!step) {
    const list = document.getElementById("loading-logs");
    const item = document.createElement("li");
    step = {
      item,
      label: document.createElement("span"),
      detail: document.createElement("span"),
      started: performance.now(),
    };
    step.label.className = "step-label";
    step.detail.className = "step-detail";
    // The times tick: not something for a screen reader to read out
    step.detail.setAttribute("aria-hidden", "true");
    item.append(step.label, step.detail);
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    steps.set(id, step);
  }
  if (label != null) {
    step.label.textContent = label;
  }
  if (bytes != null) {
    step.bytes = bytes;
  }
  if (done && !step.finished) {
    step.finished = performance.now();
    step.item.classList.add("done");
  }
  showStepDetail(step);
}

// The step the page is served showing, which the worker finishes as "pyodide"
{
  const item = document.querySelector("#loading-logs li");
  steps.set("pyodide", {
    item,
    label: item.querySelector(".step-label"),
    detail: item.querySelector(".step-detail"),
    started: performance.now(),
  });
}

// Keeps the time shown against each step in progress up to date
let stepTimer = null;

function startStepTimer() {
  stopStepTimer();
  stepTimer = setInterval(() => {
    for (const step of steps.values()) {
      step.finished || showStepDetail(step);
    }
  }, 250);
}

function stopStepTimer() {
  clearInterval(stepTimer);
  stepTimer = null;
}

startStepTimer();

// The loading screen is shown again, in place of Datasette, while one of the
// "Load CSV" etc buttons loads a file into it - see loadIntoDatasette()
function showLoadingScreen(heading) {
  steps.clear();
  document.getElementById("loading-logs").replaceChildren();
  document.querySelector("#loading-indicator h1").textContent = heading;
  document.body.classList.add("loading-more");
  document.body.classList.remove("ready");
  startStepTimer();
}

function hideLoadingScreen() {
  document.body.classList.add("ready");
  document.body.classList.remove("loading-more");
  stopStepTimer();
}

function showError(message) {
  stopStepTimer();
  document.getElementById("loading-indicator").style.display = "none";
  // An error raised by Python arrives as a whole traceback. Its last line says
  // what went wrong, so lead with that and keep the rest a click away.
  const lines = message.trim().split("\n");
  const details = lines.length > 1
    ? `<details><summary>Details</summary><pre>${escapeHtml(message)}</pre></details>`
    : "";
  document.getElementById("output").innerHTML =
    `<div class="error" role="alert"><h2>Error</h2><p>${escapeHtml(lines[lines.length - 1])}</p>${details}</div>`;
}

// --- The Pyodide worker ------------------------------------------------------

// The worker that answers requests. A module worker: Pyodide is loaded with
// import(), see webworker.js. Replaced by restartWithInstalls().
let datasetteWorker = null;
// Requests the worker has not finished answering: id -> {port, streaming}.
// port is the MessagePort the service worker is waiting on for the reply.
const pending = new Map();
let nextId = 1;
// Files the worker has been asked to load into the running Datasette, by
// loadInWorker(): id -> {resolve, reject}
const loading = new Map();

// Start a worker, and Datasette in it. onStep is called with each step of
// starting up. Returns {worker, ready} - ready is a promise that resolves
// once Datasette can answer requests, and rejects if it fails to start.
function startWorker(message, onStep) {
  const worker = new Worker("webworker.js", {type: "module"});
  // Replaced by changePluginsInPlace(), for the steps of doing that
  worker.onStep = onStep;
  let failStartup;
  const ready = new Promise((resolve, reject) => {
    failStartup = reject;
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type == "step") {
        worker.onStep(data);
      } else if (data.type == "plugins-changed") {
        worker.onPluginsChanged && worker.onPluginsChanged(data);
      } else if (data.type == "loaded") {
        const load = loading.get(data.id);
        loading.delete(data.id);
        if (load && data.error != null) {
          load.reject(new Error(data.error));
        } else if (load) {
          load.resolve(data);
        }
      } else if (data.type == "ready") {
        resolve();
      } else if (data.type == "error") {
        reject(new Error(data.error));
      } else {
        onWorkerResponse(data);
      }
    };
  });
  // If the worker dies (out of memory, say) nothing will ever answer the
  // requests waiting on it, so fail them rather than leave them hanging. A
  // worker that is still starting up behind a running one has no requests.
  worker.onerror = (event) => {
    // The event has no message when the worker script itself could not be loaded
    const reason =
      (event && event.message) || "the worker script webworker.js could not be loaded or run";
    // While Datasette is still starting nothing is pending: this is a startup
    // failure - Pyodide could not be downloaded, say - so report it instead
    // of leaving the page on "Loading...". A no-op once the worker is ready.
    failStartup(new Error("The Datasette worker failed to start: " + reason));
    worker.onPluginsChanged && worker.onPluginsChanged({error: reason});
    if (worker === datasetteWorker) {
      failPending("the Datasette worker failed: " + reason);
    }
  };
  worker.onmessageerror = () => {
    if (worker === datasetteWorker) {
      failPending("a message from the Datasette worker could not be read");
    }
  };
  worker.postMessage(message);
  return {worker, ready};
}

// A response is either a single "response" message, or - when Datasette sends
// it in several pieces, as it does for server-sent events - "response-start",
// any number of "response-chunk" and then "response-end". Each is passed
// straight on to the service worker, so the page sees a streamed response as
// it is produced.
function onWorkerResponse(data) {
  const request = pending.get(data.id);
  if (!request) {
    return;
  }
  if (data.type == "response") {
    pending.delete(data.id);
    request.port.postMessage(
      {status: data.status, headers: data.headers, body: data.body},
      data.body ? [data.body] : [],
    );
  } else if (data.type == "response-start") {
    request.streaming = true;
    request.port.postMessage({status: data.status, headers: data.headers, stream: true});
  } else if (data.type == "response-chunk") {
    request.port.postMessage({chunk: data.chunk}, [data.chunk]);
  } else if (data.type == "response-end") {
    pending.delete(data.id);
    request.port.postMessage(data.error ? {error: data.error} : {done: true});
  }
}

// Fail every request that is waiting for an answer
function failPending(reason) {
  const message = "Datasette Lite error: " + reason;
  for (const request of pending.values()) {
    if (request.streaming) {
      // The status and headers have already gone: break off the response
      request.port.postMessage({error: message});
      continue;
    }
    // An ArrayBuffer like any other response body - one per request, since
    // it is transferred to the service worker
    const body = new TextEncoder().encode(message).buffer;
    request.port.postMessage(
      {status: 500, headers: [["content-type", "text/plain; charset=utf-8"]], body},
      [body],
    );
  }
  pending.clear();
  for (const load of loading.values()) {
    load.reject(new Error(reason));
  }
  loading.clear();
}

// Have the worker load a file into the running Datasette. param is the URL
// parameter for that type of file: url, csv, json, parquet or sql. Resolves
// to {path}, the Datasette page that shows what was loaded, or to
// {reload: true} if it can only be loaded by reloading the page.
function loadInWorker(param, url) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    loading.set(id, {resolve, reject});
    datasetteWorker.postMessage({type: "load", id, param, url});
  });
}
let workerReady;
({worker: datasetteWorker, ready: workerReady} = startWorker(startup, showStep));

// Have the worker answer a request, replying on port. stream says whether the
// service worker can take the response in pieces - one from an older release
// cannot, and is sent the whole response once it is complete, as before.
function callWorker(request, port, stream) {
  const id = nextId++;
  pending.set(id, {port, streaming: false});
  port.onmessage = (event) => {
    if (event.data && event.data.cancel && pending.delete(id)) {
      // The page stopped reading a streamed response: let Datasette know
      datasetteWorker.postMessage({type: "cancel", id});
    }
  };
  datasetteWorker.postMessage(
    {type: "request", id, stream: !!stream, ...request},
    request.body ? [request.body] : [],
  );
}

// --- The service worker ------------------------------------------------------

function onServiceWorkerMessage(event) {
  const data = event.data || {};
  const port = event.ports[0];
  if (data.type == "datasette-lite-owner") {
    port.postMessage({owner: data.session === SESSION, protocol: PROTOCOL});
  } else if (data.type == "datasette-lite-request" && data.session === SESSION) {
    callWorker(data.request, port, data.stream);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "Datasette Lite needs a browser with service worker support. " +
      "Service workers are unavailable in some private browsing modes."
    );
  }
  navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
  navigator.serviceWorker.startMessages();
  await navigator.serviceWorker.register("sw.js", {scope: "./"});
  await navigator.serviceWorker.ready;
}

// --- Routing between the #fragment and the iframe ----------------------------

// A URL has one #fragment, and the shell's own fragment can hold a second #
// in front of the page's fragment. Apple's URL parser - used when a link is
// opened from another app on iOS or macOS - percent-encodes that second # as
// %23, along with every % that was already there (%20 becomes %2520).
// Returns the path with that undone, or null if it was not done to this path.
function undoEncodedFragment(path) {
  const at = path.lastIndexOf("%23");
  if (path.includes("#") || at === -1) {
    return null;
  }
  const query = path.indexOf("?");
  if (query !== -1 && query < at) {
    // In a query string %23 can also be a # inside a value, ?q=%23tag. Only
    // take it as the start of a fragment if key=value follows it, as it does
    // for MapLibre's #map=... and datasette-vega's #g.mark=...
    if (!/^[^&=]+=/.test(path.slice(at + 3))) {
      return null;
    }
  }
  const decode = (part) => part.replace(/%25/g, "%");
  return decode(path.slice(0, at)) + "#" + decode(path.slice(at + 3));
}

function pathFromHash() {
  let path = location.hash.replace(/^#/, "");
  if (!path) {
    return "/";
  }
  path = undoEncodedFragment(path) || path;
  if (!path.startsWith("/")) {
    path = "/" + path;
  }
  return path;
}

function isAppPath(pathname) {
  return pathname === APP_ROOT || pathname.startsWith(APP_BASE);
}

// Datasette and plugins sometimes hardcode root-relative "/-/..." URLs that
// ignore base_url. This is where such a URL belongs inside this session.
function appUrlForHardcodedPath(url) {
  if (url.origin !== location.origin || !url.pathname.startsWith("/-/")) {
    return null;
  }
  return APP_ROOT + url.pathname + url.search + url.hash;
}

function frameAppPath() {
  try {
    const loc = frame.contentWindow.location;
    if (!isAppPath(loc.pathname)) {
      return null;
    }
    // Includes the page's own #fragment, where plugins such as datasette-vega
    // keep their state - it ends up as a second # in the shell's fragment
    return (loc.pathname.slice(APP_ROOT.length) || "/") + loc.search + loc.hash;
  } catch (e) {
    return null;
  }
}

function mirrorFrameInHash() {
  const path = frameAppPath();
  if (path !== null) {
    const newHash = "#" + path;
    if (location.hash !== newHash) {
      // replaceState: the iframe navigation already created a history entry
      history.replaceState(null, "", newHash);
    }
  }
}

function navigateFrame(path, replace) {
  const target = APP_ROOT + path;
  if (replace) {
    frame.contentWindow.location.replace(target);
  } else {
    frame.src = target;
  }
}

window.addEventListener("hashchange", () => {
  // The user edited the #fragment, or went back/forward to a #fragment change.
  // When only the page's own fragment differs, replace() is a same-document
  // navigation and the iframe doesn't reload.
  const path = pathFromHash();
  if (frameAppPath() !== path) {
    navigateFrame(path, true);
  }
});

let firstLoad = true;

frame.addEventListener("load", () => {
  let doc, href, origin, pathname;
  try {
    doc = frame.contentDocument;
    ({href, origin, pathname} = frame.contentWindow.location);
  } catch (e) {
    // The iframe is on another origin (a plugin redirected to an OAuth
    // provider, say) - reading its location throws a SecurityError
    return;
  }
  if (href === "about:blank") {
    return;
  }
  if (origin === location.origin && !isAppPath(pathname)) {
    const appUrl = appUrlForHardcodedPath(new URL(href));
    if (appUrl) {
      // A navigation to a hardcoded /-/ path that the service worker could
      // not route to a session (see sessionOfRequester() in sw.js), so the
      // iframe is showing the host's 404. This page knows its own session:
      // send the iframe back there. replace() drops the 404 from history.
      frame.contentWindow.location.replace(appUrl);
      return;
    }
    // Somehow navigated outside Datasette within this site - show it full page
    location.href = href;
    return;
  }
  mirrorFrameInHash();
  // A #fragment change within the page doesn't fire "load". This is a new
  // window object for every page load, so the listener is never doubled up.
  frame.contentWindow.addEventListener("hashchange", mirrorFrameInHash);
  // Neither does history.replaceState() or pushState(), and those don't fire
  // "hashchange" either. datasette-maplibre and MapLibre itself keep their
  // state in the #fragment that way, so wrap both to mirror the new URL.
  const frameHistory = frame.contentWindow.history;
  for (const method of ["replaceState", "pushState"]) {
    const original = frameHistory[method];
    frameHistory[method] = function (...args) {
      const result = original.apply(this, args);
      mirrorFrameInHash();
      return result;
    };
  }
  document.title = (doc && doc.title) || "Datasette";
  if (doc && doc.contentType == "text/html" && doc.body) {
    enhanceDocument(doc);
  }
  if (!firstLoad) {
    useAnalytics && plausible("pageview", {u: location.href.replace("?", "").replace("#", "/")});
  }
  firstLoad = false;
});

// --- Downloads -----------------------------------------------------------------

// Browsers do not ask the service worker for the target of an <a download>
// link: the download is requested straight from the network, where app URLs
// do not exist, so what gets saved is the host's 404 page (seen in Chromium
// and in Safari). Datasette 1.0's export dialog downloads through such links.
// fetch() does go through the service worker, so the shell fetches the file
// and saves it from a blob: URL instead. A download started any other way - a
// link or form to a response with Content-Disposition: attachment - is a
// navigation, which the service worker does get.

// The file name a response asks to be saved as, if it says
function contentDispositionFilename(response) {
  const header = response.headers.get("content-disposition") || "";
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch (e) {
      // Fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] || plain[2] || "").trim() : "";
}

// Save an app URL as a file. name is the link's download attribute, which
// can be empty: the name then comes from the response, or else from the URL.
async function downloadWithFetch(href, name) {
  let blob, filename;
  try {
    const response = await fetch(href);
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " " + (await response.text()).slice(0, 200));
    }
    filename =
      name || contentDispositionFilename(response) ||
      decodeURIComponent(new URL(href).pathname.split("/").pop()) || "download";
    blob = await response.blob();
  } catch (error) {
    window.alert("Download failed: " + ((error && error.message) || error));
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Not straight away: the download reads the blob after the click returns
  setTimeout(() => URL.revokeObjectURL(link.href), 60 * 1000);
}

// Called for every HTML page Datasette renders in the iframe
function enhanceDocument(doc) {
  // Open external links in a new window, and make links to other Datasette
  // Lite URLs (e.g. in metadata descriptions) replace the whole page.
  doc.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) {
      return;
    }
    const link = ev.target.closest && ev.target.closest("a[href]");
    if (!link) {
      return;
    }
    let url;
    try {
      url = new URL(link.href);
    } catch (e) {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      return;
    }
    if (
      url.hash == "#manage-plugins" && link.closest(".nav-menu") &&
      doc.defaultView.DatasetteModal
    ) {
      ev.preventDefault();
      // Close the menu the link is in
      link.closest("details").open = false;
      openManagePlugins(doc, link);
      return;
    }
    if (
      link.hasAttribute("download") &&
      url.origin === location.origin && isAppPath(url.pathname)
    ) {
      // The browser would not ask the service worker for this - see Downloads
      ev.preventDefault();
      downloadWithFetch(url.href, link.getAttribute("download"));
      return;
    }
    const target = (link.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") {
      return;
    }
    if (url.origin !== location.origin) {
      ev.preventDefault();
      // noopener: link targets come from arbitrary data, so don't hand the
      // opened site a window.opener reference to this page
      window.open(url.href, "_blank", "noopener");
    } else if (!isAppPath(url.pathname)) {
      ev.preventDefault();
      const appUrl = appUrlForHardcodedPath(url);
      if (appUrl) {
        // A hardcoded /-/ link, e.g. one added by a plugin's JavaScript so
        // the server-side attribute rewrite never saw it
        frame.contentWindow.location.href = appUrl;
      } else {
        // A link to another Datasette Lite URL - replace the whole page
        location.href = url.href;
      }
    }
  });
  addLoadButtons(doc);
}

// --- The "Manage plugins" dialog ----------------------------------------------
//
// Datasette Lite's own plugin (register_datasette_lite_plugin() in
// webworker.js) adds a "Manage plugins" link to Datasette's menu. Clicking it
// opens this dialog, built with Datasette's DatasetteModal API inside the
// page in the iframe. It lists the installed plugins and some suggested ones,
// and applying a change restarts Datasette with the new set of ?install=
// values - without reloading this page.

// Each of these has been tried with the Datasette that runs by default
const SUGGESTED_PLUGINS = [
  ["datasette-charts", "Charts of tables and SQL query results"],
  ["datasette-maplibre", "Maps of latitude/longitude and GeoJSON data"],
  ["datasette-search-all", "Search every searchable table at once"],
  ["datasette-render-markdown", "Render Markdown values as HTML"],
  ["datasette-pretty-json", "Pretty-print values that are JSON"],
];

// The name of the package an ?install= value installs, as best as can be
// told without installing it: datasette-leaflet>=0.3, owner/repo@ref and the
// URL of a wheel all work. Normalized as PyPI does, to compare names.
function installName(requirement) {
  let name = requirement.trim();
  const wheel = /([^\/?#]+)\.whl([?#]|$)/.exec(name);
  if (wheel) {
    name = wheel[1].split("-")[0];
  } else if (name.includes("/")) {
    // A GitHub repository, or the URL of a page in one
    const repo = /^(?:https?:\/\/[^\/]+\/)?[^\/]+\/([^\/@]+)/.exec(name);
    name = repo ? repo[1].replace(/\.git$/, "") : name;
  }
  name = (/^[A-Za-z0-9._-]+/.exec(name) || [name])[0];
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

// The page's URL with its ?install= parameters replaced by these. Everything
// else is kept exactly as it was written, #fragment included.
function urlWithInstalls(installs) {
  const parts = location.search.replace(/^\?/, "").split("&").filter((part) => {
    if (!part) {
      return false;
    }
    try {
      return decodeURIComponent(part.split("=")[0].replace(/\+/g, " ")) != "install";
    } catch (e) {
      return true;
    }
  });
  for (const install of installs) {
    // Left readable: datasette-leaflet==0.3, owner/repo@ref, https://...
    parts.push(
      "install=" + encodeURIComponent(install).replace(/%(2F|3A|40|3D|2C)/gi, decodeURIComponent)
    );
  }
  return location.pathname + (parts.length ? "?" + parts.join("&") : "") + location.hash;
}

// Have the running Datasette change its plugins to these ?install= values,
// without starting again: see change_plugins() in webworker.js. Resolves to
// true if it did. If it could not - the change needs a new Python, or a
// plugin failed to install - Datasette is still running as it was.
function changePluginsInPlace(installs, onStep) {
  const worker = datasetteWorker;
  const previousOnStep = worker.onStep;
  return new Promise((resolve) => {
    worker.onStep = onStep;
    worker.onPluginsChanged = (data) => {
      worker.onStep = previousOnStep;
      worker.onPluginsChanged = null;
      data.error && console.log("Plugins could not be changed in place:", data.error);
      resolve(data.result == "ok");
    };
    worker.postMessage({type: "plugins", installUrls: installs});
  });
}

// Restart Datasette with these ?install= values in place of the current
// ones, in a new worker. It starts up behind the one that is running, which
// keeps answering requests until the new one is ready to take over - so if a
// plugin cannot be installed nothing has changed, and the promise rejects.
async function restartWithInstalls(installs, onStep) {
  const message = {...startup, installUrls: installs};
  const {worker, ready} = startWorker(message, onStep);
  try {
    await ready;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  const previous = datasetteWorker;
  datasetteWorker = worker;
  // Requests the previous worker had not finished answering
  failPending("Datasette was restarted");
  previous.terminate();
}

// Change the plugins to these ?install= values, then update the page's URL
// to match. The running Datasette does it itself if it can, which takes a
// moment and keeps changes made to the data. Otherwise - and if that fails,
// so that the error reported is one from a clean start - Datasette is
// started again from nothing. onStep is called with each step of either,
// and with {reset: true} when the second takes over from the first. Rejects,
// with nothing changed, if Datasette cannot run with those plugins. The
// caller reloads the iframe.
async function applyInstalls(installs, onStep) {
  if (!(await changePluginsInPlace(installs, onStep))) {
    onStep({reset: true});
    await restartWithInstalls(installs, onStep);
  }
  startup = {...startup, installUrls: installs};
  history.replaceState(null, "", urlWithInstalls(installs));
}

const MANAGE_PLUGINS_CSS = `
#manage-plugins-dialog .modal-body {
  font-size: 0.875rem;
  line-height: 1.4;
  color: var(--ink);
}
/* Datasette's stylesheet gives these elements a display of their own */
#manage-plugins-dialog [hidden] {
  display: none !important;
}
#manage-plugins-dialog h3 {
  margin: 1.1rem 0 0.4rem 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
#manage-plugins-dialog h3:first-child {
  margin-top: 0;
}
#manage-plugins-dialog ul,
#manage-plugins-dialog ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
#manage-plugins-dialog .mp-plugins li {
  padding: 0.2rem 0;
}
#manage-plugins-dialog .mp-plugins label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  cursor: pointer;
}
#manage-plugins-dialog .mp-plugins li.mp-fixed {
  padding-left: 1.55rem;
}
#manage-plugins-dialog .mp-plugins input {
  flex: none;
  margin: 0;
  width: 1.05rem;
  height: 1.05rem;
  position: relative;
  top: 0.15rem;
}
#manage-plugins-dialog .mp-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
#manage-plugins-dialog .mp-detail,
#manage-plugins-dialog .mp-help,
#manage-plugins-dialog .mp-empty {
  color: var(--muted);
}
#manage-plugins-dialog .mp-help {
  margin: 0.4rem 0 0 0;
  font-size: 0.8rem;
}
#manage-plugins-dialog code {
  font-family: ui-monospace, monospace;
  font-size: 0.95em;
  background: var(--paper);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
#manage-plugins-dialog input[type="text"] {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--rule);
  border-radius: 5px;
  font: inherit;
  /* 16px or more, or iOS Safari zooms in when it is focused */
  font-size: 1rem;
  color: var(--ink);
  background: #fff;
}
#manage-plugins-dialog input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
#manage-plugins-dialog .mp-error {
  margin: 0 0 1rem 0;
  padding: 0.6rem 0.75rem;
  border-radius: 5px;
  background: #fdecec;
  color: #8a1c1c;
  overflow-wrap: anywhere;
}
#manage-plugins-dialog .mp-progress li {
  position: relative;
  padding: 0.15rem 0 0.15rem 1.4rem;
  overflow-wrap: anywhere;
}
#manage-plugins-dialog .mp-progress li::before {
  content: "";
  position: absolute;
  left: 0.1rem;
  top: 0.4rem;
  box-sizing: border-box;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--rule);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: mp-spin 0.8s linear infinite;
}
#manage-plugins-dialog .mp-progress li.done {
  color: var(--muted);
}
#manage-plugins-dialog .mp-progress li.done::before {
  content: "\\2713";
  top: 0.1rem;
  width: auto;
  height: auto;
  border: 0;
  animation: none;
  color: #2e7d4f;
  font-weight: 700;
}
@keyframes mp-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  #manage-plugins-dialog .mp-progress li::before {
    animation-duration: 4s;
  }
}
`;

// The plugins Datasette says are installed: [{name, version}], without
// Datasette Lite's own. Empty if Datasette will not say.
async function installedPlugins() {
  try {
    const response = await fetch(APP_BASE + "-/plugins.json");
    const plugins = response.ok ? await response.json() : [];
    return plugins.filter((plugin) => plugin.name != "datasette_lite");
  } catch (error) {
    return [];
  }
}

// Open the dialog in doc, the page in the iframe. link is the menu item.
async function openManagePlugins(doc, link) {
  const DatasetteModal = doc.defaultView.DatasetteModal;
  const existing = doc.getElementById("manage-plugins-dialog");
  existing && existing.parentNode.remove();
  const plugins = await installedPlugins();
  const current = startup.installUrls.filter(Boolean);

  // el("p", {className: "x"}, "text", otherElement)
  const el = (tag, props, ...children) => {
    const element = Object.assign(doc.createElement(tag), props || {});
    element.append(...children);
    return element;
  };
  const versions = new Map(
    plugins.map((plugin) => [installName(plugin.name), plugin.version])
  );
  const checkbox = (value, checked) => el("input", {type: "checkbox", value, checked});

  // Installed: one row for each ?install= value, which unticking removes,
  // then the plugins that came with those - as their dependencies
  const installedList = el("ul", {className: "mp-plugins mp-installed"});
  const listed = new Set();
  for (const install of current) {
    const name = installName(install);
    listed.add(name);
    const version = versions.get(name);
    installedList.append(el("li", null, el("label", null,
      checkbox(install, true),
      el("span", null,
        el("span", {className: "mp-name"}, install),
        // Not for datasette-leaflet==0.3, which says it already
        version && !install.includes(version)
          ? el("span", {className: "mp-detail"}, " " + version) : "",
      ),
    )));
  }
  for (const plugin of plugins) {
    const name = installName(plugin.name);
    if (!listed.has(name)) {
      listed.add(name);
      installedList.append(el("li", {className: "mp-fixed"},
        el("span", {className: "mp-name"}, plugin.name),
        el("span", {className: "mp-detail"},
          (plugin.version ? " " + plugin.version : "") + " - needed by another plugin"),
      ));
    }
  }
  const suggestedList = el("ul", {className: "mp-plugins mp-suggested"});
  for (const [name, description] of SUGGESTED_PLUGINS) {
    if (!listed.has(name)) {
      suggestedList.append(el("li", null, el("label", null,
        checkbox(name, false),
        el("span", null,
          el("span", {className: "mp-name"}, name),
          el("span", {className: "mp-detail"}, " - " + description),
        ),
      )));
    }
  }
  const other = el("input", {
    type: "text", id: "manage-plugins-other", name: "plugin",
    placeholder: "datasette-plugin-name",
    autocomplete: "off", autocapitalize: "off", spellcheck: false,
  });
  other.setAttribute("aria-describedby", "manage-plugins-other-help");
  const error = el("div", {className: "mp-error", hidden: true});
  error.setAttribute("role", "alert");
  const progress = el("ol", {className: "mp-progress"});
  progress.setAttribute("role", "log");
  progress.setAttribute("aria-label", "Restart progress");
  const heading = el("h3", null, "Updating plugins");
  const progressSection = el("div", {hidden: true}, heading, progress);
  const directory = el("a", {href: "https://datasette.io/plugins"}, "Datasette plugins directory");
  const choices = el("div", null,
    el("h3", null, "Installed plugins"),
    installedList.children.length
      ? installedList : el("p", {className: "mp-empty"}, "No plugins are installed."),
    ...(suggestedList.children.length ? [el("h3", null, "Suggested plugins"), suggestedList] : []),
    el("h3", null, el("label", {htmlFor: "manage-plugins-other"}, "Add another plugin")),
    other,
    el("p", {className: "mp-help", id: "manage-plugins-other-help"},
      "The name of a plugin from the ", directory,
      ". You can also use ", el("code", null, "plugin-name==0.3"),
      " to install a specific version. Separate several plugins with spaces."),
  );

  const cancel = el("button", {type: "button", className: "modal-btn modal-btn-ghost"}, "Cancel");
  const apply = el("button", {
    type: "submit", className: "modal-btn modal-btn-primary", disabled: true,
  }, "Apply");
  const form = el("form", {noValidate: true},
    el("style", null, MANAGE_PLUGINS_CSS),
    el("div", {className: "modal-header"},
      el("h2", {className: "modal-title", id: "manage-plugins-title"}, "Manage plugins")),
    el("div", {className: "modal-body"}, error, choices, progressSection),
    el("div", {className: "modal-footer"},
      cancel, apply),
  );
  // The form is what lays out the header, body and footer
  form.style.cssText = "display: flex; flex-direction: column; min-height: 0; margin: 0;";

  const modal = DatasetteModal.create();
  const dialog = modal.dialog;
  dialog.id = "manage-plugins-dialog";
  dialog.setAttribute("aria-labelledby", "manage-plugins-title");
  dialog.append(form);

  // The ?install= values the dialog is asking for, in order
  const chosen = () => {
    const installs = [...form.querySelectorAll("input[type=checkbox]:checked")]
      .map((input) => input.value)
      .concat(other.value.split(/\s+/).filter(Boolean));
    return [...new Set(installs)];
  };
  const changed = () => JSON.stringify(chosen()) != JSON.stringify(current);
  form.addEventListener("input", () => {
    apply.disabled = !changed();
  });
  cancel.addEventListener("click", () => modal.requestClose("cancel"));
  dialog.addEventListener("close", () => modal.remove());

  const steps = new Map(); // id -> <li>
  const onStep = ({id, label, done, reset}) => {
    if (reset) {
      // Starting again in a new worker, which finishes a "pyodide" step
      // without having started it
      steps.clear();
      progress.replaceChildren();
      heading.textContent = "Restarting Datasette";
      onStep({id: "pyodide", label: "Loading Python (Pyodide)"});
      return;
    }
    let item = steps.get(id);
    if (!item) {
      item = el("li");
      steps.set(id, item);
      progress.append(item);
    }
    if (label != null) {
      item.textContent = label;
    }
    done && item.classList.add("done");
    item.scrollIntoView({block: "nearest"});
  };
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (modal.busy || !changed()) {
      return;
    }
    const installs = chosen();
    const controls = [...form.querySelectorAll("input"), apply, cancel];
    modal.busy = true;
    controls.forEach((control) => { control.disabled = true; });
    apply.textContent = "Applying\u2026";
    error.hidden = true;
    choices.hidden = true;
    progressSection.hidden = false;
    steps.clear();
    progress.replaceChildren();
    heading.textContent = "Updating plugins";
    try {
      await applyInstalls(installs, onStep);
    } catch (failure) {
      // Nothing has changed: Datasette is still running as it was
      modal.busy = false;
      controls.forEach((control) => { control.disabled = false; });
      apply.textContent = "Apply";
      const lines = String((failure && failure.message) || failure).trim().split("\n");
      error.textContent = "Datasette could not run with those plugins, so " +
        "nothing has changed. " + lines[lines.length - 1];
      error.hidden = false;
      choices.hidden = false;
      progressSection.hidden = true;
      error.scrollIntoView({block: "nearest"});
      return;
    }
    // The new Datasette renders the page again, without this dialog. A
    // plugin that was removed may have been what served this page.
    doc.defaultView.location.reload();
  });

  doc.body.append(modal);
  modal.show({returnFocusTo: link, initialFocus: other});
}

// --- The "Load SQLite DB by URL" etc buttons ----------------------------------

async function checkUrl(url, contentTypes) {
  try {
    const response = await fetch(url, {method: "HEAD"});
    if (response.status != 200) {
      return false;
    }
    if (contentTypes && (!contentTypes.includes(response.headers.get("content-type")))) {
      return false;
    }
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

const fileTypes = [
  {
    id: "db-url",
    label: "Load SQLite DB by URL",
    prompt: "Enter a full URL to a SQLite .db file",
    param: "url",
    mimes: [
      "application/octet-stream",
      "application/x-sqlite3",
      "application/vnd.sqlite3",
    ],
  },
  {id: "csv-url", label: "Load CSV", prompt: "Enter a full URL to a CSV file", param: "csv"},
  {id: "json-url", label: "Load JSON", prompt: "Enter a full URL to a JSON file", param: "json"},
  {
    id: "parquet-url",
    label: "Load Parquet",
    prompt: "Enter a full URL to a Parquet file",
    param: "parquet",
  },
  {id: "sql-url", label: "Load SQL", prompt: "Enter a full URL to a SQL file", param: "sql"},
];

// Styled after Datasette 1.0's "quiet buttons" (Export data, View and edit
// SQL). Self-contained and scoped to #load-custom, so the buttons look the same
// whichever Datasette version is running and whatever its CSS does to buttons.
const LOAD_BUTTONS_CSS = `
#load-custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 1rem;
}
#load-custom button {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 1.75rem;
  margin: 0;
  padding: 0.2rem 0.6rem;
  border: 1px solid #d8e6f5;
  border-radius: 5px;
  background: #fff;
  color: #24465d;
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.2;
  cursor: pointer;
}
#load-custom button:hover,
#load-custom button:focus-visible {
  border-color: #1a56db;
  background: #e8effd;
  color: #1949b8;
}
#load-custom button:focus-visible {
  outline: 2px solid #1a56db;
  outline-offset: 2px;
}
#load-custom a {
  font-size: 0.875rem;
}
`;

// Added to the end of every page Datasette renders, and to the footer of the
// loading screen - there is no need to wait for Datasette to start before
// loading something else, and after a failed load they are the way out.
function addLoadButtons(doc, parent) {
  if (doc.getElementById("load-custom")) {
    return;
  }
  const form = doc.createElement("form");
  form.id = "load-custom";
  const style = doc.createElement("style");
  style.textContent = LOAD_BUTTONS_CSS;
  form.appendChild(style);
  for (const fileType of fileTypes) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = fileType.id;
    button.textContent = fileType.label;
    button.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const url = fixUrl(window.prompt(fileType.prompt));
      if (!url) {
        return;
      }
      const valid = await checkUrl(url, fileType.mimes);
      if (!valid) {
        window.alert(`That ${fileType.param.toUpperCase()} could not be loaded`);
      } else if (datasetteRunning) {
        loadIntoDatasette(fileType, url);
      } else {
        // Datasette is still starting, or failed to: start again with this
        location.href =
          location.pathname + "?" + fileType.param + "=" + encodeURIComponent(url);
      }
    });
    form.appendChild(button);
  }
  const docs = doc.createElement("a");
  docs.href = "https://github.com/simonw/datasette-lite";
  docs.textContent = "Documentation";
  // No colour of its own: it takes Datasette's link colours
  form.appendChild(docs);
  (parent || doc.body).appendChild(form);
}

// Set once Datasette has started
let datasetteRunning = false;
let loadingIntoDatasette = false;

// Load a file into the Datasette that is already running, then add it to this
// page's URL - without reloading - so that the URL is still a link to what is
// on screen. The file is added to whatever the URL already loads.
async function loadIntoDatasette(fileType, url) {
  if (loadingIntoDatasette) {
    return;
  }
  loadingIntoDatasette = true;
  // Appended as text: anything already in the URL is left exactly as it is
  const search =
    (location.search.length > 1 ? location.search + "&" : "?") +
    fileType.param + "=" + encodeURIComponent(url);
  showLoadingScreen("Loading data");
  try {
    const result = await loadInWorker(fileType.param, url);
    if (result.reload) {
      // Not something that can be added to a running Datasette - see
      // LOAD_PY in webworker.js. Loading the new URL does the same thing.
      location.href = location.pathname + search;
      return;
    }
    // What a new worker would be started with, if a change of plugins needs
    // one - see restartWithInstalls()
    const setting = fileType.param == "url" ? "sqliteUrls" : fileType.param + "Urls";
    startup = {...startup, [setting]: [...startup[setting], url]};
    history.replaceState(null, "", location.pathname + search + location.hash);
    // Show what was loaded. The #fragment follows once the iframe has loaded.
    frame.contentWindow.location.href = result.path;
  } catch (error) {
    window.alert(
      `That ${fileType.param.toUpperCase()} could not be loaded: ` +
      ((error && error.message) || error).trim().split("\n").pop()
    );
  } finally {
    loadingIntoDatasette = false;
  }
  hideLoadingScreen();
}

// --- Boot ----------------------------------------------------------------------

addLoadButtons(document, document.getElementById("shell-footer"));

async function main() {
  await Promise.all([registerServiceWorker(), workerReady]);
  navigateFrame(pathFromHash(), false);
  document.body.classList.add("ready");
  stopStepTimer();
  datasetteRunning = true;
}

main().catch((error) => showError((error && error.message) || String(error)));

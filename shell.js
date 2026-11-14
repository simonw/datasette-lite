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
const startup = {
  type: "startup",
  ref: urlParams.get("ref"),
  sqliteUrls: urlParams.getAll("url").map(fixUrl),
  memory: !!urlParams.get("memory"),
  metadataUrl: fixUrl(urlParams.get("metadata")),
  configUrl: fixUrl(urlParams.get("config")),
  csvUrls: urlParams.getAll("csv").map(fixUrl),
  sqlUrls: urlParams.getAll("sql").map(fixUrl),
  jsonUrls: urlParams.getAll("json").map(fixUrl),
  parquetUrls: urlParams.getAll("parquet").map(fixUrl),
  installUrls: urlParams.getAll("install"),
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

// Each line the worker reports becomes a step on the loading screen: the last
// one in the list is the step in progress, the ones above it are finished
function log(line) {
  const steps = document.getElementById("loading-logs");
  const step = document.createElement("li");
  step.textContent = line;
  steps.appendChild(step);
  steps.scrollTop = steps.scrollHeight;
}

function showError(message) {
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

// A module worker: Pyodide is loaded with import(), see webworker.js
const datasetteWorker = new Worker("webworker.js", {type: "module"});
// Requests the worker has not finished answering: id -> {port, streaming}.
// port is the MessagePort the service worker is waiting on for the reply.
const pending = new Map();
let nextId = 1;

let failWorkerStartup;
const workerReady = new Promise((resolve, reject) => {
  failWorkerStartup = reject;
  datasetteWorker.onmessage = (event) => {
    const data = event.data;
    if (data.type == "log") {
      log(data.line);
    } else if (data.type == "ready") {
      resolve();
    } else if (data.type == "error") {
      reject(new Error(data.error));
    } else {
      onWorkerResponse(data);
    }
  };
});

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

// If the worker dies (out of memory, say) nothing will ever answer the
// requests waiting on it, so fail them rather than leave them hanging.
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
}
datasetteWorker.onerror = (event) => {
  // The event has no message when the worker script itself could not be loaded
  const reason =
    (event && event.message) || "the worker script webworker.js could not be loaded or run";
  // While Datasette is still starting nothing is pending: this is a startup
  // failure - Pyodide could not be downloaded, say - so show it instead of
  // leaving the page on "Loading...". A no-op once the worker is ready.
  failWorkerStartup(new Error("The Datasette worker failed to start: " + reason));
  failPending("the Datasette worker failed: " + reason);
};
datasetteWorker.onmessageerror = () => {
  failPending("a message from the Datasette worker could not be read");
};

datasetteWorker.postMessage(startup);

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

function pathFromHash() {
  let path = location.hash.replace(/^#/, "");
  if (!path) {
    return "/";
  }
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
  document.title = (doc && doc.title) || "Datasette";
  if (doc && doc.contentType == "text/html" && doc.body) {
    enhanceDocument(doc);
  }
  if (!firstLoad) {
    useAnalytics && plausible("pageview", {u: location.href.replace("?", "").replace("#", "/")});
  }
  firstLoad = false;
});

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
    const target = (link.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") {
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
      if (valid) {
        location.href =
          location.pathname + "?" + fileType.param + "=" + encodeURIComponent(url);
      } else {
        window.alert(`That ${fileType.param.toUpperCase()} could not be loaded`);
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

// --- Boot ----------------------------------------------------------------------

addLoadButtons(document, document.getElementById("shell-footer"));

async function main() {
  await Promise.all([registerServiceWorker(), workerReady]);
  navigateFrame(pathFromHash(), false);
  document.body.classList.add("ready");
}

main().catch((error) => showError((error && error.message) || String(error)));

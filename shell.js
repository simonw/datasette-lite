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
const loadingLogs = ["Loading..."];

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function log(line) {
  const ta = document.getElementById("loading-logs");
  loadingLogs.push(line);
  ta.value = loadingLogs.join("\n");
  ta.scrollTop = ta.scrollHeight;
}

function showError(message) {
  document.getElementById("loading-indicator").style.display = "none";
  document.getElementById("output").innerHTML =
    `<div style="padding: 0.5em"><h3>Error</h3><pre style="white-space: pre-wrap">${escapeHtml(message)}</pre></div>`;
}

// --- The Pyodide worker ------------------------------------------------------

const datasetteWorker = new Worker("webworker.js");
const pending = new Map();
let nextId = 1;

const workerReady = new Promise((resolve, reject) => {
  datasetteWorker.onmessage = (event) => {
    const data = event.data;
    if (data.type == "log") {
      log(data.line);
    } else if (data.type == "ready") {
      resolve();
    } else if (data.type == "error") {
      reject(new Error(data.error));
    } else if (data.type == "response") {
      const resolveResponse = pending.get(data.id);
      pending.delete(data.id);
      resolveResponse && resolveResponse(data);
    }
  };
});
datasetteWorker.postMessage(startup);

function callWorker(request) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    datasetteWorker.postMessage(
      {type: "request", id, ...request},
      request.body ? [request.body] : [],
    );
  });
}

// --- The service worker ------------------------------------------------------

function onServiceWorkerMessage(event) {
  const data = event.data || {};
  const port = event.ports[0];
  if (data.type == "datasette-lite-owner") {
    port.postMessage({owner: data.session === SESSION});
  } else if (data.type == "datasette-lite-request" && data.session === SESSION) {
    callWorker(data.request).then((response) => {
      port.postMessage(
        {status: response.status, headers: response.headers, body: response.body},
        response.body ? [response.body] : [],
      );
    });
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

function frameAppPath() {
  try {
    const loc = frame.contentWindow.location;
    if (!isAppPath(loc.pathname)) {
      return null;
    }
    return (loc.pathname.slice(APP_ROOT.length) || "/") + loc.search;
  } catch (e) {
    return null;
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
  // The user edited the #fragment, or went back/forward to a #fragment change
  const path = pathFromHash();
  if (frameAppPath() !== path) {
    navigateFrame(path, true);
  }
});

let firstLoad = true;

frame.addEventListener("load", () => {
  let doc;
  try {
    doc = frame.contentDocument;
  } catch (e) {
    return;
  }
  const loc = frame.contentWindow.location;
  if (loc.href === "about:blank") {
    return;
  }
  if (loc.origin === location.origin && !isAppPath(loc.pathname)) {
    // Somehow navigated outside Datasette within this site - show it full page
    location.href = loc.href;
    return;
  }
  const path = frameAppPath();
  if (path !== null) {
    const newHash = "#" + path;
    if (location.hash !== newHash) {
      // replaceState: the iframe navigation already created a history entry
      history.replaceState(null, "", newHash);
    }
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
      window.open(url.href);
    } else if (!isAppPath(url.pathname)) {
      ev.preventDefault();
      location.href = url.href;
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

function addLoadButtons(doc) {
  if (doc.getElementById("load-custom")) {
    return;
  }
  const form = doc.createElement("form");
  form.id = "load-custom";
  const p = doc.createElement("p");
  p.style.padding = "1em";
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
    p.appendChild(button);
    p.appendChild(doc.createTextNode(" "));
  }
  const docs = doc.createElement("a");
  docs.href = "https://github.com/simonw/datasette-lite";
  docs.textContent = "Documentation";
  docs.style.cssText = "text-decoration: none; padding-left: 0.3em; color: #067EFF";
  p.appendChild(docs);
  form.appendChild(p);
  doc.body.appendChild(form);
}

// --- Boot ----------------------------------------------------------------------

async function main() {
  await Promise.all([registerServiceWorker(), workerReady]);
  navigateFrame(pathFromHash(), false);
  document.body.classList.add("ready");
}

main().catch((error) => showError((error && error.message) || String(error)));

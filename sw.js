// sw.js - the Datasette Lite service worker.
//
// Every same-origin request under <scope>/app/<session>/ - link navigations,
// form submissions (GET and POST), fetch() calls made by Datasette's own
// JavaScript and by plugins, static assets - is intercepted here and answered
// by the Datasette ASGI app running in Pyodide, in a Web Worker owned by the
// Datasette Lite "shell" page (index.html). Everything else passes through to
// the network.
//
// <session> is a random id chosen by each shell page. It lets several
// Datasette Lite tabs - each with its own databases - share one service worker:
// a request is only ever answered by the tab that owns that session.
//
// Service workers are terminated when idle, so no state is kept here: for each
// request the owning shell is looked up afresh with clients.matchAll().

const SCOPE_PATH = new URL("./", self.location.href).pathname;
const APP_PREFIX = SCOPE_PATH + "app/";
const OWNER_TIMEOUT_MS = 2000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function sessionFor(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(APP_PREFIX)) return null;
  const session = url.pathname.slice(APP_PREFIX.length).split("/")[0];
  return session || null;
}

function isAppPath(pathname) {
  return pathname.startsWith(APP_PREFIX);
}

self.addEventListener("fetch", (event) => {
  const session = sessionFor(event.request.url);
  if (session) {
    event.respondWith(handleAppRequest(event.request, session));
    return;
  }
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/-/")) {
    // Datasette (and plugins) sometimes hardcode root-relative "/-/..." URLs
    // that ignore base_url - e.g. a form action="/-/password-tool". When such
    // a request comes from a Datasette page, route it to that page's session.
    event.respondWith(handleHardcodedPath(event, url));
  }
  // Everything else: network passthrough
});

async function sessionOfRequester(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return sessionFor(client.url);
  }
  // Navigations have no clientId - use the referring page instead
  if (event.request.referrer) {
    return sessionFor(event.request.referrer);
  }
  return null;
}

async function handleHardcodedPath(event, url) {
  const session = await sessionOfRequester(event);
  if (!session) {
    return fetch(event.request);
  }
  const target = new URL(APP_PREFIX + session + url.pathname + url.search, url);
  if (event.request.mode === "navigate") {
    // Let the browser navigate to the correct URL. 307 keeps the method and
    // body of POST form submissions.
    return Response.redirect(target.href, 307);
  }
  return handleAppRequest(new Request(target.href, event.request), session);
}

// Ask a single window client whether it owns this session.
function askOwner(client, session) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), OWNER_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(!!(event.data && event.data.owner));
    };
    client.postMessage({type: "datasette-lite-owner", session}, [channel.port2]);
  });
}

async function findOwner(session) {
  const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
  const shells = windows.filter((client) => !isAppPath(new URL(client.url).pathname));
  if (!shells.length) return null;
  // Resolve as soon as any window claims the session. Windows that never
  // answer - a tab running an older Datasette Lite, some other page on this
  // origin - only cost the timeout when nobody owns the session.
  return new Promise((resolve) => {
    let waiting = shells.length;
    for (const client of shells) {
      askOwner(client, session).then((isOwner) => {
        if (isOwner) resolve(client);
        else if (--waiting === 0) resolve(null);
      });
    }
  });
}

function shellRedirect(shellUrl, requestUrl, session) {
  // Turn /app/<session>/fixtures?sql=... into <shell>?<options>#/fixtures?sql=...
  const url = new URL(requestUrl);
  const appPath = url.pathname.slice((APP_PREFIX + session).length) || "/";
  const target = new URL(shellUrl);
  target.hash = appPath + url.search;
  return Response.redirect(target.href, 302);
}

async function handleAppRequest(request, session) {
  const owner = await findOwner(session);
  // A top-level navigation to an app URL (e.g. "open link in new tab") can't
  // host Pyodide itself, so send it to a fresh Datasette Lite shell instead,
  // with the same startup options when the owning tab is still open.
  if (request.mode === "navigate" && request.destination === "document") {
    if (request.method === "GET") {
      return shellRedirect(owner ? owner.url : new URL(SCOPE_PATH, self.location.href).href,
                           request.url, session);
    }
  }
  if (!owner) {
    return new Response(
      "This Datasette Lite session is no longer running - reload the page to start it again.",
      {status: 503, headers: {"content-type": "text/plain; charset=utf-8"}},
    );
  }

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const body = hasBody ? await request.arrayBuffer() : null;
  const headers = [...request.headers.entries()];

  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = (event) => resolve(event.data);
  });
  owner.postMessage(
    {
      type: "datasette-lite-request",
      session,
      request: {method: request.method, url: request.url, headers, body},
    },
    body ? [channel.port2, body] : [channel.port2],
  );
  const msg = await reply;

  const responseHeaders = new Headers();
  for (const [name, value] of msg.headers) {
    const lower = name.toLowerCase();
    // Datasette Lite hosts Datasette inside an iframe, so neutralise
    // frame-busting headers (Datasette's write pages send these).
    if (lower === "x-frame-options") continue;
    // Can't be set from a service worker anyway - cookies live in the
    // Python-side cookie jar.
    if (lower === "set-cookie") continue;
    if (lower === "content-security-policy") {
      const kept = value
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive && !/^frame-ancestors\b/i.test(directive));
      if (kept.length) responseHeaders.append(name, kept.join("; "));
      continue;
    }
    try {
      responseHeaders.append(name, value);
    } catch (e) {
      // Ignore header values the Fetch API rejects
    }
  }
  const status = msg.status;
  const nullBody = [101, 204, 205, 304].includes(status) || request.method === "HEAD";
  return new Response(nullBody ? null : msg.body, {status, headers: responseHeaders});
}

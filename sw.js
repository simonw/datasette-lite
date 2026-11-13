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
// Version of the messages exchanged with shell.js: "datasette-lite-owner",
// "datasette-lite-request" and their replies. A deploy replaces this service
// worker straight away (skipWaiting + clients.claim below), including under
// tabs that are still running the previous shell.js, so the two can disagree.
// Bump this - here and in shell.js - whenever a message changes in a way the
// other side would not understand. Adding an optional field does not need it.
// A shell that does not say which protocol it speaks predates this check, and
// speaks 1.
const PROTOCOL = 1;
// How long to wait for the owning shell to answer a request. Generous, since
// slow SQL queries are legitimate - but under the 5 minutes after which
// Chromium kills a service worker whose fetch event has not settled, so that
// the page gets the 504 below rather than a network error.
const REPLY_TIMEOUT_MS = 4 * 60 * 1000;

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
  // clientId is the document making the request. Chromium also sets it for
  // navigations, to the document that started them (a script assigning
  // location, a form submission).
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return sessionFor(client.url);
  }
  // Firefox and Safari leave clientId empty for navigations - use the
  // referring page instead.
  if (event.request.referrer) {
    return sessionFor(event.request.referrer);
  }
  // Firefox and Safari only: Datasette's table, row and query pages send
  // Referrer-Policy: no-referrer, so a navigation from one of those to a
  // hardcoded /-/ path arrives with neither a clientId nor a referrer. Nothing
  // else on the event helps: no browser implements replacesClientId, and
  // resultingClientId is the new document, whose URL is the hardcoded path
  // itself (checked in the Chromium, Firefox and WebKit builds shipped with
  // Playwright 1.55). The request falls through to the network and the iframe
  // lands on the host's 404 page - where the shell page, which knows its own
  // session, sends it back into the app (see the load handler in shell.js).
  // That retry is a GET, so the body of a POST made this way is lost.
  // Ordinary links and forms never get here: their attributes are rewritten
  // by datasette_base_url_fixes() in webworker.js.
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

// Ask a single window client whether it owns this session. Resolves to
// {client, protocol} if it does, null if it does not or never answers.
function askOwner(client, session) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), OWNER_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const reply = event.data || {};
      resolve(reply.owner ? {client, protocol: reply.protocol || 1} : null);
    };
    client.postMessage(
      {type: "datasette-lite-owner", session, protocol: PROTOCOL},
      [channel.port2],
    );
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
      askOwner(client, session).then((owner) => {
        if (owner) resolve(owner);
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
      return shellRedirect(
        owner ? owner.client.url : new URL(SCOPE_PATH, self.location.href).href,
        request.url, session,
      );
    }
  }
  if (!owner) {
    return new Response(
      "This Datasette Lite session is no longer running - reload the page to start it again.",
      {status: 503, headers: {"content-type": "text/plain; charset=utf-8"}},
    );
  }
  if (owner.protocol !== PROTOCOL) {
    // The tab was opened before (or, briefly, after) a deploy that changed
    // the messages. It would not understand the request, so don't send it.
    return new Response(
      "Datasette Lite has been updated since this tab was opened. " +
      "Reload the page to keep using it.",
      {status: 409, headers: {"content-type": "text/plain; charset=utf-8"}},
    );
  }

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const body = hasBody ? await request.arrayBuffer() : null;
  const headers = [...request.headers.entries()];

  const channel = new MessageChannel();
  let timer;
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = (event) => resolve(event.data);
    // The owner can vanish mid-request (tab closed or reloaded, worker
    // killed), in which case no reply ever arrives.
    timer = setTimeout(() => resolve(null), REPLY_TIMEOUT_MS);
  });
  owner.client.postMessage(
    {
      type: "datasette-lite-request",
      session,
      request: {method: request.method, url: request.url, headers, body},
    },
    body ? [channel.port2, body] : [channel.port2],
  );
  const msg = await reply;
  clearTimeout(timer);
  channel.port1.close();
  if (!msg) {
    return new Response(
      "Datasette Lite did not answer this request in time - " +
      "the tab running it may have been closed or reloaded.",
      {status: 504, headers: {"content-type": "text/plain; charset=utf-8"}},
    );
  }

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

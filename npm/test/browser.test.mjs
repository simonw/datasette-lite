// Runs the built package in Chromium with every request that is not to the
// local test server blocked - and fails if anything tried.
//
// Needs Playwright (and its Chromium) to be resolvable: it is not a
// dependency of this package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

import { fileURLToPath } from "node:url";

import { startServer } from "./server.mjs";
import { buildWheel } from "./wheel.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

let browser, site, cdn;
const external = [];

before(async () => {
  // A site with no CORS headers, and a "CDN" that sends them. localhost and
  // 127.0.0.1 are different sites, not just different origins, so the CDN is
  // a third party to the page - as a real one is.
  [site, cdn] = await Promise.all([startServer({ hostname: "localhost" }), startServer({ cors: true })]);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  site.server.close();
  cdn.server.close();
});

async function openPage(url) {
  const context = await browser.newContext();
  await context.route(
    (requestUrl) => !["127.0.0.1", "localhost"].includes(requestUrl.hostname),
    (route) => {
      external.push(route.request().url());
      return route.abort();
    },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(url);
  return page;
}

const ready = (page, id) =>
  page.evaluate((elementId) => document.getElementById(elementId).ready.then(() => true), id);

// Resolves with the detail of the first datasette-navigate event whose path
// matches. Not simply the next event: the iframe's load event for the page
// before can still be on its way when a test has already found its content.
const navigationTo = (page, id, pattern) =>
  page.evaluate(
    ([elementId, source]) =>
      new Promise((resolve) => {
        const element = document.getElementById(elementId);
        element.addEventListener("datasette-navigate", function listener(event) {
          if (new RegExp(source).test(event.detail.path)) {
            element.removeEventListener("datasette-navigate", listener);
            resolve(event.detail);
          }
        });
      }),
    [id, pattern.source],
  );

test("two elements on a page outside the package directory", async (t) => {
  const page = await openPage(`${site.origin}/pages/embed.html`);
  await Promise.all([ready(page, "one"), ready(page, "two")]);
  const one = page.frameLocator("#one iframe");
  const two = page.frameLocator("#two iframe");

  await t.test("each shows its own data", async () => {
    await one.locator("table.rows-and-columns").waitFor();
    assert.equal(await one.locator("table.rows-and-columns tbody tr").count(), 10);
    // Signed in as root, so Datasette offers to edit
    await one.locator("text=Insert row").waitFor();
    // Inline <script> data: SQL, CSV and JSON all landed in the "data" database
    await two.locator("h1").waitFor();
    const tables = await two.locator("h3 a").allTextContents();
    assert.deepEqual(tables.map((name) => name.trim()).sort(), ["animals", "colours", "notes"]);
    assert.equal(await page.evaluate(() => document.getElementById("two").path), "/data");
    // ...and the inline metadata was applied
    const home = await page.evaluate(() => document.getElementById("two").fetch("/").then((r) => r.text()));
    assert.match(home, /Inline everything/);
  });

  await t.test("links, forms and Datasette's own JavaScript work inside the element", async () => {
    let navigated = navigationTo(page, "one", /^\/demo\/gardens\/1$/);
    await one.locator('a[href$="/demo/gardens/1"]').first().click();
    await navigated;
    await one.locator("text=Kitchen plot").first().waitFor();

    // A GET form: the SQL editor (CodeMirror, served from the wheel)
    await page.evaluate(() => document.getElementById("one").navigate("/demo"));
    await one.locator(".cm-content").waitFor();
    navigated = navigationTo(page, "one", /^\/demo\/-\/query\?sql=/);
    await one.locator('form.sql input[type="submit"]').first().click();
    await navigated;

    // The other element has not moved
    assert.equal(await page.evaluate(() => document.getElementById("two").path), "/data");
  });

  await t.test("the page can query, write and export without touching the iframe", async () => {
    const result = await page.evaluate(async () => {
      const element = document.getElementById("one");
      const insert = await element.fetch("/demo/plants/-/insert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ row: { common_name: "Kale", height_cm: 50 } }),
      });
      const bytes = await element.readDatabase("demo");
      return {
        status: insert.status,
        rows: await element.query("select count(*) as n from plants"),
        magic: new TextDecoder().decode(bytes.slice(0, 15)),
        // The other element is not signed in: same write is refused
        denied: (await document.getElementById("two").fetch("/data/animals/-/insert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ row: { name: "ant", legs: 6 } }),
        })).status,
      };
    });
    assert.deepEqual(result, { status: 201, rows: [{ n: 11 }], magic: "SQLite format 3", denied: 403 });
  });

  await t.test("a file can be added while Datasette is running", async () => {
    const navigated = navigationTo(page, "two", /^\/data\/rain$/);
    const added = await page.evaluate(() =>
      document.getElementById("two").addFile(new File(["day,mm\nMon,3\nTue,0"], "rain.csv")),
    );
    assert.deepEqual(added, { database: "data", table: "rain" });
    await navigated;
    assert.equal(await two.locator("table.rows-and-columns tbody tr").count(), 2);
  });

  await page.context().close();
});

test("the demo page mirrors the path into the #fragment", async () => {
  const page = await openPage(`${site.origin}/vendor/datasette-lite/index.html#/demo/gardens`);
  await ready(page, "ds");
  const frame = page.frameLocator("#ds iframe");
  // Started on the path in the #fragment rather than the path attribute
  await frame.locator("h1", { hasText: "gardens" }).waitFor();
  const navigated = navigationTo(page, "ds", /^\/demo\/gardens\/2$/);
  await frame.locator('a[href$="/demo/gardens/2"]').first().click();
  await navigated;
  assert.equal(new URL(page.url()).hash, "#/demo/gardens/2");
  // Inline CSV in the demo page
  assert.equal(
    (await page.evaluate(() => document.getElementById("ds").query("select count(*) as n from harvests", { database: "data" })))[0].n,
    4,
  );
  await page.context().close();
});

test("without a UI the package can be loaded from another origin", async () => {
  const page = await openPage(
    `${site.origin}/pages/headless.html?cdn=${encodeURIComponent(cdn.origin + "/vendor/datasette-lite/")}`,
  );
  await page.waitForFunction(() => window.result);
  const result = await page.evaluate(() => window.result);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ legs: 6 }]);
  // No service worker was needed, or registered
  assert.equal(result.registrations, 0);
  await page.context().close();
});

// What a page can do with the element, whichever way the UI is shown
async function exercise(page) {
  return page.evaluate(async () => {
    const element = document.getElementById("ds");
    const insert = await element.fetch("/demo/plants/-/insert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row: { common_name: "Kale", height_cm: 50 } }),
    });
    const added = await element.addFile(new File(["day,mm\nMon,3"], "rain.csv"));
    return {
      insert: insert.status,
      plants: (await element.query("select count(*) as n from plants", { database: "demo" }))[0].n,
      animals: (await element.query("select sum(legs) as n from animals", { database: "data" }))[0].n,
      added,
      magic: new TextDecoder().decode((await element.readDatabase("demo")).slice(0, 15)),
      registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname),
    };
  });
}
const EXPECTED = {
  insert: 201,
  plants: 11,
  animals: 6,
  added: { database: "data", table: "rain" },
  magic: "SQLite format 3",
};

test("from a CDN with no files on the site: Datasette runs in the package's frame.html", async () => {
  const cdnAssets = `${cdn.origin}/vendor/datasette-lite/`;
  const page = await openPage(`${site.origin}/pages/cdn.html?cdn=${encodeURIComponent(cdnAssets)}`);
  await page.waitForFunction(() => document.getElementById("ds"));
  await ready(page, "ds");
  assert.equal(await page.evaluate(() => document.getElementById("ds").mode), "frame");
  // The element's iframe is the CDN's page; Datasette is an iframe inside that
  const outer = page.frameLocator("#ds iframe");
  assert.equal(await page.locator("#ds iframe").getAttribute("src"), cdnAssets + "frame.html");
  const datasette = outer.frameLocator("datasette-lite iframe");
  await datasette.locator("table.rows-and-columns tbody tr").first().waitFor();
  assert.equal(await datasette.locator("table.rows-and-columns tbody tr").count(), 10);
  await datasette.locator("text=Insert row").waitFor();

  // Navigation inside the frame is reported to the page, and to its #fragment
  const navigated = navigationTo(page, "ds", /^\/demo\/gardens\/1$/);
  await datasette.locator('a[href$="/demo/gardens/1"]').first().click();
  await navigated;
  assert.equal(new URL(page.url()).hash, "#/demo/gardens/1");
  // ...and the page can send it somewhere
  const back = navigationTo(page, "ds", /^\/demo$/);
  await page.evaluate(() => document.getElementById("ds").navigate("/demo"));
  await back;

  // No service worker on the site itself
  assert.deepEqual(await exercise(page), { ...EXPECTED, registrations: [] });
  await page.context().close();
});

test("from a CDN with a one-line service worker file on the site", async () => {
  const cdnAssets = `${cdn.origin}/vendor/datasette-lite/`;
  const page = await openPage(`${site.origin}/pages/cdn.html?shim=1&cdn=${encodeURIComponent(cdnAssets)}`);
  await page.waitForFunction(() => document.getElementById("ds"));
  await ready(page, "ds");
  assert.equal(await page.evaluate(() => document.getElementById("ds").mode), "local");
  // Datasette's pages are on the site's own origin, under the directory of sw-shim.js
  const datasette = page.frameLocator("#ds iframe");
  await datasette.locator("table.rows-and-columns tbody tr").first().waitFor();
  assert.match(await page.evaluate(() => document.getElementById("ds").datasette.appUrl("/")), new RegExp(`^${site.origin}/pages/app/`));
  const navigated = navigationTo(page, "ds", /^\/demo\/gardens\/1$/);
  await datasette.locator('a[href$="/demo/gardens/1"]').first().click();
  await navigated;
  assert.deepEqual(await exercise(page), { ...EXPECTED, registrations: ["/pages/"] });
  await page.context().close();
});

test("responses are streamed: through the service worker, and from element.fetch()", async (t) => {
  await buildWheel(
    fileURLToPath(new URL("./pages/generated/", import.meta.url)),
    "datasette-lite-test-stream",
    fileURLToPath(new URL("../../tests/plugins/datasette_lite_test_stream.py", import.meta.url)),
  );
  const page = await openPage(`${site.origin}/pages/stream.html`);
  await ready(page, "ds");
  const frame = page.frameLocator("#ds iframe");
  await frame.locator("footer").waitFor();
  // The Datasette page itself, inside the element's iframe
  const datasette = page.frame({ url: /\/app\// });
  const state = () => page.evaluate(() => document.getElementById("ds").fetch("/-/test-stream-state").then((r) => r.json()));

  // Reads a stream with fetch(), noting when each piece arrived
  const readStream = (fetchFn) => `(async () => {
    const started = performance.now();
    const response = await (${fetchFn})("/-/test-stream?n=3&delay=0.3");
    const reader = response.body.getReader();
    const pieces = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push({ at: performance.now() - started, text: new TextDecoder().decode(value) });
    }
    return { type: response.headers.get("content-type"), pieces };
  })()`;
  const assertStreamed = (result) => {
    assert.equal(result.type, "text/event-stream");
    assert.equal(result.pieces.map((piece) => piece.text).join(""), "data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n");
    // It arrived over time: the first piece well before the last
    assert.ok(result.pieces.length >= 2, `arrived in ${result.pieces.length} piece(s)`);
    const first = result.pieces[0].at;
    const last = result.pieces[result.pieces.length - 1].at;
    assert.ok(first < 400 && last - first > 400, `first at ${first}ms, last at ${last}ms`);
  };

  await t.test("a fetch() made by a Datasette page", async () => {
    // The page's base path, so the request goes through the service worker
    assertStreamed(await datasette.evaluate(readStream(
      `(path) => fetch(location.pathname.match(/^.*?\\/app\\/[^/]+/)[0] + path)`,
    )));
  });

  await t.test("an EventSource in a Datasette page", async () => {
    const events = await datasette.evaluate(() => new Promise((resolve, reject) => {
      const base = location.pathname.match(/^.*?\/app\/[^/]+/)[0];
      const source = new EventSource(base + "/-/test-stream?n=3&delay=0.2");
      const received = [];
      source.onmessage = (event) => {
        received.push(event.data);
        if (received.length == 3) {
          source.close();
          resolve(received);
        }
      };
      source.onerror = () => reject(new Error("EventSource failed"));
    }));
    assert.deepEqual(events, ["tick 0", "tick 1", "tick 2"]);
  });

  await t.test("element.fetch() from the host page", async () => {
    assertStreamed(await page.evaluate(readStream(`(path) => document.getElementById("ds").fetch(path)`)));
  });

  await t.test("aborting a fetch() tells Datasette the client has gone", async () => {
    const before = await state();
    await datasette.evaluate(async () => {
      const base = location.pathname.match(/^.*?\/app\/[^/]+/)[0];
      const abort = new AbortController();
      const response = await fetch(base + "/-/test-stream?n=50&delay=0.1", { signal: abort.signal });
      await response.body.getReader().read();
      abort.abort();
    });
    await page.waitForFunction(
      (disconnected) =>
        document.getElementById("ds").fetch("/-/test-stream-state").then((r) => r.json()).then((s) => s.disconnected > disconnected),
      before.disconnected,
      { timeout: 10000 },
    );
    const after = await state();
    assert.ok(after.sent - before.sent < 20, `stopped sending, but sent ${after.sent - before.sent} more`);
  });

  await page.context().close();
});

test("nothing was requested from another host", () => {
  assert.deepEqual(external, []);
});

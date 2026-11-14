import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startDatasette } from "../dist/node.js";
import { buildWheel } from "./wheel.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const STREAM_PLUGIN = fileURLToPath(new URL("../../tests/plugins/datasette_lite_test_stream.py", import.meta.url));
const GENERATED = fileURLToPath(new URL("./pages/generated/", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Nothing here may use the network: the bundle has to be self-contained
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (url) => {
    if (new URL(url).hostname == "127.0.0.1") return realFetch(url);
    throw new Error(`Unexpected network request: ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

test("imports inline SQL, CSV and JSON, and answers queries", async () => {
  const ds = await startDatasette({
    sql: [{ text: "create table notes (id integer primary key, body text); insert into notes (body) values ('hi');" }],
    csv: [{ text: "name,legs\ncat,4\nbird,2", table: "animals" }, { text: "a;b\n1;2", table: "semicolons" }],
    json: [{ text: '{"x": {"n": 1}, "y": {"n": 2}}', table: "keyed" }],
    metadata: { title: "From Node" },
  });
  assert.deepEqual(await ds.query("select sum(legs) as legs from animals"), [{ legs: 6 }]);
  // Column types are detected, as in the hosted Datasette Lite
  assert.deepEqual(await ds.query("select typeof(legs) as t from animals limit 1"), [{ t: "integer" }]);
  assert.deepEqual(await ds.query("select a, b from semicolons"), [{ a: 1, b: 2 }]);
  assert.deepEqual(await ds.query("select _key, n from keyed order by _key"), [{ _key: "x", n: 1 }, { _key: "y", n: 2 }]);
  assert.deepEqual(await ds.query("select body from notes"), [{ body: "hi" }]);
  assert.deepEqual(await ds.query("select :a + 1 as b", { params: { a: "41" } }), [{ b: 42 }]);
  await assert.rejects(ds.query("select * from nope"), /no such table/);

  const home = await ds.fetch("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /From Node/);
  const versions = await (await ds.fetch("/-/versions.json")).json();
  assert.equal(versions.datasette.version, ds.manifest.datasette);
  // Pyodide has no OpenSSL, so hashlib.pbkdf2_hmac is our pure Python one:
  // check it against the known answer for this input
  assert.equal(
    ds.pyodide.runPython('import hashlib; hashlib.pbkdf2_hmac("sha256", b"password", b"salt", 4096, 32).hex()'),
    "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
  );
  // Static assets come out of the wheel
  assert.equal((await ds.fetch("/-/static/app.css")).status, 200);
});

test("adds data to a running Datasette and reads the database back", async () => {
  const ds = await startDatasette({ databases: [path.join(DIST, "demo.db")] });
  assert.equal((await ds.query("select count(*) as n from plants"))[0].n, 10);
  assert.deepEqual(
    await ds.add({ type: "csv", text: "day,mm\nMon,3\nTue,0", table: "rain" }),
    { database: "data", table: "rain" },
  );
  assert.deepEqual(await ds.query("select sum(mm) as mm from rain", { database: "data" }), [{ mm: 3 }]);
  // A second database, from bytes
  const added = await ds.add({ type: "database", name: "copy", data: ds.readDatabase("demo") });
  assert.deepEqual(added, { database: "copy", table: null });
  assert.equal((await ds.query("select count(*) as n from gardens", { database: "copy" }))[0].n, 3);
  assert.equal(Buffer.from(ds.readDatabase("data")).subarray(0, 15).toString(), "SQLite format 3");
});

test("serves over HTTP and writes through to a mounted database file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "datasette-lite-"));
  const file = path.join(directory, "garden.db");
  await fs.copyFile(path.join(DIST, "demo.db"), file);
  const ds = await startDatasette({ databases: [file], mount: true, root: true });
  const server = await ds.serve({ port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await realFetch(`${origin}/garden/plants`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Meyer lemon/);

    // root was signed in at startup, so the write API is allowed
    const insert = await realFetch(`${origin}/garden/plants/-/insert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row: { common_name: "Kale", height_cm: 50 } }),
    });
    assert.equal(insert.status, 201, await insert.text());
  } finally {
    server.close();
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare("select count(*) as n from plants where common_name = 'Kale'").get().n, 1);
  db.close();
  await fs.rm(directory, { recursive: true });
});

test("streams a response as it is produced, and passes on a disconnect", async () => {
  // The hosted site's test plugin: /-/test-stream sends server-sent events
  // some time apart, /-/test-stream-state says what it has seen
  const wheel = await buildWheel(GENERATED, "datasette-lite-test-stream", STREAM_PLUGIN);
  const ds = await startDatasette({ install: [wheel] });
  const state = async () => (await ds.fetch("/-/test-stream-state")).json();

  await test("ds.fetch() returns before the response is complete", async () => {
    const response = await ds.fetch("/-/test-stream?n=3&delay=0.3");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    // The headers are here, and the stream has two more events to send
    assert.equal((await state()).finished, 0);
    const reader = response.body.getReader();
    const pieces = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(new TextDecoder().decode(value));
    }
    assert.deepEqual(pieces, ["data: tick 0\n\n", "data: tick 1\n\n", "data: tick 2\n\n"]);
    assert.deepEqual(await state(), { started: 1, sent: 3, finished: 1, disconnected: 0 });
  });

  await test("cancelling the body tells Datasette the client has gone", async () => {
    const response = await ds.fetch("/-/test-stream?n=50&delay=0.1");
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(400);
    const after = await state();
    assert.equal(after.disconnected, 1);
    assert.ok(after.sent < 3 + 10, `stopped sending, but sent ${after.sent}`);
  });

  await test("the HTTP server streams too, and notices a dropped connection", async () => {
    const server = await ds.serve({ port: 0 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const before = await state();
      const started = Date.now();
      const response = await realFetch(`${origin}/-/test-stream?n=3&delay=0.3`);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), "data: tick 0\n\n");
      // The first event arrived long before the 0.9 seconds the stream takes
      assert.ok(Date.now() - started < 500, `first event took ${Date.now() - started}ms`);
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      assert.equal(rest, "data: tick 1\n\ndata: tick 2\n\n");

      const abort = new AbortController();
      const dropped = await realFetch(`${origin}/-/test-stream?n=50&delay=0.1`, { signal: abort.signal });
      await dropped.body.getReader().read();
      abort.abort();
      await sleep(500);
      assert.equal((await state()).disconnected, before.disconnected + 1);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

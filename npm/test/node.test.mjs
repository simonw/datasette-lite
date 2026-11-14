import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startDatasette } from "../dist/node.js";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

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

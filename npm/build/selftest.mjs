// Run by build.mjs once dist/ is written: start Datasette from dist/ with
// fetch() disabled, make real requests, and save the demo database.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [expectedVersion, dist] = process.argv.slice(2);

globalThis.fetch = (url) => {
  throw new Error(`The bundle tried to fetch ${url} - it is not self-contained`);
};

const { startDatasette } = await import(pathToFileURL(path.join(dist, "node.js")));
const ds = await startDatasette({
  sql: [{ text: await fs.readFile(path.join(ROOT, "src", "demo.sql"), "utf8"), database: "demo" }],
});
const rows = await ds.query("select count(*) as n from plants");
if (!(rows[0].n > 0)) {
  throw new Error(`Self-test: unexpected query result ${JSON.stringify(rows)}`);
}
const versions = await (await ds.fetch("/-/versions.json")).json();
if (versions.datasette.version != expectedVersion) {
  throw new Error(`Self-test: Datasette ${versions.datasette.version}, expected ${expectedVersion}`);
}
const page = await ds.fetch("/demo/plants");
if (page.status != 200 || !(await page.text()).includes("Meyer lemon")) {
  throw new Error("Self-test: the table page did not render");
}
await fs.writeFile(path.join(dist, "demo.db"), ds.readDatabase("demo"));

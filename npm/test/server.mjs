// A static server for the tests: the built package at /vendor/datasette-lite/
// and test/pages/ at /pages/ - deliberately not the same directory, since the
// page that embeds Datasette is normally outside the package's files.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOUNTS = {
  "/vendor/datasette-lite/": path.join(ROOT, "dist"),
  "/pages/": path.join(ROOT, "test", "pages"),
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURI(new URL(req.url, "http://localhost").pathname);
    const mount = Object.keys(MOUNTS).find((prefix) => pathname.startsWith(prefix));
    try {
      if (!mount) throw new Error("Not found");
      const file = path.join(MOUNTS[mount], pathname.slice(mount.length));
      if (!file.startsWith(MOUNTS[mount])) throw new Error("Not found");
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        // Lets the other test server play the part of a CDN
        "access-control-allow-origin": "*",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

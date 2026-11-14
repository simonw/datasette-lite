// node.js - Datasette in Node, with no Python installed.
//
//   import { startDatasette } from "datasette-lite/node";
//   const ds = await startDatasette({ databases: ["trees.db"] });
//   const rows = await ds.query("select count(*) from trees");
//   const server = await ds.serve({ port: 8001 });

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "./pyodide/pyodide.mjs";
import { boot, queryRows, MANIFEST } from "./core.js";

export { MANIFEST };

const isUrl = (value) => /^(https?|data|blob):/.test(value);

async function readUrl(url) {
  if (!isUrl(url)) {
    return fs.readFile(url.startsWith("file:") ? fileURLToPath(url) : url);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * Options are the same as in the browser, except that URLs can be file paths
 * and that {mount: true} opens database files where they are on disk, so
 * changes made through Datasette are written to the real file.
 */
export async function startDatasette(options = {}) {
  const mounted = [];
  const databases = [];
  for (const source of options.databases || []) {
    const file = typeof source == "string" ? source : source.url;
    if (options.mount && file && !isUrl(file)) mounted.push(path.resolve(file));
    else databases.push(source);
  }
  const runtime = await boot(
    {
      loadPyodide,
      indexURL: fileURLToPath(new URL("./pyodide/", import.meta.url)),
      readUrl,
      log: options.log,
      prepare(pyodide) {
        // One NODEFS mount per directory: SQLite needs the directory too,
        // for its journal files
        const directories = [...new Set(mounted.map((file) => path.dirname(file)))];
        directories.forEach((directory, index) => {
          pyodide.FS.mkdirTree(`/mnt/${index}`);
          pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: directory }, `/mnt/${index}`);
        });
        return mounted.map((file) => ({
          name: path.basename(file).replace(/\.[^.]*$/, ""),
          path: `/mnt/${directories.indexOf(path.dirname(file))}/${path.basename(file)}`,
          in_place: true,
        }));
      },
    },
    { ...options, databases },
  );

  const ds = {
    manifest: MANIFEST,
    /** The Pyodide instance, for running Python of your own */
    pyodide: runtime.pyodide,
    request: runtime.request,
    cancel: runtime.cancel,
    add: runtime.add,
    readDatabase: runtime.readDatabase,

    /**
     * fetch() against Datasette: ds.fetch("/db/table.json?_size=5"). A
     * response Datasette sends in pieces - server-sent events, a streaming
     * CSV export - is returned as soon as it starts, and its body can be read
     * as it arrives.
     */
    async fetch(input, init = {}) {
      const request = new Request(new URL(input, "http://localhost"), init);
      const hasBody = !["GET", "HEAD"].includes(request.method);
      const body = hasBody ? await request.arrayBuffer() : null;
      return new Promise((resolve, reject) => {
        let controller = null;
        let cancelled = false;
        const stream = {
          onStart(status, headers) {
            const readable = new ReadableStream({
              start(streamController) {
                controller = streamController;
              },
              // The caller stopped reading: tell Datasette the client has gone
              cancel() {
                cancelled = true;
                runtime.cancel(stream.id);
              },
            });
            resolve(new Response(readable, { status, headers }));
          },
          onChunk(chunk) {
            if (!cancelled) controller.enqueue(chunk);
          },
        };
        runtime
          .request({ method: request.method, url: request.url, headers: [...request.headers.entries()], body }, stream)
          .then((response) => {
            if (response.streamed) {
              if (!cancelled) controller.close();
            } else {
              resolve(new Response(NULL_BODY.has(response.status) ? null : response.body, {
                status: response.status,
                headers: response.headers,
              }));
            }
          }, (error) => {
            if (!controller) reject(error);
            else if (!cancelled) controller.error(error);
          });
      });
    },

    /** Run a SQL query, returning a list of objects */
    async query(sql, options) {
      return queryRows(ds.fetch, sql, options);
    },

    /** Serve Datasette over real HTTP. Resolves to the http.Server. */
    serve({ port = 8001, host = "127.0.0.1" } = {}) {
      const server = http.createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const headers = [];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
          }
          const writeHead = (status, responseHeaders) => {
            const out = {};
            for (const [name, value] of responseHeaders) {
              const key = name.toLowerCase();
              out[key] = key in out ? [].concat(out[key], value) : value;
            }
            res.writeHead(status, out);
          };
          // A response sent in pieces is written as it is produced
          const stream = {
            onStart: writeHead,
            onChunk: (chunk) => res.write(chunk),
          };
          // The client went away before the response finished
          res.on("close", () => {
            if (!res.writableEnded && stream.id) runtime.cancel(stream.id);
          });
          const response = await runtime.request({
            method: req.method,
            url: `http://${req.headers.host || "localhost"}${req.url}`,
            headers,
            body: chunks.length ? Buffer.concat(chunks) : null,
          }, stream);
          if (response.streamed) {
            res.end();
          } else {
            writeHead(response.status, response.headers);
            res.end(Buffer.from(response.body));
          }
        } catch (error) {
          if (res.headersSent) {
            // Part of a streamed response has gone: all that is left is to break it off
            res.destroy();
            return;
          }
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("datasette-lite error: " + ((error && error.message) || error));
        }
      });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
      });
    },
  };
  return ds;
}

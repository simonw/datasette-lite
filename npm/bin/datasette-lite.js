#!/usr/bin/env node
// The datasette-lite command. Run "datasette-lite help" for usage.

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const USAGE = `datasette-lite - Datasette, Python included, from npm

  datasette-lite serve [files...]     Run Datasette in Node and serve it over HTTP.
                                      No Python needed. Database files are opened
                                      in place, so changes are saved to them.
  datasette-lite browser [files...]   Serve a page that runs Datasette inside the
                                      browser tab, with these files loaded.
  datasette-lite copy-assets <dir>    Copy the browser files (JavaScript, service
                                      worker, Pyodide, wheels) into your site.
  datasette-lite info                 Show what is in the bundle.

Files can be SQLite databases, .csv, .json or .sql.

Options for serve and browser:
  -p, --port PORT       Port to listen on (default 8001)
  -h, --host HOST       Host to listen on (default 127.0.0.1)
  -m, --metadata FILE   Metadata JSON or YAML
  -c, --config FILE     datasette.yaml
  --install PLUGIN      Plugin to load (repeatable)
  --root                Sign in as the root user
`;

function parse(argv) {
  const options = { files: [], port: 8001, host: "127.0.0.1", install: [], root: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg == "-p" || arg == "--port") options.port = parseInt(argv[++i], 10);
    else if (arg == "-h" || arg == "--host") options.host = argv[++i];
    else if (arg == "-m" || arg == "--metadata") options.metadata = argv[++i];
    else if (arg == "-c" || arg == "--config") options.config = argv[++i];
    else if (arg == "--install") options.install.push(argv[++i]);
    else if (arg == "--root") options.root = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

const IMPORTS = { ".csv": "csv", ".json": "json", ".ndjson": "json", ".jsonl": "json", ".sql": "sql" };

// {databases: [...], csv: [...], json: [...], sql: [...]} from a list of files
function sources(files) {
  const result = { databases: [], csv: [], json: [], sql: [] };
  for (const file of files) {
    result[IMPORTS[path.extname(file).toLowerCase()] || "databases"].push(file);
  }
  return result;
}

async function serve(options) {
  const { startDatasette } = await import("../dist/node.js");
  const ds = await startDatasette({
    ...sources(options.files),
    mount: true,
    metadata: options.metadata,
    config: options.config,
    install: options.install,
    root: options.root,
    log: (line) => console.error(line),
  });
  await ds.serve({ port: options.port, host: options.host });
  console.error(`Datasette ${ds.manifest.datasette} at http://${options.host}:${options.port}/`);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".whl": "application/zip",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".sql": "application/sql",
};
const escapeAttribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

async function browser(options) {
  // The package's files are at /, the user's files at /files/<n>/<name>
  const grouped = sources(options.files);
  const urls = new Map(options.files.map((file, index) => [file, `/files/${index}/${path.basename(file)}`]));
  const attribute = (name, files) =>
    files.length ? ` ${name}="${escapeAttribute(files.map((file) => encodeURI(urls.get(file))).join(" "))}"` : "";
  if (options.metadata) urls.set(options.metadata, "/files/metadata/" + path.basename(options.metadata));
  if (options.config) urls.set(options.config, "/files/config/" + path.basename(options.config));
  const page = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Datasette</title>
<style>html, body { margin: 0; height: 100%; } datasette-lite { height: 100%; border: 0; }</style>
<script type="module" src="/datasette-lite.js"></script>
</head>
<body>
<datasette-lite hash drop${attribute("src", grouped.databases)}${attribute("csv", grouped.csv)}${attribute("json", grouped.json)}${attribute("sql", grouped.sql)}${
    options.metadata ? ` metadata="${escapeAttribute(urls.get(options.metadata))}"` : ""}${
    options.config ? ` config="${escapeAttribute(urls.get(options.config))}"` : ""}${
    options.install.length ? ` install="${escapeAttribute(options.install.join(" "))}"` : ""}${
    options.root ? " root" : ""}></datasette-lite>
</body>
</html>
`;
  const served = new Map([...urls].map(([file, url]) => [url, path.resolve(file)]));
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURI(new URL(req.url, "http://localhost").pathname);
    try {
      if (pathname == "/") {
        res.writeHead(200, { "content-type": TYPES[".html"] });
        res.end(page);
        return;
      }
      let file = served.get(pathname);
      if (!file) {
        file = path.join(DIST, pathname);
        if (!file.startsWith(DIST)) throw new Error("Outside the package");
      }
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  });
  server.listen(options.port, options.host, () => {
    console.error(`Datasette will start in your browser at http://${options.host}:${options.port}/`);
  });
}

async function copyAssets(target) {
  if (!target) throw new Error("Usage: datasette-lite copy-assets <dir>");
  await fs.cp(DIST, target, {
    recursive: true,
    // Only needed in Node, and by the demo page
    filter: (source) => !["node.js", "index.html", "demo.db"].includes(path.relative(DIST, source)),
  });
  console.error(`Copied to ${target} - load ${path.join(target, "datasette-lite.js")} as a module script`);
}

async function info() {
  const manifest = JSON.parse(await fs.readFile(path.join(DIST, "manifest.json"), "utf8"));
  console.log(`Datasette ${manifest.datasette}, Python ${manifest.python}, Pyodide ${manifest.pyodide}`);
  for (const [name, version] of Object.entries(manifest.packages)) {
    console.log(`  ${name} ${version}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command == "serve") await serve(parse(rest));
  else if (command == "browser") await browser(parse(rest));
  else if (command == "copy-assets") await copyAssets(rest[0]);
  else if (command == "info") await info();
  else {
    console.log(USAGE);
    process.exitCode = command && command != "help" && command != "--help" ? 1 : 0;
  }
} catch (error) {
  console.error("Error: " + ((error && error.message) || error));
  process.exitCode = 1;
}

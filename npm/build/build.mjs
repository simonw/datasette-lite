#!/usr/bin/env node
// Builds dist/: everything Datasette Lite needs at run time, with no network.
//
//   node build/build.mjs [--datasette 1.0a42] [--stable] [--install PACKAGE]...
//                        [--exclude PACKAGE]... [--out DIR]
//
// --install adds a plugin to the bundle, so install="..." works offline.
// --exclude leaves a resolved package out (pip, say: Datasette depends on it
// for "datasette install", which can never work here).
//
// How it works:
//
// 1. Start Pyodide *in Node* and let micropip resolve and install Datasette
//    exactly as the hosted Datasette Lite does in the browser - same resolver,
//    same platform tags, so whatever it picks is known to install in Pyodide.
// 2. Read back what was installed and write a new pyodide-lock.json that
//    describes exactly that set: the Pyodide-built packages that were used
//    (sqlite3, ssl, PyYAML, MarkupSafe...) plus every wheel that came from
//    PyPI, each pinned by sha256 and pointing at a file next to the lock.
// 3. Copy those files, the Pyodide runtime and our own JavaScript into dist/.
// 4. Start a second Pyodide from dist/ with fetch() disabled and make a real
//    request to Datasette, to prove the bundle is complete.
//
// At run time nothing is resolved: pyodide.loadPackage("datasette") reads the
// lock file and loads local wheels. micropip is only used for extra plugins.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");
const require = createRequire(import.meta.url);
const PYODIDE_DIR = path.dirname(require.resolve("pyodide/package.json"));

// --- Options -----------------------------------------------------------------

const options = { datasette: null, stable: false, install: [], exclude: [], out: path.join(ROOT, "dist") };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] == "--datasette") options.datasette = argv[++i];
  else if (argv[i] == "--stable") options.stable = true;
  else if (argv[i] == "--install") options.install.push(argv[++i]);
  else if (argv[i] == "--exclude") options.exclude.push(argv[++i]);
  else if (argv[i] == "--out") options.out = path.resolve(argv[++i]);
  else throw new Error(`Unknown option ${argv[i]}`);
}

// What the hosted Datasette Lite installs, in the same order (see STARTUP_PY
// in ../webworker.js for why each pin is there)
const requirements = [
  "idna>=3.18",
  "python-multipart==0.0.15",
  "typing-extensions>=4.12.2",
  options.datasette ? `datasette==${options.datasette}` : "datasette",
  // Datasette 1.0 depends on this already; 0.x needs it for CSV/JSON import
  "sqlite-utils",
  ...options.install,
];
// Loaded from the Pyodide distribution before anything is resolved. The
// cpython_module ones are parts of the standard library that Pyodide ships
// separately ("fullStdLib"), minus the CPython test suite.
const PYODIDE_PACKAGES = [
  "micropip", "setuptools", "ssl", "sqlite3", "hashlib", "lzma", "pydecimal",
];

const DIST = options.out;
const log = (line) => console.log(line);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- 1. Resolve --------------------------------------------------------------

const { loadPyodide, version: pyodideVersion } = await import(
  pathToFileURL(path.join(PYODIDE_DIR, "pyodide.mjs"))
);
const cacheDir = path.join(ROOT, ".cache", `pyodide-${pyodideVersion}`);
await fs.mkdir(cacheDir, { recursive: true });

log(`Pyodide ${pyodideVersion}: resolving ${requirements.join(", ")}`);
const quiet = { messageCallback() {}, errorCallback: console.error };
// Pyodide prints a line for every package it has to fetch from its CDN
const consoleLog = console.log;
console.log = () => {};
let resolver, installed;
try {
  resolver = await loadPyodide({ packageCacheDir: cacheDir });
  await resolver.loadPackage(PYODIDE_PACKAGES, quiet);
  resolver.globals.set("requirements_json", JSON.stringify(requirements));
  resolver.globals.set("pre", !options.stable && !options.datasette);
  installed = JSON.parse(
    await resolver.runPythonAsync(await fs.readFile(path.join(ROOT, "build", "resolve.py"), "utf8")),
  );
} finally {
  console.log = consoleLog;
}

// --- 2. A lock file for exactly what was installed -----------------------------

const upstreamLock = JSON.parse(await fs.readFile(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8"));
const canonical = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const upstreamByName = new Map(
  Object.entries(upstreamLock.packages).map(([key, entry]) => [canonical(entry.name), { key, entry }]),
);

const packages = {};
const files = []; // {fileName, from: path | url, sha256}
const excluded = new Set(options.exclude.map(canonical));
const fromPypi = installed.filter((dist) => dist.url && !excluded.has(canonical(dist.name)));
const pypiNames = new Set(fromPypi.map((dist) => canonical(dist.name)));

// Pyodide's own packages: everything that got loaded, unless PyPI replaced it.
// micropip prefers a Pyodide build when its version satisfies the requirement,
// then installs a newer wheel from PyPI on top if a later requirement needs
// one - click, for example. Only the PyPI wheel is kept in that case.
for (const name of Object.keys(resolver.loadedPackages)) {
  if (resolver.loadedPackages[name] != "default channel") continue;
  const upstream = upstreamByName.get(canonical(name));
  if (!upstream) throw new Error(`${name} is not in pyodide-lock.json`);
  if (pypiNames.has(canonical(name)) || excluded.has(canonical(name))) continue;
  packages[upstream.key] = upstream.entry;
  files.push({
    fileName: upstream.entry.file_name,
    from: path.join(cacheDir, upstream.entry.file_name),
    sha256: upstream.entry.sha256,
  });
}
for (const dist of fromPypi) {
  const fileName = decodeURIComponent(new URL(dist.url).pathname.split("/").pop());
  packages[canonical(dist.name)] = {
    name: dist.name,
    version: dist.version,
    file_name: fileName,
    install_dir: "site",
    sha256: dist.sha256,
    package_type: "package",
    imports: dist.imports,
    depends: dist.requires,
    unvendored_tests: false,
  };
  files.push({ fileName, from: dist.url, sha256: dist.sha256 });
}
// Dependencies are only kept if they are part of the bundle (extras, platform
// markers and so on have already been evaluated by resolve.py)
for (const entry of Object.values(packages)) {
  entry.depends = [...new Set(entry.depends.map(canonical))]
    .map((name) => Object.keys(packages).find((key) => canonical(packages[key].name) == name))
    .filter(Boolean);
}
const lock = { info: upstreamLock.info, packages };

// --- 3. Write dist/ ----------------------------------------------------------

await fs.rm(DIST, { recursive: true, force: true });
const distPyodide = path.join(DIST, "pyodide");
await fs.mkdir(distPyodide, { recursive: true });

for (const name of ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"]) {
  await fs.copyFile(path.join(PYODIDE_DIR, name), path.join(distPyodide, name));
}
await Promise.all(files.map(async (file) => {
  let bytes;
  if (/^https?:/.test(file.from)) {
    const cached = path.join(cacheDir, file.fileName);
    bytes = await fs.readFile(cached).catch(() => null);
    if (!bytes) {
      const response = await fetch(file.from);
      if (!response.ok) throw new Error(`${file.from}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(cached, bytes);
    }
  } else {
    bytes = await fs.readFile(file.from);
  }
  if (sha256(bytes) != file.sha256) throw new Error(`${file.fileName}: sha256 mismatch`);
  file.size = bytes.length;
  await fs.writeFile(path.join(distPyodide, file.fileName), bytes);
}));
await fs.writeFile(path.join(distPyodide, "pyodide-lock.json"), JSON.stringify(lock));

// The ASGI bridge and cookie jar are the ones the hosted site runs: they are
// cut out of ../webworker.js, between its PYTHON-BEGIN/PYTHON-END markers
const webworker = await fs.readFile(path.join(REPO, "webworker.js"), "utf8");
const bridge = /\/\/ PYTHON-BEGIN bridge\n.*?String\.raw`\n(.*?)`;\n\/\/ PYTHON-END bridge/s.exec(webworker);
if (!bridge) throw new Error("Could not find the bridge Python in ../webworker.js");
const runtimePy = await fs.readFile(path.join(ROOT, "src", "runtime.py"), "utf8");

const datasetteVersion = packages.datasette.version;
const manifest = {
  datasette: datasetteVersion,
  pyodide: pyodideVersion,
  python: upstreamLock.info.python,
  // Loaded at startup. micropip and its dependencies are in the bundle too,
  // but only loaded if a plugin has to be installed from PyPI
  load: ["datasette", "sqlite-utils", "ssl", "sqlite3", "setuptools", "hashlib", "lzma", "pydecimal"]
    .concat(options.install.map((spec) => canonical(spec.split(/[=<>!~ \[]/)[0])))
    .filter((name) => packages[name]),
  packages: Object.fromEntries(
    Object.entries(packages).map(([key, entry]) => [key, entry.version]).sort(),
  ),
};
await fs.writeFile(
  path.join(DIST, "python.js"),
  "// Generated by build/build.mjs - do not edit\n" +
    `export const BRIDGE_PY = ${JSON.stringify(bridge[1])};\n` +
    `export const RUNTIME_PY = ${JSON.stringify(runtimePy)};\n` +
    `export const MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`,
);
await fs.writeFile(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const name of ["core.js", "worker.js", "datasette-lite.js", "node.js", "datasette-lite.d.ts"]) {
  await fs.copyFile(path.join(ROOT, "src", name), path.join(DIST, name));
}
// The service worker is the hosted site's, unchanged
await fs.copyFile(path.join(REPO, "sw.js"), path.join(DIST, "sw.js"));
await fs.copyFile(path.join(ROOT, "src", "demo.html"), path.join(DIST, "index.html"));

// pyodide.asm.js is CommonJS. Without this Node would read it as an ES module
// whenever the nearest package.json above it says "type": "module".
await fs.writeFile(path.join(distPyodide, "package.json"), '{"type": "commonjs"}\n');

// --- 4. Prove it works offline -------------------------------------------------

// In a new process, so nothing loaded above can stand in for a missing file.
// It also writes dist/demo.db, the example database for the demo page.
const selfTest = spawnSync(process.execPath, [path.join(ROOT, "build", "selftest.mjs"), datasetteVersion, DIST], {
  stdio: "inherit",
});
if (selfTest.status !== 0) {
  throw new Error("The offline self-test failed");
}

// --- Report ------------------------------------------------------------------

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await fs.stat(full)).size;
  }
  return total;
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
const wheels = files.reduce((sum, file) => sum + file.size, 0);
log(`Datasette ${datasetteVersion} on Python ${upstreamLock.info.python} (Pyodide ${pyodideVersion})`);
log(`${files.length} packages, ${mb(wheels)} - ${fromPypi.length} wheels from PyPI, ${files.length - fromPypi.length} from Pyodide`);
log(`${path.relative(process.cwd(), DIST) || "."}/ is ${mb(await dirSize(DIST))} - offline self-test passed`);

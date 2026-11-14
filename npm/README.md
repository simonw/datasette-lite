# datasette-lite as an npm package (prototype)

An exploration of shipping Datasette Lite as a single npm package that contains
**everything** - the Pyodide runtime, the Python standard library, SQLite,
Datasette and every wheel it depends on - so that `npm install datasette-lite`
is all it takes to run Datasette with no network access at all.

It is a working prototype, not a published package (`"private": true`).

What is here:

- **A build step** that resolves Datasette's dependencies once, ahead of time, and writes a self-contained `dist/`.
- **`<datasette-lite>`**, a web component that shows the full Datasette UI on any page.
- **`DatasetteLite`**, a browser class for running Datasette without a UI: `await datasette.query(sql)`.
- **`datasette-lite/node`**, the same thing in Node - including a real HTTP server, with no Python installed.
- **A `datasette-lite` command**: `serve`, `browser`, `copy-assets`, `info`.

## Try it

```bash
cd npm
npm install
npm run build        # needs the network, once: about 12 seconds
npm run demo         # http://127.0.0.1:8001/ - Datasette in a browser tab
node bin/datasette-lite.js serve dist/demo.db --root   # Datasette served by Node
npm test             # needs Playwright and its Chromium to be resolvable
```

The build output:

```
Datasette 1.0a42 on Python 3.12.7 (Pyodide 0.27.2)
40 packages, 18.6 MB - 21 wheels from PyPI, 19 from Pyodide
dist/ is 31.8 MB - offline self-test passed
```

`npm pack` turns that into a **13.9 MB tarball with no dependencies**.

## The web component

Copy the package's files into your site, then load the module from there:

```bash
npx datasette-lite copy-assets public/datasette-lite
```

```html
<script type="module" src="/datasette-lite/datasette-lite.js"></script>

<datasette-lite src="/data/trees.db" path="/trees/street_trees" style="height: 40rem"></datasette-lite>
```

With a bundler, `import "datasette-lite"` and point the element at the copied
files with `assets="/datasette-lite/"` (checked with a Vite production build).

Data can be written straight into the page, so a single HTML file can be a
complete Datasette instance:

```html
<datasette-lite path="/data/animals">
  <script type="text/csv" data-table="animals">
name,legs
cat,4
bird,2
  </script>
  <script type="application/sql">
    create table notes (id integer primary key, body text);
  </script>
  <script type="application/json" data-table="colours">
    [{"name": "red", "hex": "#f00"}]
  </script>
  <script type="application/json" data-metadata>
    {"title": "My data"}
  </script>
</datasette-lite>
```

| Attribute | |
| --- | --- |
| `src` | SQLite database URLs, separated by spaces |
| `csv`, `json`, `sql` | URLs to import into the `data` database (`sql` scripts run first) |
| `metadata`, `config` | URL of a metadata file / `datasette.yaml` |
| `path` | The Datasette path to show. Setting it navigates. |
| `install` | Plugins. Ones built into the bundle load offline, others are fetched from PyPI. |
| `root` | Sign in as root, which enables Datasette's write UI and API |
| `memory` | Add the `_memory` database |
| `hash` | Mirror the path into the page's `#fragment`, so links can be shared and Back works |
| `drop` | Accept files dropped onto the element: `.db`, `.csv`, `.json`, `.sql` |
| `autoheight` | Grow to fit the page being shown instead of scrolling |
| `assets` | Where the package's files are, if not next to the module |

Inline `<script>` children: `text/csv`, `application/sql`, `application/json`
(with `data-table` / `data-database`), and `application/json` with
`data-metadata`, `data-config` or `data-settings`.

```js
const element = document.querySelector("datasette-lite");
await element.ready;
await element.query("select count(*) from animals");      // [{...}]
await element.fetch("/data/animals.json?_size=5");        // a Response
element.navigate("/data/animals?_sort=legs");
await element.addFile(file);                               // a File from an <input> or a drop
const bytes = await element.readDatabase("data");         // the SQLite file, changes included
element.addEventListener("datasette-navigate", (e) => console.log(e.detail.path, e.detail.title));
```

Events: `datasette-ready`, `datasette-error`, `datasette-log`,
`datasette-navigate`. Shadow parts for styling: `loading`, `error`, `frame`,
`drop`. Several elements can share a page; each is its own Datasette.

## Without a UI

```js
import { DatasetteLite } from "datasette-lite";

const datasette = await DatasetteLite.start({
  databases: ["/data/trees.db"],
  csv: [{ text: "name,legs\ncat,4", table: "animals" }],
});
const rows = await datasette.query("select * from animals", { database: "data" });
const response = await datasette.fetch("/trees/-/query.json?sql=select+1");
```

This mode needs no service worker, so unlike the element it also works when
the package is loaded from **another origin** (a CDN that sends CORS headers).

## In Node

```js
import { startDatasette } from "datasette-lite/node";

const ds = await startDatasette({ databases: ["trees.db"], mount: true, root: true });
await ds.query("select count(*) from street_trees");
const server = await ds.serve({ port: 8001 });   // a real Datasette, no Python installed
```

`mount: true` opens database files where they are (through Emscripten's
NODEFS), so writes made through Datasette land in the real file. Startup takes
about four seconds.

## How it works

```
build/build.mjs
  1. Pyodide, running in Node, lets micropip resolve and install Datasette
     - the same resolver, on the same platform, that the hosted site runs
       in your browser on every visit
  2. reads back what got installed and writes a new pyodide-lock.json for
     exactly that set, every file pinned by sha256
  3. copies the wheels + Pyodide runtime + our JavaScript into dist/
  4. starts Datasette from dist/ in a fresh process with fetch() disabled
     and makes real requests - the build fails if the bundle is incomplete

dist/
  datasette-lite.js   DatasetteLite + <datasette-lite>     (page)
  worker.js           module Web Worker                    (browser)
  node.js             startDatasette() + serve()           (Node)
  core.js             boots Pyodide + Datasette; shared by both
  python.js           the Python source + manifest, generated
  sw.js               ../sw.js, unchanged
  pyodide/            pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json, 40 wheels
```

At run time nothing is resolved. `pyodide.loadPackage("datasette")` reads the
generated lock file and loads local wheels; micropip is in the bundle but is
only loaded when `install` names a plugin that is not.

The ASGI bridge and cookie jar are cut out of `../webworker.js` at build time
and `sw.js` is copied as it is, so the request path - iframe, service worker,
page, worker, ASGI - is the one the hosted site already tests. What is new is
`src/runtime.py`: startup that never touches the network, because JavaScript
has already written every input into Pyodide's file system.

Build options:

```bash
node build/build.mjs --datasette 1.0a42           # pin a release
node build/build.mjs --stable                     # latest stable instead of latest pre-release
node build/build.mjs --install datasette-cluster-map   # bake a plugin into the bundle
node build/build.mjs --exclude pip --exclude setuptools  # leave packages out
node build/build.mjs --out some/dir
```

## What the prototype found

**It works, and the hard part was already done.** The service worker
architecture carries over to a component without changes to `sw.js`: the page
that hosts the element does not have to be inside the service worker's scope,
only the iframe does. So the package's files can live in `/datasette-lite/`
and be embedded from any page on the same origin.

**Resolving at build time is a real improvement over the hosted site**, not
just a packaging detail:

- Startup loads local files instead of holding a conversation with PyPI. In
  headless Chromium the demo page is interactive in about five seconds.
- The versions are fixed and reproducible, where the hosted site gets whatever
  PyPI has that day.
- It surfaced that the live resolution installs `click` twice - Pyodide's
  8.1.7, then 8.5.1 from PyPI on top of it. The generated lock keeps one.
- `micropip.freeze()` would have been the obvious way to write the lock file,
  but it crashes on exactly that duplicate, so `build/resolve.py` reads the
  installed distributions itself.

**Size.** 31.8 MB on disk, 13.9 MB as an npm tarball, roughly 25 MB over the
wire for a first browser load (the wheels are already compressed). The largest
pieces:

| | MB |
| --- | --- |
| `pyodide.asm.wasm` (CPython) | 9.6 |
| `pydantic_core` | 4.5 |
| `setuptools` | 2.9 |
| `python_stdlib.zip` | 2.3 |
| `openssl` | 1.9 |
| `pip` | 1.9 |
| `pydantic` | 1.6 |
| `sqlite3` | 1.4 |
| Datasette itself | 0.6 |

`--exclude pip --exclude setuptools --exclude hupper --exclude uvicorn` still
passes the self-test and takes 5 MB off. Datasette declares those as
dependencies but does not import them on this path. I left them in by default
because plugins may.

**Things that needed care**, each now handled:

- `pyodide.asm.js` is CommonJS. Inside a `"type": "module"` package Node
  refuses to load it, so the build writes a `package.json` into `dist/pyodide/`.
- `navigator.serviceWorker.ready` never resolves for a page outside the scope;
  the element waits for the registration's worker to activate instead.
- `sw.js` treats the first reply from a page as that page's answer, so one
  listener per page answers for all the elements on it.
- Pyodide 0.27.2 in Node cannot fetch missing packages from its CDN while
  `loadPyodide` is still running (its CDN URL is not set yet), so the build
  loads the extra standard library modules by name afterwards.
- A Node `Buffer` is a `Uint8Array` that Pyodide refuses to convert.

**Limits that are inherent**, rather than unfinished:

- The element needs the package's files on the **same origin** as the page.
  Service workers and Web Workers cannot be loaded cross-origin, so
  `<script src="https://cdn.../datasette-lite.js">` can run queries but cannot
  show the UI. `copy-assets` exists for this.
- It needs HTTP(S). A `file://` page cannot register a service worker.
- Each element is a separate Python interpreter, with its own startup time
  and memory. I have not measured the memory.
- Data lives in memory in the browser and is gone on reload (`readDatabase()`
  is the way out). In Node, `mount` makes it persistent.

**Not done, and what I would look at next:**

- **One source of truth.** The hosted site could be built from this package:
  `index.html` would become a page containing one `<datasette-lite hash>`.
  `?ref=` and arbitrary `?install=` would still need micropip, which is
  already in the bundle for that reason.
- **Parquet** is not supported offline. fastparquet needs pandas and numpy,
  about 25 MB more; it would fit as an optional second bundle.
- **`serve` shares one cookie jar** between all clients, because the bridge
  keeps cookies itself (a service worker cannot set them). Fine for a local
  tool; a real multi-user server would pass cookies through instead.
- **Faster startup.** Of the four seconds in Node, about 1.3 are Pyodide, 0.7
  unpacking wheels and 2 importing and starting Datasette. A memory snapshot
  taken at build time would skip most of that; Pyodide's snapshot support is
  still experimental.
- **Persistence in the browser**, by keeping databases in OPFS.
- **A newer Pyodide.** This uses 0.27.2 to match the hosted site. Current
  releases are numbered 314.x after the Python version they ship.
- Only checked in Chromium. Module workers and service workers are in Firefox
  and Safari too, but I have not run them.
- `dist/` is not committed (32 MB of binaries). Publishing would be
  `npm run build && npm publish` from CI, after dropping `"private"`.
- Hardcoded `/-/...` URLs that escape `base_url` are rewritten in HTML as on
  the hosted site, but the service worker fallback for ones added by plugin
  JavaScript only works when the package is served from the site root.

# datasette-lite as an npm package (prototype)

An exploration of shipping Datasette Lite as a single npm package that contains
**everything** - the Pyodide runtime, the Python standard library, SQLite,
Datasette and every wheel it depends on - so that `npm install datasette-lite`
is all it takes to run Datasette with no network access at all.

It is a working prototype, not a published package (`"private": true`).

It runs **Python 3.14** (Pyodide 314.0.8). The hosted site is still on
Python 3.12 (Pyodide 0.27.2), which is what this prototype used at first; see
"Python 3.14" below for what had to change.

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
npm run build        # needs the network, once: about 30 seconds
npm run demo         # http://127.0.0.1:8001/ - Datasette in a browser tab
node bin/datasette-lite.js serve dist/demo.db --root   # Datasette served by Node
npm test             # needs Playwright and its Chromium to be resolvable
```

The build output:

```
Datasette 1.0a42 on Python 3.14.2 (Pyodide 314.0.8)
29 packages in site-packages.tar.xz: 2.8 MB
1 wheels loaded on demand: 0.1 MB (micropip)
dist/ is 15.8 MB - offline self-test passed
```

`npm pack` turns that into a **9.5 MB tarball with no dependencies**.

## From a CDN

Once published, nothing has to be installed or copied. There are three ways
to use it from jsDelivr or unpkg, and which one applies is decided by what a
browser allows: a service worker can only be registered by a page on the
service worker's own origin.

**1. Queries, no UI - any CDN, nothing on your site.**

```html
<script type="module">
import { DatasetteLite } from "https://cdn.jsdelivr.net/npm/datasette-lite/dist/datasette-lite.js";
const datasette = await DatasetteLite.start({ databases: ["/data/trees.db"] });
console.log(await datasette.query("select count(*) from trees"));
</script>
```

**2. The full UI - unpkg, nothing on your site.**

```html
<script type="module" src="https://unpkg.com/datasette-lite/dist/datasette-lite.js"></script>
<datasette-lite src="/data/trees.db"></datasette-lite>
```

The element sees that the package is on another origin and embeds the
package's own `frame.html`. That page *is* on the CDN's origin, so it can
register the CDN's copy of the service worker, and the element talks to it
with `postMessage`. Your data files are read by your page and handed over as
bytes, so they need no CORS headers. `element.mode` is `"frame"`.

This needs a CDN that serves `.html` files as HTML. unpkg does. jsDelivr
serves them as `text/plain` and esm.sh sandboxes them, so there the element
reports an error that says to use option 3.

**3. The full UI - any CDN, one line on your site.**

```js
// /datasette-lite-sw.js
importScripts("https://cdn.jsdelivr.net/npm/datasette-lite@0.1.0/dist/sw.js");
```

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/datasette-lite@0.1.0/dist/datasette-lite.js"></script>
<datasette-lite src="/data/trees.db" service-worker="/datasette-lite-sw.js"></datasette-lite>
```

Datasette's pages are then on your own origin (under the directory that file
is in), with everything heavy still coming from the CDN. This is the same as
self-hosting in every way that matters: `autoheight` works, and there is no
third-party frame for a browser's privacy settings to object to.

A URL without a version is pinned by the module itself: loaded from
`.../npm/datasette-lite/dist/`, it fetches everything else from
`.../npm/datasette-lite@<its own version>/dist/`, so the worker, the lock
file and the packages can never come from a newer release than the code.

### Page weight

What a browser downloads to get from nothing to a rendered table (12
requests):

| | raw | jsDelivr | unpkg |
| --- | --- | --- | --- |
| `pyodide.asm.wasm` (CPython 3.14) | 9.60 | 3.44 | 3.53 |
| `site-packages.tar.xz` (Datasette + 28 packages) | 2.94 | 2.94 | 2.94 |
| `python_stdlib.zip` | 2.55 | 2.55 | 2.55 |
| `pyodide.asm.mjs` | 1.25 | 0.26 | 0.26 |
| our JavaScript, lock file, `frame.html`, `sw.js` | 0.10 | 0.04 | 0.04 |
| **Total, MB** | **16.4** | **9.2** | **9.3** |

The wasm, `pyodide.asm.mjs` and stdlib figures are what those CDNs return
for Pyodide 314.0.8 today. jsDelivr applies Brotli to JavaScript, WebAssembly
and unknown binary types; unpkg applies gzip to JavaScript and WebAssembly
only; neither touches a `.zip`.

On Python 3.12 the same table came to 9.0 MB (jsDelivr) and 10.1 MB (unpkg).
The archive is 1.2 MB smaller here, because `ssl`, `sqlite3`, `hashlib` and
OpenSSL are now part of the runtime instead of separate packages. On jsDelivr
that is cancelled out by the wasm: it serves the 0.27.2 file at 2.27 MB and
this slightly smaller one at 3.44 MB. I don't know why; it may compress
files harder once they are popular.

The figures in the rest of this section were measured on the Python 3.12
build and have not been repeated here.

That difference is why the packages are one archive. The first version of
this prototype shipped 37 separate wheels, which is the obvious design and
what the lock file format is for. It cost 12.9 MB from jsDelivr but **24.9 MB
from unpkg**, which serves wheels uncompressed. Compressing everything
together ourselves, with xz, is smaller than either CDN manages and costs the
same from anywhere. Python's own `lzma` module unpacks it in about a second.

`pip`, `uvicorn` and `hupper` are left out by default (`--full` keeps them):
Datasette depends on them for `datasette install` and `datasette serve`,
which cannot run inside Pyodide. That is worth 1.1 MB. `--exclude setuptools`
passes the self-test and saves another 0.5 MB; I kept it because older
plugins import `pkg_resources`.

Almost half of what is left is CPython itself. `python_stdlib.zip` would be
1.5 MB if it were recompressed as a whole rather than file by file, but
Pyodide needs it before Python (and so before `lzma`) exists.

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
| `service-worker` | A service worker file on your site that imports the package's `sw.js` - see "From a CDN" |

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

This mode needs no service worker, so it works from any CDN.

## In Node

```js
import { startDatasette } from "datasette-lite/node";

const ds = await startDatasette({ databases: ["trees.db"], mount: true, root: true });
await ds.query("select count(*) from street_trees");
const server = await ds.serve({ port: 8001 });   // a real Datasette, no Python installed
```

`mount: true` opens database files where they are (through Emscripten's
NODEFS), so writes made through Datasette land in the real file. Startup takes
about four and a half seconds.

## How it works

```
build/build.mjs
  1. Pyodide, running in Node, lets micropip resolve and install Datasette
     - the same resolver, on the same platform, that the hosted site runs
       in your browser on every visit
  2. reads back what got installed and writes a new pyodide-lock.json for
     exactly that set, every file pinned by sha256
  3. packs everything Datasette needs into one site-packages.tar.xz, laid
     out as installed; plugins and micropip stay as separate wheels
  4. starts Datasette from dist/ in a fresh process with fetch() disabled
     and makes real requests - the build fails if the bundle is incomplete

dist/
  datasette-lite.js   DatasetteLite + <datasette-lite>     (page)
  worker.js           module Web Worker                    (browser)
  frame.html          hosts the element when the package is on a CDN
  node.js             startDatasette() + serve()           (Node)
  core.js             boots Pyodide + Datasette; shared by both
  python.js           the Python source + manifest, generated
  sw.js               ../sw.js, unchanged
  pyodide/            pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, site-packages.tar.xz,
                      pyodide-lock.json + the wheels it lists
```

At run time nothing is resolved. The archive is unpacked into Pyodide's file
system and its shared libraries are loaded. `install="..."` loads a plugin
from the lock file if it was built in with `--install`, and only falls back
to micropip and PyPI if it was not.

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
node build/build.mjs --exclude setuptools         # leave a package out
node build/build.mjs --full                       # keep pip, uvicorn and hupper
node build/build.mjs --out some/dir
```

## Python 3.14

Datasette 1.0a42 and all of its dependencies run on Python 3.14.2 under
Pyodide 314.0.8: the build's offline self-test and all 13 Node and browser
tests pass, as does loading a plugin built into the bundle. Nothing in
Datasette or in the JavaScript had to change. What did, all in the build:

- **The standard library is whole again.** Pyodide 0.27 shipped `ssl`,
  `sqlite3`, `hashlib`, `lzma` and `decimal` as separate packages, and the
  build asked for them by name. They are built in now, so the build only asks
  for the ones the lock file lists. `lzma` being built in also means there is
  no wheel to load before the archive can be opened.
- **`micropip` no longer depends on `packaging`.** The build's resolver
  script uses `packaging`, so it is loaded explicitly.
- **The Emscripten glue is `pyodide.asm.mjs`**, an ES module, where it was
  `pyodide.asm.js`. The build copies whichever exists, and the CommonJS
  `package.json` workaround is only written for the old one.
- **Pyodide's CDN fallback in Node works** in this release, and reports
  through `stdout` rather than `console.log`.

The private `pyodide._api.loadDynlib` call that loads the archive's compiled
modules (`pydantic_core`, `PyYAML`, `MarkupSafe`) still works unchanged.

The build handles both Pyodide layouts, so going back to Python 3.12 is a
matter of setting the `pyodide` version in `package.json` to `0.27.2`. Python 3.15 exists only
as a Pyodide alpha (`315.0.0-alpha.2`) and I have not tried it.

## What the prototype found

**It works, and the hard part was already done.** The service worker
architecture carries over to a component without changes to `sw.js`: the page
that hosts the element does not have to be inside the service worker's scope,
only the iframe does. So the package's files can live in `/datasette-lite/`
and be embedded from any page on the same origin. `sw.js` also works unchanged
when a file on another site pulls it in with `importScripts`, because it
works out its scope from where it is running.

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

**Size** is covered under "Page weight" above: 15.8 MB on disk, 9.5 MB as
an npm tarball, a little over 9 MB over the wire.

**Things that needed care**, each now handled:

- On Pyodide 0.27 `pyodide.asm.js` is CommonJS. Inside a `"type": "module"`
  package Node refuses to load it, so the build writes a `package.json` into
  `dist/pyodide/`.
- `navigator.serviceWorker.ready` never resolves for a page outside the scope;
  the element waits for the registration's worker to activate instead.
- `sw.js` treats the first reply from a page as that page's answer, so one
  listener per page answers for all the elements on it.
- Pyodide 0.27.2 in Node cannot fetch missing packages from its CDN while
  `loadPyodide` is still running (its CDN URL is not set yet), so the build
  loads the extra standard library modules by name afterwards. (Not needed
  on Pyodide 314.)
- A Node `Buffer` is a `Uint8Array` that Pyodide refuses to convert.
- Unpacking an archive is not enough for packages with compiled modules
  (`_ssl`, `_sqlite3`, `pydantic_core`): Pyodide has to load each `.so` before
  Python imports it. The build records where they are and `core.js` loads
  them through `pyodide._api.loadDynlib`, which is a private API. The
  self-test would catch a Pyodide upgrade that changed it.

**Limits that are inherent**, rather than unfinished:

- A service worker has to be registered from its own origin. That is what
  the three CDN options above work around; none of them can be made to
  disappear.
- In frame mode Datasette is a third-party iframe. `autoheight` does not work
  there, and a browser set to block third-party storage may refuse the
  service worker. The tests run it as a genuine third party (`localhost`
  embedding `127.0.0.1`) in Chromium only.
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
- **Faster startup.** Of the four and a half seconds in Node, roughly one is
  Pyodide, one unpacking the archive and two importing and starting Datasette. A memory snapshot
  taken at build time would skip most of that; Pyodide's snapshot support is
  still experimental.
- **Persistence in the browser**, by keeping databases in OPFS.
- Only checked in Chromium. Module workers and service workers are in Firefox
  and Safari too, but I have not run them.
- **Nothing has been fetched from a real CDN**, since the package is not
  published. The CDN modes are tested against a second local origin that
  sends CORS headers, and the CDN behaviour they rely on was checked against
  other packages' files on jsDelivr and unpkg.
- `dist/` is not committed (16 MB of binaries). Publishing would be
  `npm run build && npm publish` from CI, after dropping `"private"`.
- Hardcoded `/-/...` URLs that escape `base_url` are rewritten in HTML as on
  the hosted site, but the service worker fallback for ones added by plugin
  JavaScript only works when the package is served from the site root.

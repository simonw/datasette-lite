importScripts("https://cdn.jsdelivr.net/pyodide/v0.20.0/full/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

// Extracted from https://github.com/emscripten-core/emscripten/blob/0c070488619cf556e4917cd88c0a868faf611c13/src/library_fs.js#L1675
// * Tuned chunk size to match SQLite default chunk size
// * Commented out emscripten build concerns
// * Allow emscripten FS to be injected in
function createLazyFileSqlite(parent, name, url, canRead, canWrite, FS) {
  // Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
  /** @constructor */
  function LazyUint8Array() {
    this.lengthKnown = false;
    this.chunks = []; // Loaded chunks. Index is the chunk number
  }
  LazyUint8Array.prototype.get = /** @this{Object} */ function LazyUint8Array_get(idx) {
    if (idx > this.length-1 || idx < 0) {
      return undefined;
    }
    var chunkOffset = idx % this.chunkSize;
    var chunkNum = (idx / this.chunkSize)|0;
    return this.getter(chunkNum)[chunkOffset];
  };
  LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
    this.getter = getter;
  };
  LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
    // Find length
    var xhr = new XMLHttpRequest();
    xhr.open('HEAD', url, false);
    xhr.send(null);
    if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    var datalength = Number(xhr.getResponseHeader("Content-length"));
    var header;
    var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
    var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";

// #if SMALL_XHR_CHUNKS
    // var chunkSize = 1024; // Chunk size in bytes
// Match default SQLite Page size
    var chunkSize = 4096 * 5; // Chunk size in bytes
// #else
//     var chunkSize = 1024*1024; // Chunk size in bytes
// #endif

    if (!hasByteServing) chunkSize = datalength;

    // Function to get a range from the remote URL.
    var doXHR = (function(from, to) {
      if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
      if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");

      // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

      // Some hints to the browser that we want binary data.
      if (typeof Uint8Array != 'undefined') xhr.responseType = 'arraybuffer';
      if (xhr.overrideMimeType) {
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
      }

      xhr.send(null);
      if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
      if (xhr.response !== undefined) {
        return new Uint8Array(/** @type{Array<number>} */(xhr.response || []));
      } else {
        return intArrayFromString(xhr.responseText || '', true);
      }
    });
    var lazyArray = this;
    lazyArray.setDataGetter(function(chunkNum) {
      var start = chunkNum * chunkSize;
      var end = (chunkNum+1) * chunkSize - 1; // including this byte
      end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
      if (typeof(lazyArray.chunks[chunkNum]) === "undefined") {
        lazyArray.chunks[chunkNum] = doXHR(start, end);
      }
      if (typeof(lazyArray.chunks[chunkNum]) === "undefined") throw new Error("doXHR failed!");
      return lazyArray.chunks[chunkNum];
    });

    if (usesGzip || !datalength) {
      // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
      chunkSize = datalength = 1; // this will force getter(0)/doXHR do download the whole file
      datalength = this.getter(0).length;
      chunkSize = datalength;
      out("LazyFiles on gzip forces download of the whole file when length is accessed");
    }

    this._length = datalength;
    this._chunkSize = chunkSize;
    this.lengthKnown = true;
  };
  if (typeof XMLHttpRequest !== 'undefined') {
    // if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
    var lazyArray = new LazyUint8Array();
    Object.defineProperties(lazyArray, {
      length: {
        get: /** @this{Object} */ function() {
          if (!this.lengthKnown) {
            this.cacheLength();
          }
          return this._length;
        }
      },
      chunkSize: {
        get: /** @this{Object} */ function() {
          if (!this.lengthKnown) {
            this.cacheLength();
          }
          return this._chunkSize;
        }
      }
    });

    var properties = { isDevice: false, contents: lazyArray };
  } else {
    var properties = { isDevice: false, url: url };
  }

  var node = FS.createFile(parent, name, properties, canRead, canWrite);
  // This is a total hack, but I want to get this lazy file code out of the
  // core of MEMFS. If we want to keep this lazy file concept I feel it should
  // be its own thin LAZYFS proxying calls to MEMFS.
  if (properties.contents) {
    node.contents = properties.contents;
  } else if (properties.url) {
    node.contents = null;
    node.url = properties.url;
  }
  // Add a function that defers querying the file size until it is asked the first time.
  Object.defineProperties(node, {
    usedBytes: {
      get: /** @this {FSNode} */ function() { return this.contents.length; }
    }
  });
  // override each stream op with one that tries to force load the lazy file first
  var stream_ops = {};
  var keys = Object.keys(node.stream_ops);
  keys.forEach(function(key) {
    var fn = node.stream_ops[key];
    stream_ops[key] = function forceLoadLazyFile() {
      FS.forceLoadFile(node);
      return fn.apply(null, arguments);
    };
  });
  // use a custom read function
  stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
    FS.forceLoadFile(node);
    var contents = stream.node.contents;
    if (position >= contents.length)
      return 0;
    var size = Math.min(contents.length - position, length);
// #if ASSERTIONS
//     assert(size >= 0);
// #endif
    if (contents.slice) { // normal array
      for (var i = 0; i < size; i++) {
        buffer[offset + i] = contents[position + i];
      }
    } else {
      for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
        buffer[offset + i] = contents.get(position + i);
      }
    }
    return size;
  };
  node.stream_ops = stream_ops;
  return node;
}

async function startDatasette(settings) {
  let toLoad = [];
  let toMount = [];
  let csvs = [];
  let sqls = [];
  let needsDataDb = false;
  let shouldLoadDefaults = true;
  if (settings.initialUrl) {
    let name = settings.initialUrl.split('.db')[0].split('/').slice(-1)[0];
    toMount.push([name, settings.initialUrl]);
    shouldLoadDefaults = false;
  }
  if (settings.csvUrls && settings.csvUrls.length) {
    csvs = settings.csvUrls;
    needsDataDb = true;
    shouldLoadDefaults = false;
  }
  if (settings.sqlUrls && settings.sqlUrls.length) {
    sqls = settings.sqlUrls;
    needsDataDb = true;
    shouldLoadDefaults = false;
  }
  if (needsDataDb) {
    toLoad.push(["data.db", 0]);
  }
  if (shouldLoadDefaults) {
    toMount.push(["fixtures.db", "https://latest.datasette.io/fixtures.db"]);
    toMount.push(["content.db", "https://datasette.io/content.db"]);
  }
  self.pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.20.0/full/"
  });

  for (let [name, url] of toMount) {
    createLazyFileSqlite('/home/pyodide', name, url, true, false, pyodide.FS)
  }

  await pyodide.loadPackage('micropip', log);
  await pyodide.loadPackage('ssl', log);
  await pyodide.loadPackage('setuptools', log); // For pkg_resources
  try {
    await self.pyodide.runPythonAsync(`
    # Grab that fixtures.db database
    import sqlite3
    from pyodide.http import pyfetch
    names = []
    for name, url in ${JSON.stringify(toLoad)}:
        if url:
            response = await pyfetch(url)
            with open(name, "wb") as fp:
                fp.write(await response.bytes())
        else:
            sqlite3.connect(name).execute("vacuum")
        names.append(name)
    for name, url in ${JSON.stringify(toMount)}:
      sqlite3.connect(f"file:{name}?mode=ro", uri=True)
      names.append(name)

    import micropip
    # Workaround for Requested 'h11<0.13,>=0.11', but h11==0.13.0 is already installed
    await micropip.install("h11==0.12.0")
    await micropip.install("datasette")
    # Install any extra ?install= dependencies
    install_urls = ${JSON.stringify(settings.installUrls)}
    if install_urls:
        for install_url in install_urls:
            await micropip.install(install_url)
    # Execute any ?sql=URL SQL
    sqls = ${JSON.stringify(sqls)}
    if sqls:
        for sql_url in sqls:
            # Fetch that SQL and execute it
            response = await pyfetch(sql_url)
            sql = await response.string()
            sqlite3.connect("data.db").executescript(sql)
    # Import data from ?csv=URL CSV files
    csvs = ${JSON.stringify(csvs)}
    if csvs:
        await micropip.install("sqlite-utils==3.28")
        import sqlite_utils
        from sqlite_utils.utils import rows_from_file, TypeTracker, Format
        db = sqlite_utils.Database("data.db")
        table_names = set()
        for csv_url in csvs:
            # Derive table name from CSV URL
            bit = csv_url.split("/")[-1].split(".")[0].split("?")[0]
            bit = bit.strip()
            if not bit:
                bit = "table"
            prefix = 0
            base_bit = bit
            while bit in table_names:
                prefix += 1
                bit = "{}_{}".format(base_bit, prefix)
            table_names.add(bit)
            tracker = TypeTracker()
            response = await pyfetch(csv_url)
            with open("csv.csv", "wb") as fp:
                fp.write(await response.bytes())
            db[bit].insert_all(
                tracker.wrap(rows_from_file(open("csv.csv", "rb"), Format.CSV)[0])
            )
            db[bit].transform(
                types=tracker.types
            )
    from datasette.app import Datasette
    ds = Datasette(names, settings={
        "num_sql_threads": 0,
        "sql_time_limit_ms": 1200000,
    }, metadata = {
        "about": "Datasette Lite",
        "about_url": "https://github.com/simonw/datasette-lite"
    })
    await ds.invoke_startup()
    `);
    datasetteLiteReady();
  } catch (error) {
    self.postMessage({error: error.message});
  }
}

// Outside promise pattern
// https://github.com/simonw/datasette-lite/issues/25#issuecomment-1116948381
let datasetteLiteReady;
let readyPromise = new Promise(function(resolve) {
  datasetteLiteReady = resolve;
});

self.onmessage = async (event) => {
  console.log({event, data: event.data});
  if (event.data.type == 'startup') {
    await startDatasette(event.data);
    return;
  }
  // make sure loading is done
  await readyPromise;
  console.log(event, event.data);
  try {
    let [status, contentType, text] = await self.pyodide.runPythonAsync(
      `
      import json
      response = await ds.client.get(
          ${JSON.stringify(event.data.path)},
          follow_redirects=True
      )
      [response.status_code, response.headers.get("content-type"), response.text]
      `
    );
    self.postMessage({status, contentType, text});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};

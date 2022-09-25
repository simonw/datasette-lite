importScripts("https://cdn.jsdelivr.net/pyodide/v0.20.0/full/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

// Extracted and adapted from https://github.com/phiresky/sql.js-httpvfs/blob/master/src/lazyFile.ts
// adapted from https://github.com/emscripten-core/emscripten/blob/cbc974264e0b0b3f0ce8020fb2f1861376c66545/src/library_fs.js
// flexible chunk size parameter
// Creates a file record for lazy-loading from a URL. XXX This requires a synchronous
// XHR, which is not possible in browsers except in a web worker!
class LazyUint8Array {
  constructor(config) {
      var _a, _b;
      this.serverChecked = false;
      this.chunks = []; // Loaded chunks. Index is the chunk number
      this.totalFetchedBytes = 0;
      this.totalRequests = 0;
      this.readPages = [];
      // LRU list of read heds, max length = maxReadHeads. first is most recently used
      this.readHeads = [];
      this.lastGet = -1;
      this._chunkSize = config.requestChunkSize;
      this.maxSpeed = Math.round((config.maxReadSpeed || 5 * 1024 * 1024) / this._chunkSize); // max 5MiB at once
      this.maxReadHeads = (_a = config.maxReadHeads) !== null && _a !== void 0 ? _a : 3;
      this.rangeMapper = config.rangeMapper;
      this.logPageReads = (_b = config.logPageReads) !== null && _b !== void 0 ? _b : false;
      if (config.fileLength) {
          this._length = config.fileLength;
      }
      this.requestLimiter = config.requestLimiter == null ? ((ignored) => { }) : config.requestLimiter;
  }
  /**
   * efficiently copy the range [start, start + length) from the http file into the
   * output buffer at position [outOffset, outOffest + length)
   * reads from cache or synchronously fetches via HTTP if needed
   */
  copyInto(buffer, outOffset, length, start) {
      if (start >= this.length)
          return 0;
      length = Math.min(this.length - start, length);
      const end = start + length;
      let i = 0;
      while (i < length) {
          // {idx: 24, chunkOffset: 24, chunkNum: 0, wantedSize: 16}
          const idx = start + i;
          const chunkOffset = idx % this.chunkSize;
          const chunkNum = (idx / this.chunkSize) | 0;
          const wantedSize = Math.min(this.chunkSize, end - idx);
          let inChunk = this.getChunk(chunkNum);
          if (chunkOffset !== 0 || wantedSize !== this.chunkSize) {
              inChunk = inChunk.subarray(chunkOffset, chunkOffset + wantedSize);
          }
          buffer.set(inChunk, outOffset + i);
          i += inChunk.length;
      }
      return length;
  }
  /* find the best matching existing read head to get the given chunk or create a new one */
  moveReadHead(wantedChunkNum) {
      for (const [i, head] of this.readHeads.entries()) {
          const fetchStartChunkNum = head.startChunk + head.speed;
          const newSpeed = Math.min(this.maxSpeed, head.speed * 2);
          const wantedIsInNextFetchOfHead = wantedChunkNum >= fetchStartChunkNum &&
              wantedChunkNum < fetchStartChunkNum + newSpeed;
          if (wantedIsInNextFetchOfHead) {
              head.speed = newSpeed;
              head.startChunk = fetchStartChunkNum;
              if (i !== 0) {
                  // move head to front
                  this.readHeads.splice(i, 1);
                  this.readHeads.unshift(head);
              }
              return head;
          }
      }
      const newHead = {
          startChunk: wantedChunkNum,
          speed: 1,
      };
      this.readHeads.unshift(newHead);
      while (this.readHeads.length > this.maxReadHeads)
          this.readHeads.pop();
      return newHead;
  }
  /** get the given chunk from cache or fetch it from remote */
  getChunk(wantedChunkNum) {
      let wasCached = true;
      if (typeof this.chunks[wantedChunkNum] === "undefined") {
          wasCached = false;
          // double the fetching chunk size if the wanted chunk would be within the next fetch request
          const head = this.moveReadHead(wantedChunkNum);
          const chunksToFetch = head.speed;
          const startByte = head.startChunk * this.chunkSize;
          let endByte = (head.startChunk + chunksToFetch) * this.chunkSize - 1; // including this byte
          endByte = Math.min(endByte, this.length - 1); // if datalength-1 is selected, this is the last block
          const buf = this.doXHR(startByte, endByte);
          for (let i = 0; i < chunksToFetch; i++) {
              const curChunk = head.startChunk + i;
              if (i * this.chunkSize >= buf.byteLength)
                  break; // past end of file
              const curSize = (i + 1) * this.chunkSize > buf.byteLength
                  ? buf.byteLength - i * this.chunkSize
                  : this.chunkSize;
              // console.log("constructing chunk", buf.byteLength, i * this.chunkSize, curSize);
              this.chunks[curChunk] = new Uint8Array(buf, i * this.chunkSize, curSize);
          }
      }
      if (typeof this.chunks[wantedChunkNum] === "undefined")
          throw new Error("doXHR failed (bug)!");
      const boring = !this.logPageReads || this.lastGet == wantedChunkNum;
      if (!boring) {
          this.lastGet = wantedChunkNum;
          this.readPages.push({
              pageno: wantedChunkNum,
              wasCached,
              prefetch: wasCached ? 0 : this.readHeads[0].speed - 1,
          });
      }
      return this.chunks[wantedChunkNum];
  }
  /** verify the server supports range requests and find out file length */
  checkServer() {
      var xhr = new XMLHttpRequest();
      const url = this.rangeMapper(0, 0).url;
      // can't set Accept-Encoding header :( https://stackoverflow.com/questions/41701849/cannot-modify-accept-encoding-with-fetch
      xhr.open("HEAD", url, false);
      // // maybe this will help it not use compression?
      // xhr.setRequestHeader("Range", "bytes=" + 0 + "-" + 1e12);
      xhr.send(null);
      if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
          throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
      var datalength = Number(xhr.getResponseHeader("Content-length"));
      var hasByteServing = xhr.getResponseHeader("Accept-Ranges") === "bytes";
      const encoding = xhr.getResponseHeader("Content-Encoding");
      var usesCompression = encoding && encoding !== "identity";
      if (!hasByteServing) {
          const msg = "Warning: The server did not respond with Accept-Ranges=bytes. It either does not support byte serving or does not advertise it (`Accept-Ranges: bytes` header missing), or your database is hosted on CORS and the server doesn't mark the accept-ranges header as exposed. This may lead to incorrect results.";
          console.warn(msg, "(seen response headers:", xhr.getAllResponseHeaders(), ")");
          // throw Error(msg);
      }
      if (usesCompression) {
          console.warn(`Warning: The server responded with ${encoding} encoding to a HEAD request. Ignoring since it may not do so for Range HTTP requests, but this will lead to incorrect results otherwise since the ranges will be based on the compressed data instead of the uncompressed data.`);
      }
      if (usesCompression) {
          // can't use the given data length if there's compression
          datalength = null;
      }
      if (!this._length) {
          if (!datalength) {
              console.error("response headers", xhr.getAllResponseHeaders());
              throw Error("Length of the file not known. It must either be supplied in the config or given by the HTTP server.");
          }
          this._length = datalength;
      }
      this.serverChecked = true;
  }
  get length() {
      if (!this.serverChecked) {
          this.checkServer();
      }
      return this._length;
  }
  get chunkSize() {
      if (!this.serverChecked) {
          this.checkServer();
      }
      return this._chunkSize;
  }
  doXHR(absoluteFrom, absoluteTo) {
      console.log(`[xhr of size ${(absoluteTo + 1 - absoluteFrom) / 1024} KiB @ ${absoluteFrom / 1024} KiB]`);
      this.requestLimiter(absoluteTo - absoluteFrom);
      this.totalFetchedBytes += absoluteTo - absoluteFrom;
      this.totalRequests++;
      if (absoluteFrom > absoluteTo)
          throw new Error("invalid range (" +
              absoluteFrom +
              ", " +
              absoluteTo +
              ") or no bytes requested!");
      if (absoluteTo > this.length - 1)
          throw new Error("only " + this.length + " bytes available! programmer error!");
      const { fromByte: from, toByte: to, url, } = this.rangeMapper(absoluteFrom, absoluteTo);
      // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      if (this.length !== this.chunkSize)
          xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
      // Some hints to the browser that we want binary data.
      xhr.responseType = "arraybuffer";
      if (xhr.overrideMimeType) {
          xhr.overrideMimeType("text/plain; charset=x-user-defined");
      }
      xhr.send(null);
      if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
          throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
      if (xhr.response !== undefined) {
          return xhr.response;
      }
      else {
          throw Error("xhr did not return uint8array");
      }
  }
}
/** create the actual file object for the emscripten file system */
function createLazyFile(FS, parent, name, canRead, canWrite, lazyFileConfig) {
  var lazyArray = new LazyUint8Array(lazyFileConfig);
  var properties = { isDevice: false, contents: lazyArray };
  var node = FS.createFile(parent, name, properties, canRead, canWrite);
  node.contents = lazyArray;
  // Add a function that defers querying the file size until it is asked the first time.
  Object.defineProperties(node, {
      usedBytes: {
          get: /** @this {FSNode} */ function () {
              return this.contents.length;
          },
      },
  });
  // override each stream op with one that tries to force load the lazy file first
  var stream_ops = {};
  var keys = Object.keys(node.stream_ops);
  keys.forEach(function (key) {
      var fn = node.stream_ops[key];
      stream_ops[key] = function forceLoadLazyFile() {
          FS.forceLoadFile(node);
          return fn.apply(null, arguments);
      };
  });
  // use a custom read function
  stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
      FS.forceLoadFile(node);
      const contents = stream.node.contents;
      return contents.copyInto(buffer, offset, length, position);
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
    createLazyFile(
      pyodide.FS,
      '/home/pyodide',
      name,
      true,
      false,
      {
        rangeMapper: (absoluteFrom, absoluteTo) => {
          return {
            fromByte: absoluteFrom,
            toByte: absoluteTo,
            url: url
          }
      },
      requestChunkSize: 4096,
    })
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

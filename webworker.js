importScripts("/pyodide/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

async function startDatasette(settings) {
  let toLoad = [];
  let csvs = [];
  let sqls = [];
  if (settings.initialUrl) {
    let name = settings.initialUrl.split('.db')[0].split('/').slice(-1)[0];
    toLoad.push([name, settings.initialUrl]);
  }
  let needsDataDb = false;
  if (settings.csvUrls && settings.csvUrls.length) {
    csvs = settings.csvUrls;
    needsDataDb = true;
  }
  if (settings.sqlUrls && settings.sqlUrls.length) {
    sqls = settings.sqlUrls;
    needsDataDb = true;
  }
  if (needsDataDb) {
    toLoad.push(["data.db", 0]);
  } else {
    toLoad.push(["fixtures.db", "/fixtures.db"]);
  }
  self.pyodide = await loadPyodide({
    indexURL: "/pyodide/"
  });
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

    import micropip
    await micropip.install("wheels/packaging-21.3-py3-none-any.whl", deps=False)
    await micropip.install("wheels/pyparsing-3.0.7-py3-none-any.whl", deps=False)
    await micropip.install("wheels/typing_extensions-4.1.1-py3-none-any.whl", deps=False)
    await micropip.install("wheels/six-1.16.0-py2.py3-none-any.whl", deps=False)
    await micropip.install("wheels/MarkupSafe-2.1.1-cp310-cp310-emscripten_3_1_14_wasm32.whl", deps=False)
    await micropip.install("wheels/PyYAML-6.0-cp310-cp310-emscripten_3_1_14_wasm32.whl", deps=False)
    await micropip.install("wheels/pluggy-1.0.0-py2.py3-none-any.whl", deps=False)
    await micropip.install("wheels/certifi-2022.6.15-py3-none-any.whl", deps=False)
    await micropip.install("wheels/python_multipart-0.0.4-py3-none-any.whl", deps=False)
    await micropip.install("wheels/itsdangerous-2.1.2-py3-none-any.whl", deps=False)
    await micropip.install("wheels/click-8.1.3-py3-none-any.whl", deps=False)
    await micropip.install("wheels/click_default_group_wheel-1.2.2-py3-none-any.whl", deps=False)
    await micropip.install("wheels/asgiref-3.5.2-py3-none-any.whl", deps=False)
    await micropip.install("wheels/h11-0.12.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/idna-3.3-py3-none-any.whl", deps=False)
    await micropip.install("wheels/sniffio-1.2.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/anyio-3.6.1-py3-none-any.whl", deps=False)
    await micropip.install("wheels/aiofiles-0.8.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/asgi_csrf-0.9-py3-none-any.whl", deps=False)
    await micropip.install("wheels/Pint-0.18-py2.py3-none-any.whl", deps=False)
    await micropip.install("wheels/uvicorn-0.18.2-py3-none-any.whl", deps=False)
    await micropip.install("wheels/Jinja2-3.0.3-py3-none-any.whl", deps=False)
    await micropip.install("wheels/mergedeep-1.3.4-py3-none-any.whl", deps=False)
    await micropip.install("wheels/hupper-1.10.3-py2.py3-none-any.whl", deps=False)
    await micropip.install("wheels/httpcore-0.15.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/janus-1.0.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/rfc3986-1.5.0-py2.py3-none-any.whl", deps=False)
    await micropip.install("wheels/httpx-0.23.0-py3-none-any.whl", deps=False)
    await micropip.install("wheels/datasette-0.62-py3-none-any.whl", deps=False)
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
    }, metadata = {
        "about": "Datasette Lite",
        "about_url": "https://github.com/simonw/datasette-lite"
    })
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

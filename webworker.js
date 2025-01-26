importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

async function startDatasette(settings) {
  let toLoad = [];
  let sources = [];
  let needsDataDb = false;
  let shouldLoadDefaults = true;
  // Which version of Datasette to install?
  let datasetteToInstall = 'datasette';
  let pre = 'False';
  if (settings.ref) {
    if (settings.ref == 'pre') {
      pre = 'True';
    } else {
      datasetteToInstall = `datasette==${settings.ref}`;
    }
  }
  console.log({datasetteToInstall});
  if (settings.sqliteUrl) {
    let name = settings.sqliteUrl.split('.db')[0].split('/').slice(-1)[0];
    toLoad.push([name, settings.sqliteUrl]);
    shouldLoadDefaults = false;
  }
  ['csv', 'sql', 'json', 'parquet'].forEach(sourceType => {
    if (settings[`${sourceType}Urls`] && settings[`${sourceType}Urls`].length) {
      sources.push([sourceType, settings[`${sourceType}Urls`]]);
      needsDataDb = true;
      shouldLoadDefaults = false;
    }
  });
  if (settings.memory) {
    shouldLoadDefaults = false;
  }
  if (needsDataDb) {
    toLoad.push(["data.db", 0]);
  }
  if (shouldLoadDefaults) {
    toLoad.push(["fixtures.db", "https://latest.datasette.io/fixtures.db"]);
    toLoad.push(["content.db", "https://datasette.io/content.db"]);
  }
  self.pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/",
    fullStdLib: true
  });
  await pyodide.loadPackage('micropip', {messageCallback: log});
  await pyodide.loadPackage('ssl', {messageCallback: log});
  await pyodide.loadPackage('setuptools', {messageCallback: log}); // For pkg_resources
  try {
    await self.pyodide.runPythonAsync(`
    # https://github.com/pyodide/pyodide/issues/3880#issuecomment-1560130092
    import os
    import csv
    os.link = os.symlink

    # Increase CSV field size limit to maximim possible
    # https://stackoverflow.com/a/15063941
    field_size_limit = sys.maxsize

    while True:
        try:
            csv_std.field_size_limit(field_size_limit)
            break
        except OverflowError:
            field_size_limit = int(field_size_limit / 10)

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
    # Workaround for Requested 'h11<0.13,>=0.11', but h11==0.13.0 is already installed
    await micropip.install("h11==0.12.0")
    await micropip.install("httpx==0.23")
    await micropip.install("python-multipart==0.0.15")
    # To avoid possible 'from typing_extensions import deprecated' error:
    await micropip.install('typing-extensions>=4.12.2')
    await micropip.install("${datasetteToInstall}", pre=${pre})
    # Install any extra ?install= dependencies
    install_urls = ${JSON.stringify(settings.installUrls)}
    if install_urls:
        for install_url in install_urls:
            await micropip.install(install_url)
    # Execute any ?sql=URL SQL
    sqls = ${JSON.stringify(sources.filter(source => source[0] === "sql")[0]?.[1] || [])}
    if sqls:
        for sql_url in sqls:
            # Fetch that SQL and execute it
            response = await pyfetch(sql_url)
            sql = await response.string()
            sqlite3.connect("data.db").executescript(sql)
    metadata = {
        "about": "Datasette Lite",
        "about_url": "https://github.com/simonw/datasette-lite"
    }
    metadata_url = ${JSON.stringify(settings.metadataUrl || '')}
    if metadata_url:
        response = await pyfetch(metadata_url)
        content = await response.string()
        from datasette.utils import parse_metadata
        metadata = parse_metadata(content)

    # Import data from ?csv=URL CSV files/?json=URL JSON files
    sources = ${JSON.stringify(sources.filter(source => ['csv', 'json', 'parquet'].includes(source[0])))}
    if sources:
        await micropip.install("sqlite-utils==3.28")
        import sqlite_utils, json
        from sqlite_utils.utils import rows_from_file, TypeTracker, Format
        db = sqlite_utils.Database("data.db")
        table_names = set()
        for source_type, urls in sources:
            for url in urls:
                # Derive table name from URL
                bit = url.split("/")[-1].split(".")[0].split("?")[0]
                bit = bit.strip()
                if not bit:
                    bit = "table"
                prefix = 0
                base_bit = bit
                while bit in table_names:
                    prefix += 1
                    bit = "{}_{}".format(base_bit, prefix)
                table_names.add(bit)

                if source_type == "csv":
                    tracker = TypeTracker()
                    response = await pyfetch(url)
                    with open("csv.csv", "wb") as fp:
                        fp.write(await response.bytes())
                    db[bit].insert_all(
                        tracker.wrap(rows_from_file(open("csv.csv", "rb"), Format.CSV)[0]),
                        alter=True
                    )
                    db[bit].transform(
                        types=tracker.types
                    )
                elif source_type == "json":
                    pk = None
                    response = await pyfetch(url)
                    with open("json.json", "wb") as fp:
                        json_bytes = await response.bytes()
                        try:
                            json_data = json.loads(json_bytes)
                        except json.decoder.JSONDecodeError:
                            # Maybe it's newline-delimited JSON?
                            # This will raise an unhandled exception if not
                            json_data = [json.loads(line) for line in json_bytes.splitlines()]
                    if isinstance(json_data, dict) and all(isinstance(v, dict) for v in json_data.values()):
                        fixed = []
                        pk = "_key"
                        for key, value in json_data.items():
                            value["_key"] = key
                            fixed.append(value)
                        json_data = fixed
                    elif isinstance(json_data, dict) and any(isinstance(v, list) for v in json_data.values()):
                        for key, value in json_data.items():
                            if isinstance(value, list) and value and isinstance(value[0], dict):
                                json_data = value
                                break
                    assert isinstance(json_data, list), "JSON data must be a list of objects"
                    db[bit].insert_all(json_data, pk=pk, alter=True)
                elif source_type == "parquet":
                    await micropip.install("fastparquet")
                    import fastparquet
                    response = await pyfetch(url)
                    with open("parquet.parquet", "wb") as fp:
                        fp.write(await response.bytes())
                    df = fastparquet.ParquetFile("parquet.parquet").to_pandas()
                    df.to_sql(bit, db.conn, if_exists="replace")
    from datasette.app import Datasette
    ds = Datasette(names, settings={
        "num_sql_threads": 0,
    }, metadata=metadata, memory=${settings.memory ? 'True' : 'False'})
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

importScripts("https://cdn.jsdelivr.net/pyodide/dev/full/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

async function startDatasette() {
  self.pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/dev/full/"
  });
  await pyodide.loadPackage('micropip', log);
  await pyodide.loadPackage('ssl', log);
  await pyodide.loadPackage('setuptools', log); // For pkg_resources
  await self.pyodide.runPythonAsync(`
  # Grab that fixtures.db database
  from pyodide.http import pyfetch
  names = []
  for name, url in (
      ("fixtures.db", "https://latest.datasette.io/fixtures.db"),
      ("content.db", "https://datasette.io/content.db"),
  ):
      response = await pyfetch(url)
      with open(name, "wb") as fp:
          fp.write(await response.bytes())
      names.append(name)

  import micropip
  # Workaround for Requested 'h11<0.13,>=0.11', but h11==0.13.0 is already installed
  await micropip.install("h11==0.12.0")
  await micropip.install("datasette==0.62a0")
  from datasette.app import Datasette
  ds = Datasette(names, memory=True, settings={"num_sql_threads": 0})
  `);
}

let readyPromise = startDatasette();

self.onmessage = async (event) => {
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
    self.postMessage({ error: error.message });
  }
};

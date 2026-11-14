// worker.js - a module Web Worker that runs Datasette. datasette-lite.js owns
// it and talks to it with {id, method, args} messages, answered by
// {id, result} or {id, error}. {log: line} messages report startup progress.

import { loadPyodide } from "./pyodide/pyodide.mjs";
import { boot } from "./core.js";

let runtime = null;

async function readUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const methods = {
  async start(options) {
    runtime = boot(
      {
        loadPyodide,
        indexURL: new URL("./pyodide/", import.meta.url).href,
        readUrl,
        log: (line) => self.postMessage({ log: line }),
      },
      options,
    );
    return [(await runtime).manifest];
  },
  async request(request) {
    const response = await (await runtime).request(request);
    return [response, [response.body]];
  },
  async add(item) {
    return [await (await runtime).add(item)];
  },
  async readDatabase(name) {
    const bytes = (await runtime).readDatabase(name);
    return [bytes.buffer, [bytes.buffer]];
  },
};

self.onmessage = async (event) => {
  const { id, method, args } = event.data;
  try {
    const [result, transfer] = await methods[method](...args);
    self.postMessage({ id, result }, transfer || []);
  } catch (error) {
    self.postMessage({ id, error: (error && error.message) || String(error) });
  }
};

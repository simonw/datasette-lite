// worker.js - a module Web Worker that runs Datasette. datasette-lite.js owns
// it and talks to it with {id, method, args} messages, answered by
// {id, result} or {id, error}. {log: line} messages report startup progress.

import { loadPyodide } from "./pyodide/pyodide.mjs";
import { boot } from "./core.js";

let runtime = null;
// Streamed responses in progress: the id of the call -> the runtime's request id
const streams = new Map();

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
  // With stream set, a response Datasette sends in pieces is posted as it is
  // produced: {id, start: {status, headers}}, then {id, chunk} any number of
  // times, then the usual {id, result} - {streamed: true} - or {id, error}.
  async request(request, stream, id) {
    try {
      const response = await (await runtime).request(request, stream && {
        onStart(status, headers) {
          streams.set(id, this.id);
          self.postMessage({ id, start: { status, headers } });
        },
        onChunk(chunk) {
          self.postMessage({ id, chunk: chunk.buffer }, [chunk.buffer]);
        },
      });
      return [response, response.body ? [response.body] : []];
    } finally {
      streams.delete(id);
    }
  },
  // The page stopped reading the streamed response to call number id
  async cancel(id) {
    if (streams.has(id)) (await runtime).cancel(streams.get(id));
    return [null];
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
    const [result, transfer] = await methods[method](...args, id);
    self.postMessage({ id, result }, transfer || []);
  } catch (error) {
    self.postMessage({ id, error: (error && error.message) || String(error) });
  }
};

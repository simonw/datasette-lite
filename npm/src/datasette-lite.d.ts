export interface Manifest {
  datasette: string;
  pyodide: string;
  python: string;
  archive: { file: string; size: number; sha256: string; dynlibs: Array<{ path: string; global: boolean }> };
  load: string[];
  wheels: string[];
  packages: Record<string, string>;
}

export type Bytes = ArrayBuffer | ArrayBufferView;

export interface DatabaseSource {
  url?: string;
  file?: Blob;
  data?: Bytes;
  /** What Datasette calls the database. Defaults to the file name. */
  name?: string;
}

export interface ImportSource {
  url?: string;
  file?: Blob;
  text?: string;
  data?: Bytes;
  /** Defaults to the file name, or "table" */
  table?: string;
  /** Defaults to "data" */
  database?: string;
}

export interface DatasetteLiteOptions {
  databases?: Array<string | Blob | DatabaseSource>;
  csv?: Array<string | Blob | ImportSource>;
  json?: Array<string | Blob | ImportSource>;
  /** SQL scripts, run before csv and json are imported */
  sql?: Array<string | Blob | ImportSource>;
  /** URL of a metadata JSON/YAML file, or the metadata itself */
  metadata?: string | object;
  /** URL of a datasette.yaml, or the configuration itself */
  config?: string | object;
  /** Plugins. Ones built into the bundle load offline, others come from PyPI. */
  install?: string[];
  settings?: Record<string, unknown>;
  root?: boolean;
  memory?: boolean;
  /** Register the service worker so appUrl() can be shown in an iframe */
  ui?: boolean;
  /** Where the package's dist/ directory is served. Defaults to next to the module. */
  assets?: string | URL;
  /** A same-origin service worker script that imports the package's sw.js, when the package is on a CDN */
  serviceWorker?: string | URL;
}

export type AddItem =
  | ({ type: "database" } & DatabaseSource)
  | ({ type: "csv" | "json" | "sql" } & ImportSource);

export class DatasetteLite extends EventTarget {
  static start(options?: DatasetteLiteOptions): Promise<DatasetteLite>;
  constructor(options?: DatasetteLiteOptions);
  readonly ready: Promise<DatasetteLite>;
  readonly manifest: Manifest | null;
  readonly baseUrl: string;
  appUrl(path?: string): string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: { database?: string; params?: Record<string, string> },
  ): Promise<Row[]>;
  add(item: AddItem): Promise<{ database: string; table: string | null }>;
  addFile(file: File, options?: Partial<ImportSource & DatabaseSource>): Promise<{ database: string; table: string | null }>;
  readDatabase(name: string): Promise<Uint8Array>;
  terminate(): void;
}

/**
 * <datasette-lite src="a.db b.db" csv="..." json="..." sql="..." metadata="..."
 *   config="..." install="..." path="/a" service-worker="/sw.js" root memory drop hash autoheight>
 *
 * Events: datasette-ready, datasette-error, datasette-log, datasette-navigate
 */
export class DatasetteLiteElement extends HTMLElement {
  datasette: DatasetteLite | null;
  /** Set before connecting to use these instead of the element's attributes */
  options: DatasetteLiteOptions | null;
  /** "frame" when Datasette runs in the package's frame.html on another origin */
  readonly mode: "local" | "frame" | null;
  ready: Promise<DatasetteLiteElement>;
  readonly path: string | null;
  navigate(path: string, options?: { replace?: boolean }): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  query: DatasetteLite["query"];
  addFile: DatasetteLite["addFile"];
  readDatabase(name: string): Promise<Uint8Array>;
}

declare global {
  interface HTMLElementTagNameMap {
    "datasette-lite": DatasetteLiteElement;
  }
}

# The Python side of the datasette-lite npm package. Runs inside Pyodide, after
# the ASGI bridge (cut out of ../../webworker.js at build time, so ASGIBridge
# and datasette_base_url_fixes are already defined when this runs).
#
# Unlike the hosted Datasette Lite this never touches the network itself: by
# the time start() is called every package has been loaded from the bundle and
# every input - databases, CSV, JSON, SQL, metadata - has been written to the
# Pyodide file system by core.js. settings["inputs"] says where they are.
import csv
import json
import os
import sqlite3
import sys

# https://github.com/pyodide/pyodide/issues/3880#issuecomment-1560130092
os.link = os.symlink
# Recent platformdirs releases (imported by Datasette's vendored pint) call
# os.geteuid(), which Pyodide does not provide
if not hasattr(os, "geteuid"):
    os.geteuid = os.getuid

# Increase CSV field size limit to the maximum possible
# https://stackoverflow.com/a/15063941
_field_size_limit = sys.maxsize
while True:
    try:
        csv.field_size_limit(_field_size_limit)
        break
    except OverflowError:
        _field_size_limit = int(_field_size_limit / 10)

ds = None
bridge = None
_base_url = "/"


def _read(path):
    with open(path, "rb") as fp:
        return fp.read()


def _import_csv(db, table, content):
    from sqlite_utils.utils import Format, TypeTracker, rows_from_file

    tracker = TypeTracker()
    # Auto-detect the delimiter (comma or semicolon) from the first lines
    sample = content[:65536].decode("utf-8", errors="ignore").splitlines()[:5]
    semicolons = sum(line.count(";") for line in sample)
    commas = sum(line.count(",") for line in sample)
    if semicolons > commas:
        from io import StringIO

        rows = list(csv.reader(StringIO(content.decode("utf-8", errors="ignore")), delimiter=";"))
        if not rows:
            return
        headers = rows[0]
        docs = (dict(zip(headers, row)) for row in rows[1:])
    else:
        from io import BytesIO

        docs = rows_from_file(BytesIO(content), Format.CSV)[0]
    db[table].insert_all(tracker.wrap(docs), alter=True)
    db[table].transform(types=tracker.types)


def _import_json(db, table, content):
    pk = None
    try:
        data = json.loads(content)
    except json.decoder.JSONDecodeError:
        # Maybe it's newline-delimited JSON?
        data = [json.loads(line) for line in content.splitlines() if line.strip()]
    if isinstance(data, dict) and data and all(isinstance(v, dict) for v in data.values()):
        pk = "_key"
        data = [dict(value, _key=key) for key, value in data.items()]
    elif isinstance(data, dict):
        object_lists = [
            value
            for value in data.values()
            if isinstance(value, list) and value and all(isinstance(item, dict) for item in value)
        ]
        if object_lists:
            data = max(object_lists, key=len)
    if not isinstance(data, list):
        raise ValueError("JSON data must be a list of objects")
    db[table].insert_all(data, pk=pk, alter=True)


def _unique_table(db, table):
    existing = set(db.table_names())
    name, suffix = table, 1
    while name in existing:
        name = "{}_{}".format(table, suffix)
        suffix += 1
    return name


def _import(item):
    """Import one CSV, JSON or SQL input into <database>.db"""
    import sqlite_utils

    db_path = item["database"] + ".db"
    content = _read(item["path"])
    if item["type"] == "sql":
        conn = sqlite3.connect(db_path)
        conn.executescript(content.decode("utf-8"))
        conn.close()
        return None
    db = sqlite_utils.Database(db_path)
    table = _unique_table(db, item["table"])
    if item["type"] == "csv":
        _import_csv(db, table, content)
    elif item["type"] == "json":
        _import_json(db, table, content)
    else:
        raise ValueError("Unknown import type: {}".format(item["type"]))
    db.conn.close()
    return table


async def _micropip_install(requirement, pre):
    # Only reached for packages that are not in the bundle - needs a network
    import re

    import micropip

    for _ in range(5):
        try:
            await micropip.install(requirement, pre=pre)
            return
        except ValueError as ex:
            match = re.search(r"Requested '(.+?)', but (\S+)==\S+ is already installed", str(ex))
            if not match:
                raise
            micropip.uninstall(match.group(2))
            await micropip.install(match.group(1))
    await micropip.install(requirement, pre=pre)


async def start(settings_json, log):
    global ds, bridge, _base_url
    settings = json.loads(settings_json)
    _base_url = settings["base_url"]

    for requirement in settings["micropip"]:
        log("Installing {} from PyPI...".format(requirement))
        await _micropip_install(requirement, settings["pre"])

    names = []
    for item in settings["databases"]:
        if item.get("in_place"):
            # A file in a mounted directory (Node only): opened where it is
            names.append(item["path"])
            continue
        # Saved as <name>.db, so <name> is what Datasette calls the database
        os.replace(item["path"], item["name"] + ".db")
        names.append(item["name"] + ".db")
    for item in settings["imports"]:
        db_file = item["database"] + ".db"
        if db_file not in names:
            sqlite3.connect(db_file).execute("vacuum")
            names.append(db_file)
        _import(item)

    log("Starting Datasette...")
    import inspect

    from datasette.app import Datasette
    from datasette.utils import parse_metadata

    metadata = {}
    if settings["metadata"]:
        metadata = parse_metadata(_read(settings["metadata"]).decode("utf-8"))
    kwargs = {}
    if settings["config"]:
        if "config" not in inspect.signature(Datasette.__init__).parameters:
            raise ValueError("config requires Datasette 1.0a8 or later")
        kwargs["config"] = parse_metadata(_read(settings["config"]).decode("utf-8"))
        if isinstance(kwargs["config"].get("settings"), dict):
            for key in ("base_url", "num_sql_threads"):
                kwargs["config"]["settings"].pop(key, None)

    ds_settings = dict(settings["settings"])
    # Keep every URL Datasette generates under the prefix it is served from
    ds_settings["base_url"] = _base_url
    # Pyodide has no threads: run SQLite queries inline on the event loop
    ds_settings["num_sql_threads"] = 0
    ds = Datasette(names, settings=ds_settings, metadata=metadata, memory=settings["memory"], **kwargs)
    await ds.invoke_startup()

    app = ds.app()
    if _base_url != "/":
        app = datasette_base_url_fixes(app, _base_url)
    bridge = ASGIBridge(app)
    await bridge.startup()

    if settings["root"]:
        # The equivalent of "datasette --root": sign in by visiting the
        # one-time token URL, so the ds_actor cookie lands in the cookie jar
        import secrets

        ds.root_enabled = True
        ds._root_token = secrets.token_hex(32)
        response = await bridge.handle("GET", _base_url + "-/auth-token", "token=" + ds._root_token, [], b"")
        if "ds_actor" not in bridge.cookies.as_dict():
            raise ValueError("Could not sign in as root: HTTP {}".format(response["status"]))


def _ensure_database(name, path=None):
    """Attach <name>.db to the running Datasette if it is not there already"""
    from datasette.database import Database

    db_file = name + ".db"
    if path:
        os.replace(path, db_file)
    elif not os.path.exists(db_file):
        sqlite3.connect(db_file).execute("vacuum")
    if name not in ds.databases:
        ds.add_database(Database(ds, path=db_file, is_mutable=True), name=name)
    return name


async def add(item_json):
    """Add a database, or import CSV/JSON/SQL, while Datasette is running.
    Returns the path of the page that shows what was added."""
    item = json.loads(item_json)
    if item["type"] == "database":
        if item["name"] in ds.databases:
            # Replace it: close the old connections before swapping the file
            ds.databases[item["name"]].close()
            ds.remove_database(item["name"])
        _ensure_database(item["name"], item["path"])
        table = None
    else:
        _ensure_database(item["database"])
        table = _import(item)
    database = item["name"] if item["type"] == "database" else item["database"]
    if hasattr(ds, "refresh_schemas"):
        await ds.refresh_schemas()
    return json.dumps({"database": database, "table": table})


async def handle_request(method, raw_path, query, headers_json, body_buf, scheme, host, port):
    from urllib.parse import unquote

    from js import Object
    from pyodide.ffi import to_js

    headers = json.loads(headers_json)
    body = b"" if body_buf is None else body_buf.to_py().tobytes()
    response = await bridge.handle(
        method, unquote(raw_path), query, headers, body,
        scheme=scheme, host=host, port=int(port), raw_path=raw_path,
    )
    return to_js(
        {"status": response["status"], "headers": response["headers"], "body": response["body"]},
        dict_converter=Object.fromEntries,
    )

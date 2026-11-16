"""Tests for ?sqlite=VERSION, which runs Datasette Lite on a pysqlite3 wheel
that has that version of SQLite compiled in.

The JavaScript that validates the version and picks a wheel from wheels.json
is extracted from webworker.js and run in a browser page, and the Python
that aliases sqlite3 is extracted from the startup code - so the code tested
here is exactly the code that ships."""
import ast
import json
import re
import sys
import types

import pytest
from playwright.sync_api import expect

from test_bridge import WEBWORKER, extract
from conftest import boot, build_wheel, datasette_frame, root, wait_for_boot

F = "tests/fixtures/"
PYTHON_TAG = "cp314"
PLATFORM_TAG = "pyemscripten_2026_0_wasm32"
WHEELS_URL = "https://datasette.github.io/pysqlite3-wasm-wheels/"
# A version that the wheels index is expected to keep
VERSION = "3.54.1"


def wheel(sqlite_version, built="2026-11-16T06:52:46Z", python_tag=PYTHON_TAG,
          platform_tag=PLATFORM_TAG, pyodide_version="314.0.8", name=None):
    filename = "{}-{}-{}-{}-{}.whl".format(
        name or "pysqlite3-0.6.2", sqlite_version, python_tag, python_tag, platform_tag
    )
    return {
        "sqlite_version": sqlite_version,
        "filename": filename,
        "path": "wheels/" + filename,
        "pysqlite3_version": "0.6.2",
        "pyodide_version": pyodide_version,
        "python_tag": python_tag,
        "abi_tag": python_tag,
        "platform_tag": platform_tag,
        "size": 422393,
        "sha256": "c0e70204ffd2bb545d1ed2502ac4adfe40f197d234f85e2b8ce39f956dd36c0c",
        "built": built,
    }


def extract_js(name):
    match = re.search(
        r"// JS-BEGIN {name}\n(.*?)// JS-END {name}".format(name=name),
        WEBWORKER.read_text(),
        re.S,
    )
    assert match, name
    return match.group(1)


@pytest.fixture
def page(shared_context):
    page = shared_context.new_page()
    yield page
    page.close()


@pytest.fixture
def js(page, static_server):
    """Call one of the ?sqlite= functions from webworker.js, returning
    {"value": ...} or {"error": message}"""
    # A page on the test server, so that fetch() has an origin to use
    page.goto(static_server + "/" + F + "plain.html")
    page.add_script_tag(content=extract_js("sqlite"))

    def call(function, *args):
        return page.evaluate(
            """async ([name, args]) => {
                try {
                    return {value: await window[name](...args)};
                } catch (error) {
                    return {error: error.message};
                }
            }""",
            [function, list(args)],
        )

    return call


def test_worker_constants_match_the_tests():
    source = WEBWORKER.read_text()
    assert 'const SQLITE_WHEELS_URL = "{}";'.format(WHEELS_URL) in source
    assert 'const PYODIDE_PYTHON_TAG = "{}";'.format(PYTHON_TAG) in source
    assert 'const PYODIDE_PLATFORM_TAG = "{}";'.format(PLATFORM_TAG) in source


# --- Version validation --------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    (
        ("3.54.1", True),
        ("3.54", True),
        ("3.8.11.1", True),
        ("3", False),
        ("3.", False),
        ("3.54.1.2.3", False),
        ("v3.54.1", False),
        ("3.54.1 ", False),
        ("3.54.1\n", False),
        ("3.54.x", False),
        ("latest", False),
        ("3.54.1/../evil", False),
        ("", False),
    ),
)
def test_is_sqlite_version(js, value, expected):
    assert js("isSqliteVersion", value) == {"value": expected}


def test_not_a_version_number_error(js):
    assert js("findSqliteWheelUrl", "latest", WHEELS_URL, PYTHON_TAG, PLATFORM_TAG) == {
        "error": "?sqlite=latest is not a SQLite version number, e.g. ?sqlite=3.54.1"
    }


# --- Choosing a wheel ----------------------------------------------------------


def choose(js, wheels, version=VERSION):
    return js("chooseSqliteWheel", {"wheels": wheels}, version, PYTHON_TAG, PLATFORM_TAG)


def test_chooses_the_wheel_for_the_version(js):
    wheels = [wheel("3.54.0"), wheel("3.54.1"), wheel("3.53.4")]
    assert choose(js, wheels) == {"value": wheels[1]}


def test_matches_on_tags_not_pyodide_version(js):
    # Built against another Pyodide release that has the same tags
    wheels = [wheel("3.54.1", pyodide_version="314.1.0")]
    assert choose(js, wheels) == {"value": wheels[0]}


def test_several_matches_uses_the_most_recently_built(js):
    wheels = [
        wheel("3.54.1", built="2026-11-16T06:52:46Z", name="pysqlite3-0.6.2"),
        wheel("3.54.1", built="2026-12-01T00:00:00Z", name="pysqlite3-0.6.4"),
        wheel("3.54.1", built="2026-11-20T00:00:00Z", name="pysqlite3-0.6.3"),
        # More recent still, but for another version and another Python
        wheel("3.54.0", built="2027-01-01T00:00:00Z"),
        wheel("3.54.1", built="2027-01-01T00:00:00Z", python_tag="cp315"),
    ]
    assert choose(js, wheels)["value"]["filename"].startswith("pysqlite3-0.6.4-")
    assert choose(js, list(reversed(wheels)))["value"]["filename"].startswith("pysqlite3-0.6.4-")


def test_no_match_lists_the_versions_that_are_available(js):
    wheels = [
        wheel("3.9.2"),
        wheel("3.54.1"),
        wheel("3.54.0"),
        # Twice: listed once
        wheel("3.54.0", built="2026-12-01T00:00:00Z"),
        wheel("3.10.0"),
        # Not for this Pyodide, so not available
        wheel("3.55.0", python_tag="cp315"),
        wheel("3.56.0", platform_tag="pyemscripten_2027_0_wasm32"),
    ]
    assert choose(js, wheels, "3.55.0") == {
        "error": (
            "?sqlite=3.55.0 is not available: there is no SQLite 3.55.0 wheel for "
            "cp314 pyemscripten_2026_0_wasm32. "
            "Available versions: 3.54.1, 3.54.0, 3.10.0, 3.9.2"
        )
    }


@pytest.mark.parametrize(
    "changed",
    ({"python_tag": "cp315"}, {"platform_tag": "pyemscripten_2027_0_wasm32"}),
)
def test_wrong_tags_do_not_match(js, changed):
    result = choose(js, [wheel("3.54.1", **changed)])
    assert result == {
        "error": (
            "?sqlite=3.54.1 is not available: there is no SQLite 3.54.1 wheel for "
            "cp314 pyemscripten_2026_0_wasm32. No SQLite versions are available for it."
        )
    }


@pytest.mark.parametrize("index", ({"wheels": []}, {}, None))
def test_empty_index(js, index):
    result = js("chooseSqliteWheel", index, VERSION, PYTHON_TAG, PLATFORM_TAG)
    assert "No SQLite versions are available" in result["error"]


# --- Looking the wheel up in wheels.json ---------------------------------------


def test_wheel_url_is_its_path_resolved_against_the_base_url(js, page, static_server):
    base = static_server + "/fake-wheels/"
    page.route(
        base + "wheels.json",
        lambda route: route.fulfill(json={"wheels": [wheel("3.54.0"), wheel("3.54.1")]}),
    )
    assert js("findSqliteWheelUrl", VERSION, base, PYTHON_TAG, PLATFORM_TAG) == {
        "value": base + "wheels/pysqlite3-0.6.2-3.54.1-cp314-cp314-pyemscripten_2026_0_wasm32.whl"
    }


@pytest.mark.parametrize(
    "respond,reason",
    (
        (lambda route: route.fulfill(status=404, body="Not found"), "HTTP 404"),
        (lambda route: route.abort(), ""),
        (lambda route: route.fulfill(body="<html>not json"), ""),
    ),
)
def test_wheels_json_that_cannot_be_fetched_names_the_url(js, page, static_server, respond, reason):
    base = static_server + "/fake-wheels/"
    page.route(base + "wheels.json", respond)
    error = js("findSqliteWheelUrl", VERSION, base, PYTHON_TAG, PLATFORM_TAG)["error"]
    assert error.startswith(
        "?sqlite=3.54.1 could not be used. Could not load " + base + "wheels.json: " + reason
    )


# --- The Python startup code ---------------------------------------------------


def test_use_pysqlite3_as_sqlite3(monkeypatch):
    tree = ast.parse(extract("startup"))
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "use_pysqlite3_as_sqlite3"
    ]
    assert len(functions) == 1
    namespace = {}
    exec(compile(ast.Module(body=functions, type_ignores=[]), "webworker.js", "exec"), namespace)

    pysqlite3 = types.ModuleType("pysqlite3")
    pysqlite3.__path__ = []
    pysqlite3.sqlite_version = "3.54.1"
    pysqlite3.dbapi2 = types.ModuleType("pysqlite3.dbapi2")
    pysqlite3.dbapi2.sqlite_version = "3.54.1"
    monkeypatch.setitem(sys.modules, "pysqlite3", pysqlite3)
    monkeypatch.setitem(sys.modules, "pysqlite3.dbapi2", pysqlite3.dbapi2)
    # Restored afterwards
    monkeypatch.setitem(sys.modules, "sqlite3", sys.modules["sqlite3"])
    monkeypatch.setitem(sys.modules, "sqlite3.dbapi2", sys.modules["sqlite3.dbapi2"])

    namespace["use_pysqlite3_as_sqlite3"]()

    import sqlite3
    import sqlite3.dbapi2
    from sqlite3 import dbapi2

    assert sqlite3 is pysqlite3
    assert sqlite3.dbapi2 is pysqlite3.dbapi2
    assert dbapi2 is pysqlite3.dbapi2
    assert sqlite3.sqlite_version == "3.54.1"


def imported_modules(node):
    "Top level names of every module imported anywhere inside this node"
    names = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Import):
            names.update(alias.name.split(".")[0] for alias in child.names)
        elif isinstance(child, ast.ImportFrom) and child.module:
            names.add(child.module.split(".")[0])
    return names


def test_sqlite3_is_aliased_before_anything_imports_it():
    # Modules that import sqlite3 when they are imported
    uses_sqlite = {"sqlite3", "datasette", "sqlite_utils"}
    # The bridge code runs before the startup code
    assert not imported_modules(ast.parse(extract("bridge"))) & uses_sqlite

    body = ast.parse(extract("startup")).body
    (aliased,) = [
        index
        for index, node in enumerate(body)
        if not isinstance(node, ast.FunctionDef)
        and any(
            isinstance(child, ast.Call)
            and getattr(child.func, "id", None) == "use_pysqlite3_as_sqlite3"
            for child in ast.walk(node)
        )
    ]
    # Only for ?sqlite=, and after micropip installed the wheel
    block = body[aliased]
    assert isinstance(block, ast.If)
    assert ast.unparse(block.test) == "settings['sqlite_wheel_url']"
    source = ast.unparse(block)
    assert source.index("micropip.install(settings['sqlite_wheel_url'])") < source.index(
        "use_pysqlite3_as_sqlite3()"
    )

    # Nothing before it imports sqlite3 or Datasette, or installs Datasette
    for node in body[:aliased]:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Its imports happen when it is called: only this one is, by then
            if node.name not in ("step",):
                continue
        assert not imported_modules(node) & uses_sqlite, ast.unparse(node)
        assert "micropip.install" not in ast.unparse(node)
    # ... and all of that comes after it
    after = ast.unparse(ast.Module(body=body[aliased + 1:], type_ignores=[]))
    for expected in ("import sqlite3", "from datasette.app import Datasette", "Installing Datasette"):
        assert expected in after


# --- In the browser ------------------------------------------------------------


def startup_error(page, url):
    page.goto(url)
    page.wait_for_function(
        "document.getElementById('output').textContent.length", timeout=180 * 1000
    )
    return page.locator("#output")


def fetch_json(page, path):
    base = re.match(r"(/app/[^/]+)", datasette_frame(page).evaluate("location.pathname")).group(1)
    return datasette_frame(page).evaluate("async path => (await fetch(path)).json()", base + path)


def test_not_a_version_number_fails_before_anything_is_downloaded(browser, static_server):
    context = browser.new_context()
    try:
        requests = []
        context.on("request", lambda request: requests.append(request.url))
        page = context.new_page()
        expect(startup_error(page, static_server + "/?memory=1&sqlite=latest")).to_contain_text(
            "?sqlite=latest is not a SQLite version number, e.g. ?sqlite=3.54.1"
        )
        assert not [url for url in requests if "pyodide" in url or "pysqlite3" in url]
    finally:
        context.close()


def test_without_sqlite_nothing_extra_is_downloaded(browser, static_server):
    context = browser.new_context()
    try:
        requests = []
        context.on("request", lambda request: requests.append(request.url))
        page = context.new_page()
        boot(page, static_server + "/?memory=1#/-/versions.json", wait_for="pre")
        assert requests
        assert not [url for url in requests if "pysqlite3" in url]
        # The SQLite built into Pyodide
        assert fetch_json(page, "/-/versions.json")["sqlite"]["version"] == "3.39.0"
    finally:
        context.close()


def test_version_with_no_wheel_lists_the_available_versions(browser, static_server):
    context = browser.new_context()
    try:
        context.route(
            WHEELS_URL + "wheels.json",
            lambda route: route.fulfill(
                json={"wheels": [wheel("3.54.1"), wheel("3.53.4"), wheel("3.60.0", python_tag="cp315")]},
                headers={"access-control-allow-origin": "*"},
            ),
        )
        # Pyodide never arrives: the error must not wait for it
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        expect(startup_error(page, static_server + "/?memory=1&sqlite=3.60.0")).to_contain_text(
            "?sqlite=3.60.0 is not available: there is no SQLite 3.60.0 wheel for "
            "cp314 pyemscripten_2026_0_wasm32. Available versions: 3.54.1, 3.53.4"
        )
    finally:
        context.close()


def test_wheels_json_that_cannot_be_fetched_is_an_error(browser, static_server):
    context = browser.new_context()
    try:
        context.route(WHEELS_URL + "wheels.json", lambda route: route.abort())
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        expect(startup_error(page, static_server + "/?memory=1&sqlite=" + VERSION)).to_contain_text(
            "?sqlite=3.54.1 could not be used. Could not load " + WHEELS_URL + "wheels.json"
        )
    finally:
        context.close()


def test_wheel_that_cannot_be_fetched_is_an_error(browser, static_server):
    "It must not carry on with the SQLite built into Pyodide"
    context = browser.new_context()
    try:
        context.route(
            WHEELS_URL + "wheels.json",
            lambda route: route.fulfill(
                json={"wheels": [wheel(VERSION)]},
                headers={"access-control-allow-origin": "*"},
            ),
        )
        context.route(
            WHEELS_URL + "wheels/**",
            lambda route: route.fulfill(
                status=404, body="Not found", headers={"access-control-allow-origin": "*"}
            ),
        )
        page = context.new_page()
        output = startup_error(page, static_server + "/?memory=1&sqlite=" + VERSION)
        expect(output).to_contain_text("?sqlite=3.54.1 could not be used. Could not install")
        expect(output).to_contain_text(WHEELS_URL + "wheels/" + wheel(VERSION)["filename"])
        assert "ready" not in (page.locator("body").get_attribute("class") or "")
    finally:
        context.close()


@pytest.fixture(scope="session")
def sqlite3_plugin(generated_fixtures, static_server):
    "URL of a wheel of tests/plugins/datasette_lite_test_sqlite3.py, for ?install="
    wheel_name = build_wheel(
        generated_fixtures,
        "datasette-lite-test-sqlite3",
        root / "tests" / "plugins" / "datasette_lite_test_sqlite3.py",
    )
    return "{}/tests/fixtures/generated/{}".format(static_server, wheel_name)


@pytest.mark.network
def test_sqlite_version(page, static_server, sqlite3_plugin):
    "With a plugin, and with the CSV and SQL loading that use sqlite3 directly"
    url = (
        static_server
        + "/?sqlite={}&csv={F}items.csv&sql={F}setup.sql&install={}".format(
            VERSION, sqlite3_plugin, F=F
        )
        + "#/-/versions.json"
    )
    page.goto(url)
    # Its own step on the loading screen
    expect(
        page.locator("#loading-logs li").filter(has_text="Installing SQLite " + VERSION)
    ).to_have_count(1, timeout=180 * 1000)
    wait_for_boot(page)
    expect(page.frame_locator("#datasette").locator("pre")).to_be_attached(timeout=60 * 1000)
    assert fetch_json(page, "/-/versions.json")["sqlite"]["version"] == VERSION
    (row,) = fetch_json(
        page,
        "/data.json?_shape=array&sql="
        "select+sqlite_version()+as+v,+stdlib_sqlite_version()+as+stdlib,"
        "+stdlib_error_is_caught()+as+caught",
    )
    assert row == {"v": VERSION, "stdlib": VERSION, "caught": 1}
    # The file was loaded by Datasette Lite's own sqlite3 code
    rows = fetch_json(page, "/data/items.json?_shape=array")
    assert [(r["name"], r["note"]) for r in rows] == [
        ("Widget", "from-sql"),
        ("Gadget", "from-sql"),
        ("Sprocket", "from-sql"),
    ]
    # ?sqlite= stays in the page's URL as the #fragment changes
    datasette_frame(page).evaluate("location.href = location.pathname.replace(/-\\/versions.json$/, 'data')")
    page.wait_for_function("location.hash == '#/data'", timeout=60 * 1000)
    assert "sqlite=" + VERSION in page.evaluate("location.search")


@pytest.mark.network
def test_sqlite_version_with_stable_datasette(page, static_server):
    boot(
        page,
        static_server + "/?memory=1&ref=stable&sqlite={}#/-/versions.json".format(VERSION),
        wait_for="pre",
    )
    assert fetch_json(page, "/-/versions.json")["sqlite"]["version"] == VERSION

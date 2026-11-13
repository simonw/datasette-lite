"""Things the old innerHTML-based Datasette Lite could not do at all:
running page JavaScript (core and plugins), POST requests, cookies (CSRF
tokens, sign-in, flash messages), file uploads and downloads."""
import json
import re
import time

import pytest
from playwright.sync_api import Browser, Page, expect

from conftest import app_path, boot, datasette_frame, wait_for_boot, wait_for_hash

F = "tests/fixtures/"


@pytest.fixture
def page(browser: Browser):
    page = browser.new_page()
    yield page
    page.close()


def iframe_base(page: Page):
    return re.match(r"(/app/[^/]+)", datasette_frame(page).evaluate("location.pathname")).group(1)


def fetch_json(page: Page, path, options=None):
    return datasette_frame(page).evaluate(
        """async ([path, options]) => {
            const response = await fetch(path, options || {});
            return {status: response.status, json: await response.json()};
        }""",
        [path, options],
    )


def actor(page: Page):
    return fetch_json(page, iframe_base(page) + "/-/actor.json")["json"]["actor"]


# --- Core Datasette JavaScript ------------------------------------------------


def test_core_javascript_format_sql(page, static_server):
    frame = boot(page, static_server + "/?memory=1#/_memory?sql=select+1+as+a,+2+as+b")
    expect(frame.locator(".CodeMirror")).to_be_visible()
    frame.locator("#sql-format").click()
    value = datasette_frame(page).evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert value != "select 1 as a, 2 as b"
    assert "\n" in value


def test_core_javascript_column_actions_menu(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
    # table.js adds a cog menu to each column header
    frame.locator("th.col-qty svg.dropdown-menu-icon").click()
    menu = frame.locator(".dropdown-menu")
    expect(menu).to_be_visible()
    menu.locator("a", has_text="Sort descending").click()
    wait_for_hash(page, r"^/data/items\?_sort_desc=qty$")
    expect(frame.locator("td.col-name").first).to_have_text("Gadget")


def test_json_export_link(page, static_server):
    "The double-applied base_url bug in export links is worked around"
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
    link = frame.locator(".export-links a", has_text="json").first
    href = link.get_attribute("href")
    assert href.startswith(iframe_base(page) + "/data/items.json")
    assert "/app/" not in href[len(iframe_base(page)):]
    link.click()
    wait_for_hash(page, r"^/data/items\.json")
    data = json.loads(page.frame_locator("#datasette").locator("pre").text_content())
    assert len(data["rows"]) == 3


def test_csv_download(page, static_server):
    boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
    base = iframe_base(page)
    with page.expect_download() as download_info:
        datasette_frame(page).evaluate(
            "base => { const a = document.createElement('a'); a.href = base + '/data/items.csv?_dl=1'; document.body.appendChild(a); a.click(); }",
            base,
        )
    download = download_info.value
    assert download.suggested_filename == "items.csv"
    content = open(download.path()).read()
    assert content.splitlines()[0] == "rowid,id,name,qty,price"
    assert "Gadget" in content


# --- Plugins that ship JavaScript -----------------------------------------------


def test_plugin_datasette_cluster_map(page, static_server):
    frame = boot(
        page,
        static_server + "/?install=datasette-cluster-map&csv=" + F + "places.csv#/data/places",
    )
    # The plugin's JavaScript (served from /-/static-plugins/) fetches the
    # table's .json and renders a Leaflet map with a marker cluster
    expect(frame.locator(".leaflet-container")).to_be_visible(timeout=30 * 1000)
    expect(frame.locator(".marker-cluster, .leaflet-marker-icon").first).to_be_attached(timeout=30 * 1000)


def test_plugin_datasette_vega(page, static_server):
    frame = boot(page, static_server + "/?install=datasette-vega&csv=" + F + "items.csv#/data/items")
    # datasette-vega hardcodes /-/static-plugins/ URLs that ignore base_url;
    # the service worker routes them back to this session
    frame.locator(".datasette-vega-inactive button").click(timeout=30 * 1000)
    expect(frame.locator(".datasette-vega")).to_be_visible()
    frame.locator(".datasette-vega select[name=x_column]").select_option("name")
    frame.locator(".datasette-vega select[name=y_column]").select_option("qty")
    frame.locator(".datasette-vega input[name=mark][value=bar]").check()
    # The chart's data comes from fetch()ing the table's .json export link
    expect(frame.locator("canvas.marks, svg.marks").first).to_be_visible(timeout=30 * 1000)


def test_plugin_datasette_copyable(page, static_server):
    "Custom output formats from a register_output_renderer plugin"
    frame = boot(
        page,
        static_server
        + "/?install=datasette-copyable&csv=" + F + "items.csv#/data/items.copyable?_table_format=github",
    )
    expect(frame.locator("textarea.copyable")).to_contain_text("| Widget")


# --- POST requests, CSRF and cookies -------------------------------------------


def test_root_sign_in_and_logout(page, static_server):
    frame = boot(page, static_server + "/?memory=1&root=1")
    assert actor(page) == {"id": "root"}
    # Log out is a POST form with a CSRF token; the message is a signed cookie
    datasette_frame(page).evaluate("location.href = location.pathname.replace(/\\/$/, '') + '/-/logout'")
    expect(frame.locator("form input[type=submit]")).to_be_visible()
    frame.locator("form input[type=submit]").click()
    expect(frame.locator(".message-warning, .message-info").first).to_contain_text("logged out")
    assert actor(page) is None


def test_no_actor_by_default(page, static_server):
    boot(page, static_server + "/?memory=1")
    assert actor(page) is None


def test_core_messages_debug_post(page, static_server):
    "/-/messages is a root-only POST form - exercises CSRF + messages cookie"
    frame = boot(page, static_server + "/?memory=1&root=1#/-/messages")
    frame.locator("input[name=message]").fill("Hello from a POST")
    frame.locator("form input[type=submit]").click()
    expect(frame.locator(".message-info, .message-warning, .message-error").first).to_contain_text(
        "Hello from a POST"
    )


def test_plugin_datasette_write(page, static_server):
    frame = boot(
        page,
        static_server + "/?root=1&install=datasette-write&csv=" + F + "items.csv#/data/-/write",
        wait_for="textarea[name=sql]",
    )
    frame.locator("textarea[name=sql]").fill(
        "insert into items (id, name, qty, price) values (4, 'Bolt', 100, 0.1)"
    )
    frame.locator("form.write-form input[type=submit]").click()
    expect(frame.locator(".message-info")).to_contain_text("1 row affected")
    rows = fetch_json(page, iframe_base(page) + "/data/items.json?_shape=array")["json"]
    assert rows[-1]["name"] == "Bolt"


def test_plugin_datasette_write_forbidden_without_root(page, static_server):
    frame = boot(
        page,
        static_server + "/?install=datasette-write&csv=" + F + "items.csv#/data/-/write",
        wait_for="h1",
    )
    expect(frame.locator("body")).to_contain_text("Permission denied")


def test_plugin_datasette_auth_passwords(page, static_server):
    frame = boot(
        page,
        static_server
        + "/?memory=1&install=datasette-auth-passwords&metadata=" + F + "auth-metadata.json#/-/login",
        wait_for="form.password-login",
    )
    frame.locator("#id_username").fill("simon")
    frame.locator("#id_password").fill("wrong")
    frame.locator("form.password-login input[type=submit]").click()
    expect(frame.locator("body")).to_contain_text("Invalid username or password")
    frame.locator("#id_username").fill("simon")
    frame.locator("#id_password").fill("password123")
    frame.locator("form.password-login input[type=submit]").click()
    # Redirects to the homepage, with a ds_actor cookie in the bridge's jar
    wait_for_hash(page, "^/$")
    assert actor(page) == {"id": "simon"}


def test_plugin_hardcoded_form_action(page, static_server):
    """datasette-auth-passwords' password tool form has action="/-/password-tool"
    - ignoring base_url. The service worker routes that POST back to Datasette."""
    frame = boot(
        page,
        static_server + "/?memory=1&install=datasette-auth-passwords#/-/password-tool",
        wait_for="input[name=password]",
    )
    frame.locator("input[name=password]").fill("secret")
    frame.locator("form input[type=submit]").click()
    expect(frame.locator("body")).to_contain_text("pbkdf2_sha256$")
    wait_for_hash(page, "^/-/password-tool$")


def test_plugin_datasette_upload_csvs(page, static_server):
    "Multipart file upload, via the plugin's own XHR JavaScript and progress polling"
    frame = boot(
        page,
        static_server + "/?root=1&install=datasette-upload-csvs&csv=" + F + "items.csv#/-/upload-csvs",
        wait_for="input[type=file]",
    )
    frame.locator("input[type=file]").set_input_files(
        files=[{"name": "uploaded.csv", "mimeType": "text/csv", "buffer": b"id,animal\n1,cat\n2,dog\n3,fox\n"}]
    )
    frame.locator("input[type=submit]").click()
    expect(frame.locator("body")).to_contain_text("uploaded", timeout=30 * 1000)
    base = iframe_base(page)
    page.wait_for_function(
        """async base => {
            const r = await document.querySelector('#datasette').contentWindow.fetch(base + '/data/uploaded.json?_shape=array');
            if (r.status != 200) return false;
            return (await r.json()).length == 3;
        }""",
        arg=base,
        timeout=30 * 1000,
    )
    rows = fetch_json(page, base + "/data/uploaded.json?_shape=array")["json"]
    assert [r["animal"] for r in rows] == ["cat", "dog", "fox"]


def test_plugin_datasette_edit_schema(page, static_server):
    frame = boot(
        page,
        static_server + "/?root=1&install=datasette-edit-schema&csv=" + F + "items.csv#/-/edit-schema/data/items",
        wait_for="input[name=rename_table]",
    )
    rename = frame.locator("form", has=frame.locator("input[name=rename_table]"))
    rename.locator("input[name=name]").fill("renamed_items")
    rename.locator("input[type=submit]").click()
    wait_for_hash(page, "renamed_items")
    tables = fetch_json(page, iframe_base(page) + "/data.json")["json"]["tables"]
    assert [t["name"] for t in tables] == ["renamed_items"]


# --- Datasette 1.0 alpha ---------------------------------------------------------


@pytest.fixture(scope="module")
def pre_page(browser: Browser, static_server):
    page = browser.new_page()
    boot(page, static_server + "/?ref=pre&root=1&csv=" + F + "items.csv#/data/items")
    yield page
    page.close()


def test_pre_root_actor(pre_page):
    assert actor(pre_page) == {"id": "root"}


def test_pre_json_write_api(pre_page):
    base = iframe_base(pre_page)
    result = fetch_json(
        pre_page,
        base + "/data/items/-/insert",
        {
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": json.dumps({"row": {"id": 99, "name": "Inserted by API", "qty": 1, "price": 9.5}}),
        },
    )
    assert result["status"] == 201, result
    rows = fetch_json(pre_page, base + "/data/items.json?_shape=array&id=99")["json"]
    assert rows[0]["name"] == "Inserted by API"


def test_pre_create_table_api(pre_page):
    base = iframe_base(pre_page)
    result = fetch_json(
        pre_page,
        base + "/data/-/create",
        {
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": json.dumps({"table": "created", "rows": [{"id": 1, "x": "y"}], "pk": "id"}),
        },
    )
    assert result["status"] == 201, result
    datasette_frame(pre_page).evaluate("base => location.href = base + '/data/created'", base)
    wait_for_hash(pre_page, "^/data/created$")
    expect(pre_page.frame_locator("#datasette").locator("td.col-x")).to_have_text("y")


def test_pre_codemirror_6_and_query(pre_page):
    frame = pre_page.frame_locator("#datasette")
    datasette_frame(pre_page).evaluate("base => location.href = base + '/data'", iframe_base(pre_page))
    wait_for_hash(pre_page, "^/data$")
    editor = frame.locator(".cm-content")
    expect(editor).to_be_visible()
    editor.click()
    pre_page.keyboard.press("ControlOrMeta+a")
    pre_page.keyboard.type("select 'from cm6' as v")
    frame.locator("form.sql input[type=submit]").first.click()
    expect(frame.locator("td.col-v")).to_have_text("from cm6")


def test_pre_jump_navigation(pre_page):
    "1.0a's 'Jump to' search hardcodes /-/jump - must still be answered"
    base = iframe_base(pre_page)
    result = fetch_json(pre_page, "/-/jump?q=items")
    assert result["status"] == 200
    result2 = fetch_json(pre_page, base + "/-/jump?q=items")
    assert result2["json"] == result["json"]
    assert any("items" in json.dumps(m) for m in result["json"]["matches"])


# --- Multiple tabs, new tabs, service worker restarts -----------------------------


def test_two_tabs_are_isolated(browser: Browser, static_server):
    context = browser.new_context()
    one = context.new_page()
    two = context.new_page()
    try:
        frame_one = boot(one, static_server + "/?csv=" + F + "items.csv")
        frame_two = boot(two, static_server + "/?url=" + F + "generated/demo.db")
        expect(frame_one.locator("h2")).to_have_text(["data"])
        expect(frame_two.locator("h2")).to_have_text(["demo"])
        # Navigate both again - each is answered by its own Pyodide
        one.evaluate("location.hash = '#/data/items'")
        two.evaluate("location.hash = '#/demo/dogs'")
        expect(frame_one.locator("h1")).to_contain_text("items")
        expect(frame_two.locator("h1")).to_contain_text("dogs")
    finally:
        context.close()


def test_app_url_opened_in_new_tab_redirects_to_shell(browser: Browser, static_server):
    context = browser.new_context()
    try:
        page = context.new_page()
        boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
        iframe_url = datasette_frame(page).url + "?_sort=name"
        new_tab = context.new_page()
        new_tab.goto(iframe_url)
        new_tab.wait_for_url(re.compile(r"/\?csv=.*#/data/items\?_sort=name$"))
        wait_for_boot(new_tab)
        expect(new_tab.frame_locator("#datasette").locator("td.col-name").first).to_have_text("Gadget")
    finally:
        context.close()


def test_survives_service_worker_restart(page, static_server):
    frame = boot(page, static_server + "/?memory=1")
    cdp = page.context.new_cdp_session(page)
    cdp.send("ServiceWorker.enable")
    cdp.send("ServiceWorker.stopAllWorkers")
    page.evaluate("location.hash = '#/_memory?sql=select+42+as+answer'")
    expect(frame.locator("td.col-answer")).to_have_text("42")


def test_hard_reload(page, static_server):
    boot(page, static_server + "/?memory=1#/_memory")
    cdp = page.context.new_cdp_session(page)
    cdp.send("Page.reload", {"ignoreCache": True})
    page.wait_for_timeout(500)
    wait_for_boot(page)
    expect(page.frame_locator("#datasette").locator("h1")).to_have_text("_memory")
    assert app_path(page) == "/_memory"


def test_served_from_subpath(page, subpath_server):
    """Deployed under /sub/ the service worker scope is /sub/ - hardcoded
    root-relative /-/ URLs from plugins land outside it, but requests from a
    controlled page still reach the service worker, which routes them back."""
    frame = boot(
        page,
        subpath_server
        + "/?memory=1&install=datasette-auth-passwords&csv=tests/fixtures/items.csv#/-/password-tool",
        wait_for="input[name=password]",
    )
    assert datasette_frame(page).evaluate("location.pathname").startswith("/sub/app/")
    frame.locator("input[name=password]").fill("secret")
    frame.locator("form input[type=submit]").click()
    expect(frame.locator("body")).to_contain_text("pbkdf2_sha256$")
    wait_for_hash(page, "^/-/password-tool$")
    # fetch() of a hardcoded /-/ URL from a Datasette page
    result = fetch_json(page, "/-/versions.json")
    assert result["status"] == 200
    assert "datasette" in result["json"]
    # And regular navigation
    page.evaluate("location.hash = '#/data/items'")
    expect(frame.locator("td.col-name").first).to_have_text("Widget")


def test_silent_same_origin_window_does_not_stall_requests(browser: Browser, static_server):
    """A same-origin window that never answers the service worker's "do you
    own this session?" question must not hold up requests for the timeout."""
    context = browser.new_context()
    try:
        page = context.new_page()
        frame = boot(page, static_server + "/?memory=1")
        silent = context.new_page()
        silent.goto(static_server + "/" + F + "plain.html")
        expect(silent.locator("#plain")).to_be_visible()
        # A single request...
        elapsed_ms = datasette_frame(page).evaluate(
            """async (url) => {
                const start = performance.now();
                await (await fetch(url)).json();
                return performance.now() - start;
            }""",
            iframe_base(page) + "/-/versions.json",
        )
        assert elapsed_ms < 1000, elapsed_ms
        # ...and a full iframe navigation
        start = time.monotonic()
        page.evaluate("location.hash = '#/_memory?sql=select+42+as+answer'")
        expect(frame.locator("td.col-answer")).to_have_text("42")
        assert time.monotonic() - start < 1.5
    finally:
        context.close()


def test_worker_error_fails_pending_requests(page, static_server):
    "If the Pyodide worker dies, requests waiting on it get a 500, not a hang"
    boot(page, static_server + "/?memory=1")
    base = iframe_base(page)
    # Kill the worker, so the next request is never answered...
    page.evaluate("datasetteWorker.terminate()")
    datasette_frame(page).evaluate(
        """url => {
            window.pendingFetch = fetch(url).then(
                async (response) => ({status: response.status, text: await response.text()})
            );
        }""",
        base + "/-/versions.json",
    )
    # ...give that request time to reach the shell page...
    page.wait_for_function("pending.size == 1", timeout=10 * 1000)
    # ...then report the death the way the browser would
    page.evaluate("datasetteWorker.dispatchEvent(new ErrorEvent('error', {message: 'out of memory'}))")
    result = datasette_frame(page).evaluate(
        """() => Promise.race([
            window.pendingFetch,
            new Promise((resolve) => setTimeout(() => resolve("timed out"), 5000)),
        ])"""
    )
    assert result != "timed out"
    assert result["status"] == 500
    assert "out of memory" in result["text"]
    assert page.evaluate("pending.size") == 0


def test_cross_origin_iframe_does_not_break_load_handler(page, static_server):
    """If the iframe ends up on another origin (an OAuth redirect, say) the
    shell's load handler must not throw reading its location."""
    boot(page, static_server + "/?memory=1")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # Same server, different origin: 127.0.0.1 instead of localhost
    other_origin = static_server.replace("localhost", "127.0.0.1")
    assert other_origin != static_server
    page.evaluate(
        """url => new Promise((resolve) => {
            const frame = document.getElementById("datasette");
            // Registered after shell.js's handler, so runs after it
            frame.addEventListener("load", () => setTimeout(resolve, 0), {once: true});
            frame.src = url;
        })""",
        other_origin + "/" + F + "plain.html",
    )
    expect(page.frame_locator("#datasette").locator("#plain")).to_be_visible()
    assert errors == []
    assert app_path(page) == "/"

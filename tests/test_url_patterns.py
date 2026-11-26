"""Every documented Datasette Lite URL pattern must keep working.

Uses small local fixture files from tests/fixtures/ so these are fast and
do not depend on third party hosts (except where noted)."""
import json
import re
from urllib.parse import quote

import pytest
from playwright.sync_api import Page, expect

from conftest import app_path, boot, database_names, datasette_frame, wait_for_boot, wait_for_hash

F = "tests/fixtures/"


@pytest.fixture
def page(shared_context):
    page = shared_context.new_page()
    yield page
    page.close()


def table_json(page: Page, path):
    "Fetch a JSON API URL from inside the Datasette iframe (served by the SW)"
    return datasette_frame(page).evaluate(
        "async path => (await fetch(path)).json()", path
    )


def iframe_base(page: Page):
    "The base_url the iframe is using, e.g. /app/abc123"
    return re.match(r"(/app/[^/]+)", datasette_frame(page).evaluate("location.pathname")).group(1)


def test_url_loads_database_named_from_filename(page, static_server):
    boot(page, static_server + "/?url=" + F + "generated/demo.db")
    assert database_names(page) == ["demo"]


def test_url_repeated_gets_suffixes(page, static_server):
    boot(
        page,
        static_server
        + "/?url={F}generated/demo.db&url={F}generated/other.db&url={F}generated/demo.db".format(F=F),
    )
    assert database_names(page) == ["demo", "other", "demo_2"]


def test_url_database_names_drop_the_file_extension(page, static_server):
    """A database is named after its file without the extension, whatever
    the extension is - existing #/chinook/Album style links depend on it."""
    frame = boot(
        page,
        static_server
        + "/?url={F}generated/extension.sqlite&url={F}generated/dotted.name.db"
        "&url={F}generated/demo.db&url={F}generated/demo.db#/extension/dogs".format(F=F),
        wait_for="td.col-name",
    )
    expect(frame.locator("td.col-name").first).to_have_text("Cleo")
    assert database_names(page) == ["extension", "dotted", "demo", "demo_2"]


def test_csv_with_type_detection(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
    expect(page).to_have_title(re.compile("data: items"))
    base = iframe_base(page)
    data = table_json(page, base + "/data/items.json?_shape=array")
    assert data == [
        {"rowid": 1, "id": 1, "name": "Widget", "qty": 5, "price": 1.5},
        {"rowid": 2, "id": 2, "name": "Gadget", "qty": 12, "price": 2.25},
        {"rowid": 3, "id": 3, "name": "Sprocket", "qty": 7, "price": 0.75},
    ]


def test_csv_semicolon_and_repeated(page, static_server):
    boot(page, static_server + "/?csv={F}semicolon.csv&csv={F}items.csv&csv={F}items.csv".format(F=F))
    base = iframe_base(page)
    tables = table_json(page, base + "/data.json")
    names = sorted(t["name"] for t in tables["tables"])
    assert names == ["items", "items_1", "semicolon"]
    rows = table_json(page, base + "/data/semicolon.json?_shape=array")
    assert rows[0]["city"] == "Paris"
    assert rows[0]["population"] == 2100000


def test_json_variants(page, static_server):
    boot(
        page,
        static_server
        + "/?json={F}rows.json&json={F}nested.json&json={F}keyed.json&json={F}lines.ndjson".format(F=F),
    )
    base = iframe_base(page)
    assert table_json(page, base + "/data/rows.json?_shape=array") == [
        {"rowid": 1, "id": 1, "name": "Item 1"},
        {"rowid": 2, "id": 2, "name": "Item 2"},
    ]
    nested = table_json(page, base + "/data/nested.json?_shape=array")
    assert [r["name"] for r in nested] == ["One", "Two", "Three"]
    keyed = table_json(page, base + "/data/keyed.json?_shape=array")
    assert [r["_key"] for r in keyed] == ["anchor-positioning", "array-at"]
    lines = table_json(page, base + "/data/lines.json?_shape=array")
    assert [r["name"] for r in lines] == ["Line 1", "Line 2"]


def test_sql_runs_before_csv(page, static_server):
    # setup.sql creates "items" with an extra column; the CSV inserts into it
    boot(page, static_server + "/?csv={F}items.csv&sql={F}setup.sql".format(F=F))
    base = iframe_base(page)
    rows = table_json(page, base + "/data/items.json?_shape=array")
    assert [(r["name"], r["note"]) for r in rows] == [
        ("Widget", "from-sql"),
        ("Gadget", "from-sql"),
        ("Sprocket", "from-sql"),
    ]
    marker = table_json(page, base + "/data/setup_marker.json?_shape=array")
    assert marker == [{"rowid": 1, "value": "setup ran"}]


def test_memory(page, static_server):
    boot(page, static_server + "/?memory=1")
    assert database_names(page) == ["_memory"]


def test_metadata_json(page, static_server):
    frame = boot(page, static_server + "/?memory=1&metadata=" + F + "metadata.json")
    expect(frame.locator("h1")).to_have_text("Custom metadata title")
    expect(page).to_have_title(re.compile("^Custom metadata title"))


def test_metadata_yaml(page, static_server):
    frame = boot(page, static_server + "/?memory=1&metadata=" + F + "metadata.yml")
    expect(frame.locator("h1")).to_have_text("YAML metadata title")


def test_default_metadata_about_link(page, static_server):
    frame = boot(page, static_server + "/?memory=1")
    expect(frame.locator("footer a", has_text="Datasette Lite")).to_have_attribute(
        "href", "https://github.com/simonw/datasette-lite"
    )


def test_install_plugin(page, static_server):
    frame = boot(page, static_server + "/?memory=1&install=datasette-packages#/-/packages", wait_for="h1")
    expect(frame.locator("h1")).to_have_text(re.compile("Installed packages", re.I))
    expect(frame.locator("body")).to_contain_text("datasette-packages")


def test_install_multiple_plugins(page, static_server):
    frame = boot(
        page,
        static_server
        + "/?memory=1&install=datasette-haversine&install=datasette-statistics#/_memory?sql="
        + quote("select haversine(0, 154, 1, 131) as h, statistics_mean(1) as m"),
    )
    expect(frame.locator("td.col-h")).to_have_text(re.compile(r"^2\d\d\d\.\d+"))
    expect(frame.locator("td.col-m")).to_have_text("1.0")


def datasette_version(page, static_server, options):
    frame = boot(page, static_server + "/?memory=1" + options + "#/-/versions.json", wait_for="pre")
    return json.loads(frame.locator("pre").text_content())["datasette"]["version"]


def test_default_is_the_most_recent_release_including_previews(page, static_server):
    default = datasette_version(page, static_server, "")
    # ?ref=pre is the old name for what is now the default
    assert datasette_version(page, static_server, "&ref=pre") == default
    assert re.match(r"^1\.0a\d+", default)


def test_ref_stable_installs_the_stable_release(page, static_server):
    version = datasette_version(page, static_server, "&ref=stable")
    # No alpha, beta or release candidate suffix
    assert re.match(r"^\d+(\.\d+)+$", version), version


def test_config_requires_1_0(page, static_server):
    page.goto(static_server + "/?ref=stable&memory=1&config=" + F + "config.yml")
    page.wait_for_function("document.getElementById('output').textContent.length", timeout=180 * 1000)
    expect(page.locator("#output")).to_contain_text("?config= requires Datasette 1.0a8")


def test_config(page, static_server):
    boot(page, static_server + "/?config={F}config.yml&csv={F}items.csv".format(F=F))
    base = iframe_base(page)
    settings = table_json(page, base + "/-/settings.json")
    assert settings["default_page_size"] == 2
    # Datasette Lite's own base_url always wins
    assert settings["base_url"] == base + "/"


def test_s_template_debug(page, static_server):
    # ?s.template_debug=1 is datasette -s template_debug 1
    boot(page, static_server + "/?memory=1&s.template_debug=1")
    base = iframe_base(page)
    assert table_json(page, base + "/-/settings.json")["template_debug"] is True
    # ?_context=1 only shows the template context when template_debug is on.
    # Up to Datasette 1.0a43 that was the context as JSON in a <pre>; since
    # 1.0a44 it is a page describing each variable.
    html = datasette_frame(page).evaluate(
        "async path => (await fetch(path)).text()", base + "/?_context=1"
    )
    assert html.startswith("<pre>{") or "template context</title>" in html
    assert "datasette_version" in html


def test_s_multiple_nested_and_over_config(page, static_server):
    boot(
        page,
        static_server
        + "/?config={F}config.yml&csv={F}items.csv".format(F=F)
        + "&s.settings.default_page_size=3&s.max_returned_rows=7"
        + "&s.plugins.demo.options=" + quote('{"a": [1, 2]}')
        + "&s.base_url=/should-be-ignored/"
        # /-/config.json needs the permissions-debug permission since
        # Datasette 1.0a44, which the root actor has
        + "&root=1",
    )
    base = iframe_base(page)
    settings = table_json(page, base + "/-/settings.json")
    # Wins over the 2 in config.yml
    assert settings["default_page_size"] == 3
    assert settings["max_returned_rows"] == 7
    assert settings["base_url"] == base + "/"
    config = table_json(page, base + "/-/config.json")
    assert config["plugins"] == {"demo": {"options": {"a": [1, 2]}}}


def test_s_invalid_value_is_reported(page, static_server):
    page.goto(static_server + "/?memory=1&s.default_page_size=lots")
    page.wait_for_function("document.getElementById('output').textContent.length", timeout=180 * 1000)
    expect(page.locator("#output")).to_contain_text("?s.default_page_size=lots")
    expect(page.locator("#output")).to_contain_text("should be an integer")


def test_s_requires_1_0(page, static_server):
    page.goto(static_server + "/?ref=stable&memory=1&s.template_debug=1")
    page.wait_for_function("document.getElementById('output').textContent.length", timeout=180 * 1000)
    expect(page.locator("#output")).to_contain_text("?s.template_debug= requires Datasette 1.0a8")


def test_hash_with_query_string(page, static_server):
    frame = boot(page, static_server + "/?memory=1#/_memory?sql=" + quote("select 'hello' as greeting"))
    expect(frame.locator("td.col-greeting")).to_have_text("hello")


def test_hash_without_leading_slash(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#data/items")
    expect(frame.locator("h1")).to_contain_text("items")


def test_navigation_updates_hash_and_back_button(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv")
    assert app_path(page) == "/"
    # Follow a link: the homepage links to each table in every Datasette version
    frame.locator("a[href$='/data/items']").first.click()
    wait_for_hash(page, "^/data/items$")
    expect(page).to_have_title(re.compile("^data: items"))
    expect(frame.locator("h1")).to_contain_text("items")
    # Sort by a column - adds a query string
    datasette_frame(page).evaluate("location.href = location.pathname + '?_sort_desc=qty'")
    wait_for_hash(page, r"^/data/items\?_sort_desc=qty$")
    expect(frame.locator("td.col-name").first).to_have_text("Gadget")
    page.go_back()
    wait_for_hash(page, "^/data/items$")
    expect(frame.locator("td.col-name").first).to_have_text("Widget")
    page.go_back()
    wait_for_hash(page, "^/$")
    page.go_forward()
    wait_for_hash(page, "^/data/items$")
    # Startup options are preserved throughout
    assert "csv=" in page.url


def test_editing_hash_navigates(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv")
    page.evaluate("location.hash = '#/data/items?_size=1'")
    expect(frame.locator("h1")).to_contain_text("items")
    expect(frame.locator("tbody tr")).to_have_count(1)


def test_iframe_fragment_is_kept_in_hash(page, static_server):
    "Plugins such as datasette-vega keep their state in the page's own #fragment"
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#/data/items?_size=1#g.mark=bar")
    expect(frame.locator("tbody tr")).to_have_count(1)
    # The shell's load handler sets the title - after that the fragment must survive
    expect(page).to_have_title(re.compile("^data: items"))
    assert datasette_frame(page).evaluate("location.hash") == "#g.mark=bar"
    assert app_path(page) == "/data/items?_size=1#g.mark=bar"
    # A fragment change inside the page is mirrored in the address bar
    datasette_frame(page).evaluate("window.notReloaded = true; location.hash = 'g.mark=line'")
    wait_for_hash(page, r"^/data/items\?_size=1#g\.mark=line$")
    # So is one made with the History API, which does not fire "hashchange"
    datasette_frame(page).evaluate("history.replaceState(null, '', '#map=3/48/10&color=name')")
    wait_for_hash(page, r"^/data/items\?_size=1#map=3/48/10&color=name$")
    datasette_frame(page).evaluate("history.pushState(null, '', '#g.mark=area')")
    wait_for_hash(page, r"^/data/items\?_size=1#g\.mark=area$")
    # Editing just the fragment in the address bar updates the page without reloading it
    page.evaluate("location.hash = '#/data/items?_size=1#g.mark=circle'")
    page.wait_for_function(
        "document.getElementById('datasette').contentWindow.location.hash === '#g.mark=circle'"
    )
    assert datasette_frame(page).evaluate("window.notReloaded") is True
    # Navigating to a page without a fragment drops it again
    datasette_frame(page).evaluate("location.href = location.pathname + '?_size=2'")
    wait_for_hash(page, r"^/data/items\?_size=2$")


@pytest.mark.parametrize(
    "encoded,expected_path,expected_rows",
    (
        # Opened from another app on iOS: the second # arrives as %23
        ("/data/items%23map=0/4.2/180&color=name", "/data/items#map=0/4.2/180&color=name", 3),
        # ... and any % that was already in the URL arrives as %25
        (
            "/data/items?name__contains=Spr%256Fcket%23map=0/4.2/180",
            "/data/items?name__contains=Spr%6Fcket#map=0/4.2/180",
            1,
        ),
        # A %23 in a query string value is left alone
        ("/data/items?name__contains=%23", "/data/items?name__contains=%23", 0),
    ),
)
def test_percent_encoded_iframe_fragment(page, static_server, encoded, expected_path, expected_rows):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#" + encoded)
    expect(frame.locator("h1")).to_contain_text("items")
    expect(frame.locator("tbody tr")).to_have_count(expected_rows)
    assert app_path(page) == expected_path


def test_get_form_submission(page, static_server):
    "The table filter form is a GET form"
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#/data/items")
    frame.locator(".filters input[name=_filter_value]").first.fill("Gadget")
    frame.locator(".filters select[name=_filter_column]").first.select_option("name")
    frame.locator(".filters input[type=submit]").click()
    wait_for_hash(page, r"^/data/items\?.*name.*Gadget")
    expect(frame.locator("tbody tr")).to_have_count(1)


def test_external_links_open_in_new_window(page, static_server):
    frame = boot(page, static_server + "/?memory=1")
    with page.expect_popup() as popup_info:
        frame.locator("footer a", has_text="Datasette Lite").click()
    popup = popup_info.value
    popup.wait_for_url("https://github.com/simonw/datasette-lite**")
    # Opened with noopener: the external site gets no handle on this page
    assert popup.evaluate("window.opener === null")
    popup.close()
    # The Datasette Lite page itself did not navigate away
    assert app_path(page) == "/"


@pytest.mark.parametrize(
    "blocked,expected",
    (
        # Pyodide cannot be downloaded: a blocked CDN, or no network
        ("**/pyodide.mjs", "pyodide.mjs"),
        # The worker script itself is missing
        ("**/webworker.js", "webworker.js"),
    ),
)
def test_worker_that_fails_to_start_shows_an_error(browser, static_server, blocked, expected):
    "A worker that dies before it starts must not leave the page on Loading..."
    # Its own context: the route must also apply to requests made by the worker
    context = browser.new_context()
    try:
        context.route(blocked, lambda route: route.abort())
        page = context.new_page()
        page.goto(static_server + "/?memory=1")
        output = page.locator("#output")
        expect(output).to_contain_text("Error", timeout=30 * 1000)
        expect(output).to_contain_text(expected)
        expect(page.locator("#loading-indicator")).to_be_hidden()
    finally:
        context.close()


def test_load_buttons(page, static_server):
    frame = boot(page, static_server + "/?memory=1")
    buttons = frame.locator("#load-custom button")
    expect(buttons).to_have_text(
        ["Load SQLite DB by URL", "Load CSV", "Load JSON", "Load Parquet", "Load SQL"]
    )
    # Styled like Datasette's own buttons, not left as browser defaults
    expect(buttons.first).to_have_css("border-radius", "5px")
    expect(buttons.first).to_have_css("background-color", "rgb(255, 255, 255)")
    expect(buttons.first).to_have_css("color", "rgb(36, 70, 93)")
    # The copy pinned to the loading screen went away with the loading screen
    expect(page.locator("#shell-footer")).to_be_hidden()
    csv_url = static_server + "/" + F + "items.csv"
    page.once("dialog", lambda dialog: dialog.accept(csv_url))
    frame.locator("#load-custom button.csv-url").click()
    # Loaded into the running Datasette and added to the URL: see
    # test_load_buttons.py
    wait_for_hash(page, "^/data/items$")
    assert page.url == (
        static_server + "/?memory=1&csv=" + quote(csv_url, safe="") + "#/data/items"
    )
    assert database_names(page) == ["_memory", "data"]


def test_github_and_gist_urls_rewritten(page, static_server):
    boot(page, static_server + "/?memory=1")
    assert page.evaluate(
        "fixUrl('https://github.com/simonw/datasette-lite/blob/main/README.md')"
    ) == "https://raw.githubusercontent.com/simonw/datasette-lite/main/README.md"
    assert page.evaluate(
        "fixUrl('https://gist.github.com/simonw/7eacc70cd8b2868be0a18796cec078b9')"
    ) == "https://gist.githubusercontent.com/simonw/7eacc70cd8b2868be0a18796cec078b9/raw"


def test_load_error_is_displayed(page, static_server):
    page.goto(static_server + "/?csv=" + F + "does-not-exist.csv")
    page.wait_for_function("document.getElementById('output').textContent.length", timeout=180 * 1000)
    expect(page.locator("#output")).to_contain_text("HTTP 404")
    # The line saying what went wrong leads, the traceback is a click away
    expect(page.locator("#output .error p")).to_contain_text("HTTP 404")
    traceback = page.locator("#output .error details pre")
    expect(traceback).to_be_hidden()
    page.locator("#output .error summary").click()
    expect(traceback).to_contain_text("Traceback")


def test_loading_screen_fits_a_phone(browser, static_server):
    # Its own context: a phone-sized one, where pyodide.mjs never arrives so
    # the page stays on the loading screen
    context = browser.new_context(
        viewport={"width": 375, "height": 700}, is_mobile=True, has_touch=True
    )
    try:
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        page.goto(static_server + "/?memory=1")
        expect(page.locator("#loading-indicator h1")).to_be_visible()
        # Without a viewport <meta> a phone lays the page out 980px wide
        assert page.evaluate("window.innerWidth") == 375
        page.evaluate(
            "showStep({id: 'long', bytes: 123456789, label:"
            " 'Downloading https://example.com/' + 'long-file-name-'.repeat(30) + '.db'})"
        )
        steps = page.locator("#loading-logs li")
        expect(steps).to_have_count(2)
        expect(steps.last).to_be_visible()
        # How much has been downloaded stays on one line, beside the URL
        expect(steps.last.locator(".step-detail")).to_have_text("123.5 MB")
        expect(steps.last.locator(".step-detail")).to_be_in_viewport(ratio=1)
        assert page.evaluate(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
        ), "the loading screen scrolls sideways"
    finally:
        context.close()


def test_downloads_do_not_wait_for_python(browser, static_server):
    "Files download while Pyodide loads, each as a step of its own"
    # Its own context: one where pyodide.mjs never arrives, so Python never
    # starts and the page stays on the loading screen
    context = browser.new_context()
    try:
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        db_url = static_server + "/" + F + "generated/demo.db"
        csv_url = static_server + "/" + F + "items.csv"
        page.goto(static_server + "/?url=" + db_url + "&csv=" + csv_url)
        steps = page.locator("#loading-logs li")
        for url in (db_url, csv_url):
            download = steps.filter(has_text="Downloading " + url)
            # Finished, and saying how much was downloaded
            expect(download).to_have_class("done")
            expect(download.locator(".step-detail")).to_contain_text(re.compile(r"^\d+ k?B"))
        # ... while Python is still on its way, with nothing else started
        expect(steps.first.locator(".step-label")).to_have_text("Loading Python (Pyodide)")
        expect(steps.first).not_to_have_class("done")
        expect(steps).to_have_count(3)
    finally:
        context.close()


def test_step_reports_progress_then_finishes(browser, static_server):
    "A step can be renamed and report bytes while in progress, then finish"
    context = browser.new_context()
    try:
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        page.goto(static_server + "/?memory=1")
        step = page.locator("#loading-logs li").nth(1)
        page.evaluate("showStep({id: 'x', label: 'Installing Datasette'})")
        expect(step.locator(".step-label")).to_have_text("Installing Datasette")
        expect(step).not_to_have_class("done")
        page.evaluate("showStep({id: 'x', label: 'Installing Datasette 1.0', bytes: 2048})")
        expect(step.locator(".step-label")).to_have_text("Installing Datasette 1.0")
        expect(step.locator(".step-detail")).to_contain_text("2 kB")
        # The time taken so far is shown once it is worth showing
        expect(step.locator(".step-detail")).to_contain_text(re.compile(r"\d s$"))
        page.evaluate("showStep({id: 'x', done: true})")
        expect(step).to_have_class("done")
        expect(step.locator(".step-detail")).to_contain_text(re.compile(r"\d\.\d s$"))
        # Still one step, not three
        expect(page.locator("#loading-logs li")).to_have_count(2)
    finally:
        context.close()


def test_load_buttons_on_loading_screen(browser, static_server):
    "The buttons are pinned to the bottom of the loading screen and work from there"
    # Its own context: a phone-sized one, where pyodide.mjs never arrives so
    # the page stays on the loading screen
    context = browser.new_context(
        viewport={"width": 375, "height": 700}, is_mobile=True, has_touch=True
    )
    try:
        context.route("**/pyodide.mjs", lambda route: None)
        page = context.new_page()
        page.goto(static_server + "/?memory=1")
        expect(page.locator("#loading-indicator h1")).to_be_visible()
        buttons = page.locator("#shell-footer #load-custom button")
        expect(buttons).to_have_text(
            ["Load SQLite DB by URL", "Load CSV", "Load JSON", "Load Parquet", "Load SQL"]
        )
        expect(buttons.first).to_have_css("border-radius", "5px")
        # All in view without scrolling, at the bottom of the window
        for button in buttons.all():
            expect(button).to_be_in_viewport(ratio=1)
        expect(page.locator("#shell-footer a")).to_be_in_viewport(ratio=1)
        footer_bottom = "document.getElementById('shell-footer').getBoundingClientRect().bottom"
        assert page.evaluate(footer_bottom) == 700
        # A page longer than the window scrolls behind the buttons, which stay
        # where they are and do not cover the end of it
        page.evaluate(
            "for (let i = 0; i < 40; i++) {"
            " showStep({id: 'package-' + i, label: 'Installing package-' + i}) }"
        )
        page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        assert page.evaluate("window.scrollY") > 0
        assert page.evaluate(footer_bottom) == 700
        assert page.evaluate(
            "document.getElementById('loading-note').getBoundingClientRect().bottom"
            " <= document.getElementById('shell-footer').getBoundingClientRect().top"
        ), "the buttons cover the end of the loading screen"
        assert page.evaluate(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
        ), "the loading screen scrolls sideways"
        # No need to wait for Datasette to start before loading something else
        csv_url = static_server + "/" + F + "items.csv"
        page.once("dialog", lambda dialog: dialog.accept(csv_url))
        page.locator("#shell-footer button.csv-url").click()
        page.wait_for_url("**/?csv=*")
        assert page.url == static_server + "/?csv=" + quote(csv_url, safe="")
    finally:
        context.close()


@pytest.mark.network
def test_csv_from_github_blob_url(page, static_server):
    frame = boot(
        page,
        static_server
        + "/?csv=https://github.com/fivethirtyeight/data/blob/master/fight-songs/fight-songs.csv#/data/fight-songs",
    )
    expect(frame.locator("h1")).to_contain_text("fight-songs")


@pytest.mark.network
def test_parquet(page, static_server):
    frame = boot(
        page,
        static_server
        + "/?parquet=https://github.com/Teradata/kylo/blob/master/samples/sample-data/parquet/userdata1.parquet#/data/userdata1",
    )
    expect(frame.locator("h3").first).to_contain_text("1,000 rows")

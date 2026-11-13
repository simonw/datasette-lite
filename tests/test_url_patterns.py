"""Every documented Datasette Lite URL pattern must keep working.

Uses small local fixture files from tests/fixtures/ so these are fast and
do not depend on third party hosts (except where noted)."""
import json
import re
from urllib.parse import quote

import pytest
from playwright.sync_api import Page, expect

from conftest import app_path, boot, datasette_frame, wait_for_boot, wait_for_hash

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
    frame = boot(page, static_server + "/?url=" + F + "generated/demo.db")
    expect(frame.locator("h2")).to_have_text(["demo"])


def test_url_repeated_gets_suffixes(page, static_server):
    frame = boot(
        page,
        static_server
        + "/?url={F}generated/demo.db&url={F}generated/other.db&url={F}generated/demo.db".format(F=F),
    )
    expect(frame.locator("h2")).to_have_text(["demo", "other", "demo_2"])


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
    page.evaluate("location.hash = '#/'")
    expect(frame.locator("h2")).to_have_text(["extension", "dotted", "demo", "demo_2"])


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
    frame = boot(page, static_server + "/?memory=1")
    expect(frame.locator("h2")).to_have_text(["_memory"])


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


def test_ref_pre_installs_prerelease(page, static_server):
    frame = boot(page, static_server + "/?memory=1&ref=pre#/-/versions.json", wait_for="pre")
    info = json.loads(frame.locator("pre").text_content())
    assert re.match(r"^1\.0a\d+", info["datasette"]["version"])


def test_config_requires_1_0(page, static_server):
    page.goto(static_server + "/?memory=1&config=" + F + "config.yml")
    page.wait_for_function("document.getElementById('output').textContent.length", timeout=180 * 1000)
    expect(page.locator("#output")).to_contain_text("?config= requires Datasette 1.0a8")


def test_config_with_ref_pre(page, static_server):
    boot(page, static_server + "/?ref=pre&config={F}config.yml&csv={F}items.csv".format(F=F))
    base = iframe_base(page)
    settings = table_json(page, base + "/-/settings.json")
    assert settings["default_page_size"] == 2
    # Datasette Lite's own base_url always wins
    assert settings["base_url"] == base + "/"


def test_hash_with_query_string(page, static_server):
    frame = boot(page, static_server + "/?memory=1#/_memory?sql=" + quote("select 'hello' as greeting"))
    expect(frame.locator("td.col-greeting")).to_have_text("hello")


def test_hash_without_leading_slash(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv#data/items")
    expect(frame.locator("h1")).to_contain_text("items")


def test_navigation_updates_hash_and_back_button(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv")
    assert app_path(page) == "/"
    frame.locator("h2 a", has_text="data").click()
    wait_for_hash(page, "^/data$")
    expect(page).to_have_title("data")
    frame.locator("a", has_text="items").first.click()
    wait_for_hash(page, "^/data/items$")
    expect(frame.locator("h1")).to_contain_text("items")
    # Sort by a column - adds a query string
    datasette_frame(page).evaluate("location.href = location.pathname + '?_sort_desc=qty'")
    wait_for_hash(page, r"^/data/items\?_sort_desc=qty$")
    expect(frame.locator("td.col-name").first).to_have_text("Gadget")
    page.go_back()
    wait_for_hash(page, "^/data/items$")
    expect(frame.locator("td.col-name").first).to_have_text("Widget")
    page.go_back()
    wait_for_hash(page, "^/data$")
    page.go_forward()
    wait_for_hash(page, "^/data/items$")
    # Startup options are preserved throughout
    assert "csv=" in page.url


def test_editing_hash_navigates(page, static_server):
    frame = boot(page, static_server + "/?csv=" + F + "items.csv")
    page.evaluate("location.hash = '#/data/items?_size=1'")
    expect(frame.locator("h1")).to_contain_text("items")
    expect(frame.locator("tbody tr")).to_have_count(1)


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
    csv_url = static_server + "/" + F + "items.csv"
    page.once("dialog", lambda dialog: dialog.accept(csv_url))
    frame.locator("#load-custom button.csv-url").click()
    page.wait_for_url("**/?csv=*")
    assert page.url == static_server + "/?csv=" + quote(csv_url, safe="")
    wait_for_boot(page)
    expect(page.frame_locator("#datasette").locator("h2")).to_have_text(["data"])


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

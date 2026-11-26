"""The "Load CSV" etc buttons load a file into the Datasette that is already
running - no page reload - and then add it to the page's URL, so that the URL
is still a link to what is on screen."""
import pytest
from playwright.sync_api import Page, expect

from conftest import app_path, boot, database_names, datasette_frame, wait_for_hash

F = "tests/fixtures/"


@pytest.fixture
def page(shared_context):
    page = shared_context.new_page()
    yield page
    page.close()


def table_names(page: Page, database="data"):
    data = datasette_frame(page).evaluate(
        """async (database) => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            return (await fetch(base + "/" + database + ".json")).json();
        }""",
        database,
    )
    return sorted(table["name"] for table in data["tables"])


def start(page: Page, url):
    boot(page, url)
    # Lost if the page reloads
    page.evaluate("window.notReloaded = true")


def click_load(page: Page, button, url, expected_hash):
    "Click a load button, answer its prompt with url, wait for the result"
    page.once("dialog", lambda dialog: dialog.accept(url))
    page.frame_locator("#datasette").locator("#load-custom button." + button).click()
    wait_for_hash(page, expected_hash)
    page.wait_for_function("document.body.classList.contains('ready')")
    assert page.evaluate("window.notReloaded"), "The page reloaded"


def search(page: Page):
    return page.evaluate("location.search")


def test_load_csv_into_running_datasette(page, static_server):
    start(page, static_server + "/?url=" + F + "generated/demo.db")
    csv = static_server + "/" + F + "items.csv"
    click_load(page, "csv-url", csv, "^/data/items$")
    assert search(page) == "?url=" + F + "generated/demo.db&csv=" + csv.replace(":", "%3A").replace("/", "%2F")
    assert database_names(page) == ["demo", "data"]
    expect(page.frame_locator("#datasette").locator("td.col-name").first).to_have_text("Widget")
    # The same CSV again, then JSON and SQL: all into the same database
    click_load(page, "csv-url", csv, "^/data/items_1$")
    click_load(page, "json-url", static_server + "/" + F + "rows.json", "^/data/rows$")
    assert table_names(page) == ["items", "items_1", "rows"]
    assert search(page).count("csv=") == 2 and "&json=" in search(page)
    # Another database, which goes before data as it would if the URL was loaded
    click_load(page, "db-url", static_server + "/" + F + "generated/other.db", "^/other$")
    assert database_names(page) == ["demo", "other", "data"]
    # The URL the page now has loads the same thing from scratch
    url = page.evaluate("location.href")
    other = page.context.new_page()
    try:
        boot(other, url.split("#")[0])
        assert database_names(other) == ["demo", "other", "data"]
        assert table_names(other) == ["items", "items_1", "rows"]
    finally:
        other.close()


def test_load_sql_into_running_datasette(page, static_server):
    start(page, static_server + "/?memory=1")
    click_load(page, "sql-url", static_server + "/" + F + "setup.sql", "^/data$")
    assert database_names(page) == ["_memory", "data"]
    assert table_names(page) == ["items", "setup_marker"]
    assert search(page).startswith("?memory=1&sql=")


def test_back_button_after_loading(page, static_server):
    start(page, static_server + "/?url=" + F + "generated/demo.db#/demo/dogs")
    click_load(page, "json-url", static_server + "/" + F + "rows.json", "^/data/rows$")
    page.go_back()
    wait_for_hash(page, "^/demo/dogs$")
    # Still the URL that loads both
    assert "&json=" in search(page)
    assert page.evaluate("window.notReloaded")


def test_failed_load_leaves_datasette_as_it_was(page, static_server):
    start(page, static_server + "/?url=" + F + "generated/demo.db")
    messages = []

    def on_dialog(dialog):
        messages.append(dialog.message)
        # The prompt for a URL, then the alert saying it could not be loaded.
        # plain.html is served, but is not JSON.
        dialog.accept(static_server + "/" + F + "plain.html")

    page.on("dialog", on_dialog)
    page.frame_locator("#datasette").locator("#load-custom button.json-url").click()
    for _ in range(100):
        if len(messages) == 2:
            break
        page.wait_for_timeout(100)
    page.wait_for_function("document.body.classList.contains('ready')")
    assert len(messages) == 2 and "could not be loaded" in messages[1], messages
    assert search(page) == "?url=" + F + "generated/demo.db"
    assert database_names(page) == ["demo"]
    assert page.evaluate("window.notReloaded")


def test_load_that_would_rename_a_database_reloads(page, static_server):
    # demo.db twice is demo and demo_2 - but with demo_2.db in the URL as well
    # the second demo.db is demo_3, so this cannot be added in place
    demo = static_server + "/" + F + "generated/demo.db"
    start(page, "{}/?url={}&url={}".format(static_server, demo, demo))
    assert database_names(page) == ["demo", "demo_2"]
    page.route("**/demo_2.db", lambda route: route.continue_(url=demo))
    page.once("dialog", lambda dialog: dialog.accept(static_server + "/" + F + "generated/demo_2.db"))
    page.frame_locator("#datasette").locator("#load-custom button.db-url").click()
    page.wait_for_function("!window.notReloaded")
    boot(page, page.url)
    assert database_names(page) == ["demo", "demo_3", "demo_2"]


@pytest.mark.network
@pytest.mark.parametrize("ref", ("", "?ref=stable"))
def test_load_replaces_the_default_databases(page, static_server, ref):
    start(page, static_server + "/" + ref)
    assert database_names(page) == ["fixtures", "content"]
    click_load(page, "csv-url", static_server + "/" + F + "items.csv", "^/data/items$")
    assert database_names(page) == ["data"]
    assert search(page).startswith((ref + "&csv=") if ref else "?csv=")
    frame = page.frame_locator("#datasette")
    expect(frame.locator("td.col-name").first).to_have_text("Widget")
    # The homepage no longer lists them either
    frame.locator("a[href$='/']").first.click()
    wait_for_hash(page, "^/$")
    expect(frame.locator("body")).not_to_contain_text("fixtures")


def test_loaded_data_survives_a_change_of_plugins(page, static_server, stream_plugin):
    "The Manage plugins dialog changes plugins in place, or in a new worker"
    start(page, static_server + "/?url=" + F + "generated/demo.db")
    click_load(page, "csv-url", static_server + "/" + F + "items.csv", "^/data/items$")
    click_load(page, "db-url", static_server + "/" + F + "generated/other.db", "^/other$")
    # In place: a new Datasette over the same files
    page.evaluate("installs => applyInstalls(installs, () => {})", [stream_plugin])
    assert database_names(page) == ["demo", "other", "data"]
    assert table_names(page) == ["items"]
    assert "&csv=" in search(page) and "install=" in search(page)
    # In a new worker, which is started with what was loaded since
    page.evaluate("installs => restartWithInstalls(installs, () => {})", [])
    assert database_names(page) == ["demo", "other", "data"]
    assert table_names(page) == ["items"]

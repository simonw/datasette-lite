"""The original Datasette Lite tests, adapted to the iframe/service worker model.

These load the default fixtures.db + content.db databases from the network."""
import json

import pytest
from playwright.sync_api import Page, expect

from conftest import boot, database_names, wait_for_boot


@pytest.fixture(scope="module")
def dslite(static_server, shared_context):
    page = shared_context.new_page()
    page.goto(static_server + "/")
    expect(page.locator("#loading-indicator")).to_be_visible()
    wait_for_boot(page)
    frame = page.frame_locator("#datasette")
    expect(frame.locator("h1").first).to_be_visible()
    yield page
    page.close()


def test_initial_load(dslite: Page):
    expect(dslite.locator("#loading-indicator")).to_have_css("display", "none")
    expect(dslite.locator("#datasette")).to_be_visible()


def test_loading_screen_listed_the_startup_steps(dslite: Page):
    steps = dslite.locator("#loading-logs li").all_text_contents()
    assert steps[0] == "Loading Python (Pyodide)..."
    assert steps[-1] == "Starting Datasette..."
    for step in (
        "Downloading https://latest.datasette.io/fixtures.db",
        "Downloading https://datasette.io/content.db",
        "Installing Datasette...",
    ):
        assert step in steps
    # Pyodide's "Loaded x" and "No new packages to load" lines are not steps
    assert not [step for step in steps if not step.startswith(("Loading", "Downloading", "Installing", "Starting"))]


def test_has_two_databases(dslite: Page):
    assert database_names(dslite) == ["fixtures", "content"]


def test_navigate_to_database(dslite: Page):
    frame = dslite.frame_locator("#datasette")
    # The 1.0 homepage has no link to a database page, so go by #fragment
    dslite.evaluate("location.hash = '#/fixtures'")
    expect(dslite).to_have_title("fixtures")
    assert dslite.evaluate("location.hash") == "#/fixtures"
    # Datasette's own JavaScript runs now: the SQL textarea is a CodeMirror editor
    # (CodeMirror 5 in Datasette 0.x, CodeMirror 6 in 1.0)
    editor = frame.locator(".CodeMirror, .cm-content").first
    expect(editor).to_be_visible()
    expect(frame.locator("textarea#sql-editor")).to_be_hidden()
    editor.click()
    dslite.keyboard.press("ControlOrMeta+a")
    dslite.keyboard.type("SELECT * FROM no_primary_key limit 1")
    frame.locator("input[type=submit]").first.click()
    expect(dslite).to_have_title("fixtures: SELECT * FROM no_primary_key limit 1")
    table = frame.locator("table.rows-and-columns")
    # Compare classes and cell values rather than exact HTML, which differs
    # between Datasette versions (1.0 adds a menu button to each header)
    assert [th.get_attribute("class") for th in table.locator("th").all()] == [
        "col-content", "col-a", "col-b", "col-c",
    ]
    assert [td.get_attribute("class") for td in table.locator("td").all()] == [
        "col-content", "col-a", "col-b", "col-c",
    ]
    assert table.locator("td").all_text_contents() == ["1", "a1", "b1", "c1"]


def test_load_multiple_database_urls(static_server, shared_context):
    page = shared_context.new_page()
    frame = boot(
        page,
        static_server + "/"
        "?url=https://latest.datasette.io/fixtures.db"
        "&url=https://datasette.io/content.db"
        "&url=https://latest.datasette.io/fixtures.db",
    )
    assert database_names(page) == ["fixtures", "content", "fixtures_2"]
    page.close()


def test_ref(static_server, shared_context):
    page = shared_context.new_page()
    page.goto(static_server + "/?ref=1.0a11#/-/versions.json")
    expect(page.locator("#loading-indicator")).to_be_visible()
    wait_for_boot(page)
    frame = page.frame_locator("#datasette")
    # Chrome renders a JSON response as a <pre>
    expect(frame.locator("pre")).to_be_attached(timeout=60 * 1000)
    info = json.loads(frame.locator("pre").text_content())
    assert info["datasette"]["version"] == "1.0a11"
    page.close()

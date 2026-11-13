"""The original Datasette Lite tests, adapted to the iframe/service worker model.

These load the default fixtures.db + content.db databases from the network."""
import json

import pytest
from playwright.sync_api import Page, expect

from conftest import boot, wait_for_boot


@pytest.fixture(scope="module")
def dslite(static_server, shared_context):
    page = shared_context.new_page()
    page.goto(static_server + "/")
    expect(page.locator("#loading-indicator")).to_be_visible()
    wait_for_boot(page)
    frame = page.frame_locator("#datasette")
    expect(frame.locator("h2").first).to_be_visible()
    yield page
    page.close()


def test_initial_load(dslite: Page):
    expect(dslite.locator("#loading-indicator")).to_have_css("display", "none")
    expect(dslite.locator("#datasette")).to_be_visible()


def test_has_two_databases(dslite: Page):
    frame = dslite.frame_locator("#datasette")
    expect(frame.locator("h2")).to_have_text(["fixtures", "content"])


def test_navigate_to_database(dslite: Page):
    frame = dslite.frame_locator("#datasette")
    h2 = frame.locator("h2").first
    expect(h2).to_have_text("fixtures")
    h2.locator("a").click()
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
    table_html = "".join(table.inner_html().split())
    assert table_html == (
        '<thead><tr><thclass="col-content"scope="col">content</th>'
        '<thclass="col-a"scope="col">a</th><thclass="col-b"scope="col">b</th>'
        '<thclass="col-c"scope="col">c</th></tr></thead><tbody><tr>'
        '<tdclass="col-content">1</td><tdclass="col-a">a1</td>'
        '<tdclass="col-b">b1</td><tdclass="col-c">c1</td></tr></tbody>'
    )


def test_load_multiple_database_urls(static_server, shared_context):
    page = shared_context.new_page()
    frame = boot(
        page,
        static_server + "/"
        "?url=https://latest.datasette.io/fixtures.db"
        "&url=https://datasette.io/content.db"
        "&url=https://latest.datasette.io/fixtures.db",
    )
    expect(frame.locator("h2")).to_have_text(["fixtures", "content", "fixtures_2"])
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

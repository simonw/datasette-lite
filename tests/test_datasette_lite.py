from playwright.sync_api import Browser, Page, expect
from subprocess import Popen, PIPE
import pathlib
import pytest
import time
from http.client import HTTPConnection

root = pathlib.Path(__file__).parent.parent.absolute()


@pytest.fixture(scope="module")
def static_server():
    process = Popen(
        ["python", "-m", "http.server", "8123", "--directory", root], stdout=PIPE
    )
    retries = 5
    while retries > 0:
        conn = HTTPConnection("localhost:8123")
        try:
            conn.request("HEAD", "/")
            response = conn.getresponse()
            if response is not None:
                yield process
                break
        except ConnectionRefusedError:
            time.sleep(1)
            retries -= 1

    if not retries:
        raise RuntimeError("Failed to start http server")
    else:
        process.terminate()
        process.wait()


@pytest.fixture(scope="module")
def dslite(static_server, browser: Browser) -> Page:
    page = browser.new_page()
    page.goto("http://localhost:8123/")
    loading = page.locator("#loading-indicator")
    expect(loading).to_have_css("display", "block")
    # Give it up to 60s to finish loading
    expect(loading).to_have_css("display", "none", timeout=60 * 1000)
    return page


def test_initial_load(dslite: Page):
    expect(dslite.locator("#loading-indicator")).to_have_css("display", "none")


def test_has_two_databases(dslite: Page):
    assert [el.inner_text() for el in dslite.query_selector_all("h2")] == [
        "fixtures",
        "content",
    ]


def test_navigate_to_database(dslite: Page):
    h2 = dslite.query_selector("h2")
    assert h2.inner_text() == "fixtures"
    h2.query_selector("a").click()
    expect(dslite).to_have_title("fixtures")
    dslite.query_selector("textarea#sql-editor").fill(
        "SELECT * FROM no_primary_key limit 1"
    )
    dslite.query_selector("input[type=submit]").click()
    expect(dslite).to_have_title("fixtures: SELECT * FROM no_primary_key limit 1")
    table = dslite.query_selector("table.rows-and-columns")
    table_html = "".join(table.inner_html().split())
    assert table_html == (
        '<thead><tr><thclass="col-content"scope="col">content</th>'
        '<thclass="col-a"scope="col">a</th><thclass="col-b"scope="col">b</th>'
        '<thclass="col-c"scope="col">c</th></tr></thead><tbody><tr>'
        '<tdclass="col-content">1</td><tdclass="col-a">a1</td>'
        '<tdclass="col-b">b1</td><tdclass="col-c">c1</td></tr></tbody>'
    )

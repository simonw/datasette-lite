import os
import pathlib
import re
import shutil
import socket
import sqlite3
import time
from http.client import HTTPConnection
from subprocess import Popen, DEVNULL

import pytest
from playwright.sync_api import Page, expect

root = pathlib.Path(__file__).parent.parent.absolute()
fixtures = pathlib.Path(__file__).parent / "fixtures"
generated = fixtures / "generated"

# Booting Pyodide + installing Datasette takes a while, plugins take longer
BOOT_TIMEOUT = 180 * 1000


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def generated_fixtures():
    generated.mkdir(exist_ok=True)
    for name, rows in (
        ("demo", [("Cleo", 5), ("Pancakes", 3)]),
        ("other", [("Azi", 1)]),
    ):
        path = generated / (name + ".db")
        if path.exists():
            path.unlink()
        conn = sqlite3.connect(path)
        conn.execute("create table dogs (id integer primary key, name text, age integer)")
        conn.executemany("insert into dogs (name, age) values (?, ?)", rows)
        conn.commit()
        conn.close()
    # The same database under file names that do not simply end in .db
    for name in ("extension.sqlite", "dotted.name.db"):
        shutil.copyfile(generated / "demo.db", generated / name)
    return generated


@pytest.fixture(scope="session")
def static_server(generated_fixtures):
    port = int(os.environ.get("DATASETTE_LITE_TEST_PORT") or _free_port())
    process = Popen(
        ["python", "-m", "http.server", str(port), "--directory", str(root)],
        stdout=DEVNULL,
        stderr=DEVNULL,
    )
    for _ in range(50):
        try:
            conn = HTTPConnection("localhost:{}".format(port))
            conn.request("HEAD", "/")
            conn.getresponse()
            break
        except ConnectionRefusedError:
            time.sleep(0.2)
    else:
        process.terminate()
        raise RuntimeError("Failed to start http server")
    yield "http://localhost:{}".format(port)
    process.terminate()
    process.wait()


@pytest.fixture(scope="session")
def subpath_server(generated_fixtures, tmp_path_factory):
    "Serves Datasette Lite from /sub/ - like a GitHub Pages project site"
    port = _free_port()
    directory = tmp_path_factory.mktemp("subpath")
    (directory / "sub").symlink_to(root, target_is_directory=True)
    process = Popen(
        ["python", "-m", "http.server", str(port), "--directory", str(directory)],
        stdout=DEVNULL,
        stderr=DEVNULL,
    )
    for _ in range(50):
        try:
            conn = HTTPConnection("localhost:{}".format(port))
            conn.request("HEAD", "/sub/")
            conn.getresponse()
            break
        except ConnectionRefusedError:
            time.sleep(0.2)
    yield "http://localhost:{}/sub".format(port)
    process.terminate()
    process.wait()


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args):
    args = dict(browser_type_launch_args)
    # Some sandboxes route browser traffic through an HTTPS proxy
    proxy = os.environ.get("DATASETTE_LITE_TEST_PROXY") or os.environ.get("HTTPS_PROXY")
    if proxy:
        # Only proxy https:// - the local test server is plain http://
        host = proxy.split("://", 1)[-1].rstrip("/")
        args["args"] = list(args.get("args") or []) + ["--proxy-server=https=" + host]
    executable = os.environ.get("CHROMIUM_EXECUTABLE")
    if executable:
        args["executable_path"] = executable
    return args


@pytest.fixture(scope="session")
def shared_context(browser):
    """One browser context shared by every test that does not need its own.

    A new context starts with an empty HTTP cache, so each boot would download
    Pyodide and every wheel again. Sharing the context means only the first
    boot of a run does that. Tests stay isolated where it matters: each page
    is its own Datasette Lite tab, with its own session, worker and data."""
    context = browser.new_context()
    yield context
    context.close()


def wait_for_boot(page: Page):
    "Wait for Datasette Lite to finish booting, fail fast with any startup error"
    page.wait_for_function(
        "document.body.classList.contains('ready') || "
        "document.getElementById('output').textContent.length",
        timeout=BOOT_TIMEOUT,
    )
    error = page.locator("#output").text_content()
    assert not error, error


def boot(page: Page, url: str, wait_for="footer"):
    """Load a Datasette Lite URL and return a FrameLocator for the Datasette iframe"""
    page.goto(url)
    wait_for_boot(page)
    frame = page.frame_locator("#datasette")
    if wait_for:
        expect(frame.locator(wait_for).first).to_be_attached(timeout=60 * 1000)
    return frame


def datasette_frame(page: Page):
    "The Frame object for the Datasette iframe, for evaluate()"
    return page.locator("#datasette").element_handle().content_frame()


def app_path(page: Page):
    "The current Datasette path, as mirrored in the #fragment"
    return page.evaluate("location.hash").lstrip("#")


def wait_for_hash(page: Page, pattern):
    regex = re.compile(pattern)
    page.wait_for_function(
        "pattern => new RegExp(pattern).test(location.hash.slice(1))",
        arg=regex.pattern,
        timeout=60 * 1000,
    )

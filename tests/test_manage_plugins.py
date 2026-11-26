"""The "Manage plugins" item that Datasette Lite adds to Datasette's menu, and
the dialog it opens: installing and removing plugins restarts Datasette
without reloading the page, and updates ?install= in the page's URL."""
import pytest
from playwright.sync_api import Page, expect

from conftest import BOOT_TIMEOUT, boot, build_wheel, datasette_frame, root

PLUGIN = "datasette-lite-test-stream"


@pytest.fixture
def page(shared_context):
    page = shared_context.new_page()
    yield page
    page.close()


def plugin_names(page: Page):
    return datasette_frame(page).evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            const plugins = await (await fetch(base + "/-/plugins.json")).json();
            // Without Datasette Lite's own, which adds the menu item
            return plugins.map((plugin) => plugin.name).filter((name) => name != "datasette_lite");
        }"""
    )


def plugin_versions(page: Page):
    return datasette_frame(page).evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            const plugins = await (await fetch(base + "/-/plugins.json")).json();
            return Object.fromEntries(
                plugins.filter((plugin) => plugin.name != "datasette_lite")
                    .map((plugin) => [plugin.name, plugin.version])
            );
        }"""
    )


def open_dialog(page: Page):
    frame = page.frame_locator("#datasette")
    frame.locator(".nav-menu summary").click()
    frame.get_by_role("menuitem", name="Manage plugins").click()
    dialog = frame.locator("#manage-plugins-dialog")
    expect(dialog).to_be_visible()
    return dialog


def apply(page: Page, dialog):
    "Apply the dialog's changes and wait for the restarted Datasette's page"
    dialog.get_by_role("button", name="Apply", exact=True).click()
    expect(dialog.locator(".mp-progress li").first).to_be_visible()
    # The progress replaces the choices
    expect(dialog.locator("input[type=text]")).to_be_hidden()
    expect(dialog).to_have_count(0, timeout=BOOT_TIMEOUT)
    expect(page.frame_locator("#datasette").locator(".nav-menu")).to_be_attached()


def insert_row(page: Page):
    "Change the data, as root, with the write API"
    frame = datasette_frame(page)
    status = frame.evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            const response = await fetch(base + "/data/items/-/insert", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({row: {id: 99, name: "Inserted", qty: 1, price: 1.5}}),
            });
            return response.status;
        }"""
    )
    assert status == 201


def inserted_rows(page: Page):
    return datasette_frame(page).evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            return (await (await fetch(base + "/data/items.json?_shape=array&id=99")).json()).length;
        }"""
    )


def is_first_worker(page: Page):
    return page.evaluate("datasetteWorker === window.firstWorker")


def start(page: Page, static_server):
    boot(page, static_server + "/?root=1&csv=tests/fixtures/items.csv#/data/items")
    assert plugin_names(page) == []
    # Lost if the page is reloaded
    page.evaluate("window.firstWorker = datasetteWorker")
    insert_row(page)
    return "?root=1&csv=tests/fixtures/items.csv"


def test_install_and_remove_plugin_in_place(page, static_server, stream_plugin):
    """Adding and removing a plugin is done by the Datasette that is already
    running: nothing is loaded again, and changes to the data are kept"""
    search = start(page, static_server)

    dialog = open_dialog(page)
    expect(dialog.locator(".mp-empty")).to_have_text("No plugins are installed.")
    expect(dialog.locator(".mp-error")).to_be_hidden()
    expect(dialog.locator(".mp-progress")).to_be_hidden()
    expect(dialog.locator(".mp-suggested .mp-name").first).to_have_text("datasette-charts")
    expect(dialog.locator(".mp-suggested input:checked")).to_have_count(0)
    apply_button = dialog.get_by_role("button", name="Apply", exact=True)
    expect(apply_button).to_be_disabled()
    dialog.locator("input[type=text]").fill(stream_plugin)
    expect(apply_button).to_be_enabled()
    apply(page, dialog)

    assert plugin_names(page) == [PLUGIN]
    assert is_first_worker(page)
    assert inserted_rows(page) == 1
    assert page.evaluate("location.search") == search + "&install=" + stream_plugin
    assert page.evaluate("location.hash") == "#/data/items"
    # Still signed in as root
    expect(page.frame_locator("#datasette").locator(".actor")).to_contain_text("root")

    # Now it is listed as installed. Untick it to remove it
    dialog = open_dialog(page)
    installed = dialog.locator(".mp-installed li")
    expect(installed).to_have_count(1)
    expect(installed.locator(".mp-name")).to_have_text(stream_plugin)
    # The wheel's URL already says which version it is
    expect(installed.locator(".mp-detail")).to_have_count(0)
    installed.locator("input").uncheck()
    apply(page, dialog)

    assert plugin_names(page) == []
    assert is_first_worker(page)
    assert inserted_rows(page) == 1
    assert page.evaluate("location.search") == search

    # And back again: it is still installed, so this only registers it
    dialog = open_dialog(page)
    dialog.locator("input[type=text]").fill(stream_plugin)
    apply(page, dialog)
    assert plugin_names(page) == [PLUGIN]
    assert is_first_worker(page)


def test_another_version_of_a_plugin_starts_again(
    page, static_server, stream_plugin, generated_fixtures
):
    "Code that has been imported cannot be replaced: that takes a new Python"
    newer = stream_plugin.rsplit("/", 1)[0] + "/" + build_wheel(
        generated_fixtures, PLUGIN, root / "tests" / "plugins" / "datasette_lite_test_stream.py",
        version="0.2",
    )
    search = start(page, static_server)
    dialog = open_dialog(page)
    dialog.locator("input[type=text]").fill(stream_plugin)
    apply(page, dialog)
    assert plugin_versions(page) == {PLUGIN: "0.1"}
    assert is_first_worker(page)

    dialog = open_dialog(page)
    dialog.locator(".mp-installed input").uncheck()
    dialog.locator("input[type=text]").fill(newer)
    apply(page, dialog)
    assert plugin_versions(page) == {PLUGIN: "0.2"}
    assert not is_first_worker(page)
    # The data was loaded again
    assert inserted_rows(page) == 0
    assert page.evaluate("location.search") == search + "&install=" + newer
    # The page itself was not
    assert page.evaluate("window.firstWorker instanceof Worker")


def test_plugin_that_cannot_be_installed(page, static_server):
    "Datasette carries on as it was, and the dialog says what went wrong"
    boot(page, static_server + "/?memory=1")
    dialog = open_dialog(page)
    dialog.locator("input[type=text]").fill("datasette-lite-no-such-plugin")
    # Enter in the text box applies
    dialog.locator("input[type=text]").press("Enter")
    error = dialog.locator(".mp-error")
    expect(error).to_be_visible(timeout=BOOT_TIMEOUT)
    expect(error).to_contain_text("nothing has changed")
    expect(error).to_contain_text("datasette-lite-no-such-plugin")
    assert page.evaluate("location.search") == "?memory=1"
    assert plugin_names(page) == []
    # The dialog can be used again, or closed
    expect(dialog.locator("input[type=text]")).to_have_value("datasette-lite-no-such-plugin")
    dialog.get_by_role("button", name="Cancel").click()
    expect(dialog).to_have_count(0)


def test_no_menu_item_without_the_modal_api(page, static_server):
    "Datasette 0.x has no DatasetteModal to build the dialog with"
    frame = boot(page, static_server + "/?ref=stable&memory=1")
    expect(frame.locator(".nav-menu")).to_have_count(0)
    assert "Manage plugins" not in frame.locator("body").inner_html()
    assert plugin_names(page) == []

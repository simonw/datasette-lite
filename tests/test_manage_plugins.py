"""The "Manage plugins" item that Datasette Lite adds to Datasette's menu, and
the dialog it opens: installing and removing plugins restarts Datasette
without reloading the page, and updates ?install= in the page's URL."""
import pytest
from playwright.sync_api import Page, expect

from conftest import BOOT_TIMEOUT, boot, datasette_frame

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


def open_dialog(page: Page):
    frame = page.frame_locator("#datasette")
    frame.locator(".nav-menu summary").click()
    frame.get_by_role("menuitem", name="Manage plugins").click()
    dialog = frame.locator("#manage-plugins-dialog")
    expect(dialog).to_be_visible()
    return dialog


def apply(page: Page, dialog):
    "Apply the dialog's changes and wait for the restarted Datasette's page"
    dialog.get_by_role("button", name="Apply and restart").click()
    expect(dialog.locator(".mp-progress li").first).to_be_visible()
    # The progress replaces the choices
    expect(dialog.locator("input[type=text]")).to_be_hidden()
    expect(dialog).to_have_count(0, timeout=BOOT_TIMEOUT)
    expect(page.frame_locator("#datasette").locator(".nav-menu")).to_be_attached()


def test_install_and_remove_plugin(page, static_server, stream_plugin):
    boot(page, static_server + "/?memory=1#/-/versions")
    assert plugin_names(page) == []
    # Lost if the page is reloaded
    page.evaluate("window.notReloaded = true")

    dialog = open_dialog(page)
    expect(dialog.locator(".mp-empty")).to_have_text("No plugins are installed.")
    expect(dialog.locator(".mp-error")).to_be_hidden()
    expect(dialog.locator(".mp-progress")).to_be_hidden()
    expect(dialog.locator(".mp-suggested .mp-name").first).to_have_text("datasette-charts")
    expect(dialog.locator(".mp-suggested input:checked")).to_have_count(0)
    apply_button = dialog.get_by_role("button", name="Apply and restart")
    expect(apply_button).to_be_disabled()
    dialog.locator("input[type=text]").fill(stream_plugin)
    expect(apply_button).to_be_enabled()
    apply(page, dialog)

    assert plugin_names(page) == [PLUGIN]
    assert page.evaluate("window.notReloaded") is True
    assert page.evaluate("location.search") == "?memory=1&install=" + stream_plugin
    assert page.evaluate("location.hash") == "#/-/versions"

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
    assert page.evaluate("window.notReloaded") is True
    assert page.evaluate("location.search") == "?memory=1"


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

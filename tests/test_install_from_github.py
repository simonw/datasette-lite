"""Tests for ?install=owner/repo, ?install=owner/repo@ref and the github.com
URLs that mean the same, which run a plugin from a zip of the source in its
GitHub repository rather than from a release on PyPI.

The JavaScript that recognises a repository and the Python that unpacks the
zip are both extracted from webworker.js, so the code tested here is exactly
the code that ships."""
import io
import json
import zipfile
from importlib.metadata import distributions

import pytest
from playwright.sync_api import expect

from conftest import boot, datasette_frame, root
from test_ref_from_source import SHA, source_zip_functions
from test_sqlite_version import F, WEBWORKER, extract_js

PROXY = "https://github-zip-cors-proxy.simonw.workers.dev"
CORS = {"access-control-allow-origin": "*"}

PYPROJECT = """
[project]
name = "datasette-lite-test-stream"
version = "0.2"
dependencies = ["datasette"]

[project.entry-points.datasette]
lite_test_stream = "datasette_lite_test_stream"
"""

PLUGIN = (root / "tests" / "plugins" / "datasette_lite_test_stream.py").read_text()


def repo_zip(files, root="datasette-lite-test-stream-main", comment=SHA.encode()):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(root + "/", "")
        for path, content in files.items():
            archive.writestr(root + "/" + path, content)
        archive.comment = comment
    return buffer.getvalue()


def test_worker_constants_match_the_tests():
    assert 'const GITHUB_ZIP_PROXY = "{}";'.format(PROXY) in WEBWORKER.read_text()


# --- Recognising a repository --------------------------------------------------


@pytest.fixture
def page(shared_context):
    page = shared_context.new_page()
    yield page
    page.close()


@pytest.fixture
def js(page, static_server):
    page.goto(static_server + "/" + F + "plain.html")
    page.add_script_tag(content=extract_js("install"))
    return lambda function, *args: page.evaluate(
        "([name, args]) => window[name](...args)", [function, list(args)]
    )


REPO = "simonw/datasette-cluster-map"
URL = "https://github.com/" + REPO
SHA7 = SHA[:7]


@pytest.mark.parametrize(
    "install,repo,ref",
    (
        # The default branch
        (REPO, REPO, None),
        (URL, REPO, None),
        (URL + "/", REPO, None),
        (URL + ".git", REPO, None),
        ("http://www.github.com/" + REPO, REPO, None),
        ("some-org/repo.with_dots", "some-org/repo.with_dots", None),
        # A branch, tag or commit
        (REPO + "@main", REPO, "main"),
        (REPO + "@0.18", REPO, "0.18"),
        (REPO + "@" + SHA, REPO, SHA),
        (REPO + "@" + SHA7, REPO, SHA7),
        (REPO + "@feature/with-slash", REPO, "feature/with-slash"),
        (URL + "@main", REPO, "main"),
        (URL + ".git@v1.0", REPO, "v1.0"),
        # The pages GitHub has for them
        (URL + "/tree/main", REPO, "main"),
        (URL + "/tree/main/", REPO, "main"),
        (URL + "/tree/0.18", REPO, "0.18"),
        (URL + "/tree/feature/with-slash", REPO, "feature/with-slash"),
        (URL + "/commit/" + SHA, REPO, SHA),
        (URL + "/pull/12", REPO, "refs/pull/12/head"),
        (URL + "/pull/12/", REPO, "refs/pull/12/head"),
    ),
)
def test_github_source(js, install, repo, ref):
    assert js("githubSource", install) == {"repo": repo, "ref": ref}


@pytest.mark.parametrize(
    "install",
    (
        # What micropip gets: package names, requirements and wheels
        "datasette-cluster-map",
        "datasette-cluster-map==0.18",
        "datasette-leaflet>=0.3",
        "datasette-leaflet @ https://example.com/dist/plugin-0.1-py3-none-any.whl",
        "https://example.com/" + REPO,
        "https://example.com/dist/plugin-0.1-py3-none-any.whl",
        "https://github.com/simonw/plugin/releases/download/0.1/plugin-0.1-py3-none-any.whl",
        "dist/plugin-0.1-py3-none-any.whl",
        # Not a repository, or not a ref in one
        "https://github.com/simonw",
        URL + "/issues/1",
        URL + "/blob/main/README.md",
        URL + "/pull/12/files",
        URL + "/pull/new",
        URL + "/tree/",
        URL + "/tree/not a ref",
        REPO + "/main",
        REPO + "/tree/main",
        REPO + "@",
        REPO + "@not a ref",
        REPO + "@../evil",
        REPO + "@.hidden",
        "simonw/..",
        "-simonw/repo",
        "simonw/repo name",
        "simonw/repo\n",
        "",
    ),
)
def test_not_a_github_source(js, install):
    assert js("githubSource", install) is None


@pytest.mark.parametrize(
    "install,expected",
    (
        (URL + "/issues/1", True),
        (URL + "/blob/main/README.md", True),
        (URL + "/pull/12/files", True),
        ("https://github.com/simonw", True),
        ("https://github.com/", True),
        (URL, False),
        (URL + "/tree/main", False),
        (URL + "/pull/12", False),
        ("https://github.com/simonw/plugin/releases/download/0.1/plugin-0.1-py3-none-any.whl", False),
        ("https://github.community/thing", False),
        (REPO, False),
        ("datasette-cluster-map", False),
    ),
)
def test_is_other_github_url(js, install, expected):
    assert js("isOtherGithubUrl", install) is expected


# --- Unpacking the zip ---------------------------------------------------------


@pytest.fixture(scope="module")
def functions():
    return source_zip_functions()


@pytest.fixture
def install_source_zip(functions):
    return functions["install_source_zip"]


def test_single_module_plugin(install_source_zip, tmp_path):
    files = {
        "pyproject.toml": PYPROJECT,
        "README.md": "# Plugin",
        "datasette_lite_test_stream.py": PLUGIN,
        "tests/test_plugin.py": "",
        "conftest.py": "",
    }
    assert install_source_zip(repo_zip(files), tmp_path) == (
        "datasette-lite-test-stream",
        "0.2",
        ["datasette"],
        SHA,
    )
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "datasette_lite_test_stream-0.2.dist-info",
        "datasette_lite_test_stream.py",
    ]
    assert (tmp_path / "datasette_lite_test_stream.py").read_text() == PLUGIN
    (dist,) = distributions(path=[str(tmp_path)])
    assert dist.metadata["Name"] == "datasette-lite-test-stream"
    assert dist.version == "0.2"
    assert dist.requires == ["datasette"]
    # This is how Datasette finds the plugin
    assert [(ep.group, ep.name, ep.value) for ep in dist.entry_points] == [
        ("datasette", "lite_test_stream", "datasette_lite_test_stream")
    ]


@pytest.mark.parametrize("base", ["", "src/"])
def test_package_plugin_with_data_files(install_source_zip, tmp_path, base):
    files = {
        "pyproject.toml": PYPROJECT,
        base + "datasette_lite_test_stream/__init__.py": PLUGIN,
        base + "datasette_lite_test_stream/static/app.js": "// js",
        base + "datasette_lite_test_stream/templates/page.html": "<h1>hi</h1>",
        "tests/__init__.py": "",
        "docs/index.md": "",
    }
    install_source_zip(repo_zip(files), tmp_path)
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "datasette_lite_test_stream",
        "datasette_lite_test_stream-0.2.dist-info",
    ]
    package = tmp_path / "datasette_lite_test_stream"
    assert sorted(str(path.relative_to(package)) for path in package.rglob("*") if path.is_file()) == [
        "__init__.py",
        "static/app.js",
        "templates/page.html",
    ]


def test_package_not_named_after_the_project(install_source_zip, tmp_path):
    files = {
        "pyproject.toml": PYPROJECT,
        "stream_plugin/__init__.py": PLUGIN,
        "tests/__init__.py": "",
    }
    install_source_zip(repo_zip(files), tmp_path)
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "datasette_lite_test_stream-0.2.dist-info",
        "stream_plugin",
    ]


def test_version_from_dunder_version(install_source_zip, tmp_path):
    files = {
        "pyproject.toml": PYPROJECT.replace('version = "0.2"', 'dynamic = ["version"]'),
        "datasette_lite_test_stream/__init__.py": '__version__ = "0.3a1"\n',
    }
    assert install_source_zip(repo_zip(files), tmp_path)[1] == "0.3a1"


@pytest.mark.parametrize(
    "files,message",
    (
        ({"setup.py": "", "datasette_lite_test_stream.py": ""}, "it has no pyproject.toml"),
        (
            {"pyproject.toml": "[build-system]\nrequires = []\n", "datasette_lite_test_stream.py": ""},
            r"its pyproject.toml has no \[project\] name",
        ),
        (
            {"pyproject.toml": PYPROJECT, "README.md": "", "tests/__init__.py": ""},
            r"could not find its Python code - looked for datasette_lite_test_stream/__init__.py "
            r"and datasette_lite_test_stream.py",
        ),
        (
            {
                "pyproject.toml": PYPROJECT.replace('version = "0.2"', 'dynamic = ["version"]'),
                "datasette_lite_test_stream.py": "",
            },
            "could not find its version number",
        ),
    ),
)
def test_repositories_that_cannot_be_installed(functions, tmp_path, files, message):
    with pytest.raises(functions["SourceZipError"], match=message):
        functions["install_source_zip"](repo_zip(files), tmp_path)
    assert list(tmp_path.iterdir()) == []


# --- In the browser, with the proxy faked --------------------------------------


def plugin_zip():
    return repo_zip({"pyproject.toml": PYPROJECT, "datasette_lite_test_stream.py": PLUGIN})


def startup_error(page, url):
    page.goto(url)
    page.wait_for_function(
        "document.getElementById('output').textContent.length", timeout=180 * 1000
    )
    return page.locator("#output")


@pytest.mark.parametrize(
    "install,ref",
    (
        # The default branch of the repository
        ("simonw/datasette-lite-test-stream", "HEAD"),
        ("https://github.com/simonw/datasette-lite-test-stream", "HEAD"),
        ("simonw/datasette-lite-test-stream@some-branch", "some-branch"),
        ("https://github.com/simonw/datasette-lite-test-stream/pull/12", "refs/pull/12/head"),
    ),
)
def test_install_from_repository(page, static_server, install, ref):
    requested = []

    def handle(route):
        requested.append(route.request.url)
        route.fulfill(body=plugin_zip(), content_type="application/zip", headers=CORS)

    page.route(PROXY + "/**", handle)
    boot(page, static_server + "/?memory=1&install=" + install)
    assert requested == [PROXY + "/simonw/datasette-lite-test-stream/" + ref]
    plugins = datasette_frame(page).evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            return (await fetch(base + "/-/plugins.json")).json();
        }"""
    )
    assert [(plugin["name"], plugin["version"]) for plugin in plugins] == [
        ("datasette-lite-test-stream", "0.2")
    ]
    # And it runs
    state = datasette_frame(page).evaluate(
        """async () => {
            const base = location.pathname.match(/^.*?\\/app\\/[^/]+/)[0];
            return (await fetch(base + "/-/test-stream-state")).json();
        }"""
    )
    assert state["started"] == 0


@pytest.mark.parametrize("ref", ("", "@0.2"))
def test_loading_screen_names_the_plugin_and_commit(page, static_server, ref):
    page.route(
        PROXY + "/**",
        lambda route: route.fulfill(body=plugin_zip(), content_type="application/zip", headers=CORS),
    )
    messages = []
    page.on("console", lambda message: messages.append(message.text))
    boot(page, static_server + "/?memory=1&install=simonw/datasette-lite-test-stream" + ref)
    labels = page.evaluate(
        "() => [...document.querySelectorAll('.step-label')].map(el => el.textContent)"
    )
    assert (
        "Installing datasette-lite-test-stream 0.2 from "
        "simonw/datasette-lite-test-stream{} (commit dfeec63)".format(ref)
    ) in labels, messages


@pytest.mark.parametrize(
    "install,status,message",
    (
        (
            "simonw/no-such-plugin",
            404,
            "?install=simonw/no-such-plugin could not be used: there is no public "
            "simonw/no-such-plugin repository on GitHub",
        ),
        (
            "simonw/plugin@no-such-branch",
            404,
            "?install=simonw/plugin@no-such-branch could not be used: no-such-branch is not "
            "a branch, tag or commit in a public simonw/plugin repository on GitHub",
        ),
        (
            "someone-else/plugin@main",
            403,
            "?install=someone-else/plugin@main could not be used: the proxy that Datasette "
            "Lite downloads GitHub repositories through does not serve someone-else/plugin",
        ),
    ),
)
def test_repository_that_cannot_be_downloaded(page, static_server, install, status, message):
    page.route(
        PROXY + "/**", lambda route: route.fulfill(status=status, body="No", headers=CORS)
    )
    expect(startup_error(page, static_server + "/?memory=1&install=" + install)).to_contain_text(
        message
    )


def test_repository_without_a_pyproject(page, static_server):
    page.route(
        PROXY + "/**",
        lambda route: route.fulfill(
            body=repo_zip({"setup.py": "", "datasette_lite_test_stream.py": PLUGIN}),
            content_type="application/zip",
            headers=CORS,
        ),
    )
    expect(
        startup_error(page, static_server + "/?memory=1&install=simonw/datasette-lite-test-stream")
    ).to_contain_text(
        "?install=simonw/datasette-lite-test-stream cannot be installed from its source: "
        "it has no pyproject.toml"
    )


def test_other_github_urls_are_an_error(page, static_server):
    url = "https://github.com/simonw/datasette-cluster-map/issues/1"
    expect(startup_error(page, static_server + "/?memory=1&install=" + url)).to_contain_text(
        "?install=" + url + " is not the URL of a GitHub repository or of a wheel"
    )


@pytest.mark.network
@pytest.mark.parametrize(
    "install,version",
    (
        ("simonw/datasette-packages", None),
        # A tag
        ("simonw/datasette-packages@0.3", "0.3"),
        ("https://github.com/simonw/datasette-packages/tree/0.3", "0.3"),
    ),
)
def test_install_real_repository(page, static_server, install, version):
    frame = boot(
        page,
        static_server + "/?memory=1&install=" + install + "#/-/packages.json",
        wait_for="pre",
    )
    packages = json.loads(frame.locator("pre").text_content())
    assert "datasette-packages" in packages
    if version:
        assert packages["datasette-packages"] == version

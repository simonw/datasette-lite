"""Tests for ?ref=<branch, tag or commit>, which runs Datasette from a zip of
its source on GitHub rather than from a PyPI release.

The function that unpacks the zip is extracted from the startup Python in
webworker.js, so the code tested here is exactly the code that ships."""
import ast
import io
import json
import re
import zipfile
from importlib.metadata import distributions

import pytest
from playwright.sync_api import expect

from test_bridge import extract
from conftest import boot

SHA = "dfeec630f86b4cbd06d24a090e654bd130344b71"

PYPROJECT = """
[project]
name = "datasette"
dynamic = ["version"]
dependencies = [
    "click>=7.1.1",
    "Jinja2>=2.10.3",
]

[project.scripts]
datasette = "datasette.cli:cli"

[project.entry-points.pytest11]
datasette = "datasette._pytest_plugin"
"""


@pytest.fixture(scope="module")
def install_datasette_source():
    # The startup Python has top level awaits, so it cannot be exec()ed whole
    tree = ast.parse(extract("startup"))
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "install_datasette_source"
    ]
    assert len(functions) == 1
    namespace = {}
    exec(compile(ast.Module(body=functions, type_ignores=[]), "webworker.js", "exec"), namespace)
    return namespace["install_datasette_source"]


def source_zip(files=None, root="datasette-main", comment=SHA.encode()):
    if files is None:
        files = {
            "pyproject.toml": PYPROJECT,
            "README.md": "# Datasette",
            "datasette/__init__.py": "",
            "datasette/version.py": '__version__ = "1.0a42"\n__version_info__ = tuple(__version__.split("."))\n',
            "datasette/templates/index.html": "<h1>hi</h1>",
            "datasette/static/app.css": "body {}",
            "tests/test_api.py": "",
            "docs/index.rst": "",
        }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        # GitHub's zips have entries for directories too
        archive.writestr(root + "/", "")
        archive.writestr(root + "/datasette/", "")
        for path, content in files.items():
            archive.writestr(root + "/" + path, content)
        archive.comment = comment
    return buffer.getvalue()


def test_installs_package_and_metadata(install_datasette_source, tmp_path):
    version, dependencies, commit = install_datasette_source(source_zip(), tmp_path)
    assert version == "1.0a42"
    assert dependencies == ["click>=7.1.1", "Jinja2>=2.10.3"]
    assert commit == SHA
    # Only the datasette/ package is copied, with its data files
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "datasette",
        "datasette-1.0a42.dist-info",
    ]
    assert (tmp_path / "datasette" / "templates" / "index.html").read_text() == "<h1>hi</h1>"
    assert (tmp_path / "datasette" / "static" / "app.css").exists()
    # It counts as an installed distribution, which is what stops a plugin
    # that requires "datasette" from installing a second copy
    (dist,) = distributions(path=[str(tmp_path)])
    assert dist.metadata["Name"] == "datasette"
    assert dist.version == "1.0a42"
    assert dist.requires == ["click>=7.1.1", "Jinja2>=2.10.3"]
    entry_points = {(ep.group, ep.name): ep.value for ep in dist.entry_points}
    assert entry_points == {
        ("console_scripts", "datasette"): "datasette.cli:cli",
        ("pytest11", "datasette"): "datasette._pytest_plugin",
    }


def test_root_directory_can_have_any_name(install_datasette_source, tmp_path):
    # GitHub names it after the ref: datasette-main, datasette-<sha>,
    # datasette-feature-branch
    install_datasette_source(source_zip(root="datasette-" + SHA), tmp_path)
    assert (tmp_path / "datasette" / "version.py").exists()


def test_commit_is_none_without_a_sha_comment(install_datasette_source, tmp_path):
    for comment in (b"", b"not a sha", b"\xff\xfe"):
        assert install_datasette_source(source_zip(comment=comment), tmp_path)[2] is None


@pytest.mark.parametrize("missing", ["pyproject.toml", "datasette/version.py"])
def test_old_releases_get_a_helpful_error(install_datasette_source, tmp_path, missing):
    files = {
        "setup.py": "",
        "pyproject.toml": PYPROJECT,
        "datasette/__init__.py": "",
        "datasette/version.py": '__version__ = "0.50"',
    }
    del files[missing]
    with pytest.raises(ValueError, match=r"\?ref=0\.64\.2"):
        install_datasette_source(source_zip(files), tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_rejects_zips_that_are_not_a_single_directory(install_datasette_source, tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("a/pyproject.toml", PYPROJECT)
        archive.writestr("b/datasette/version.py", '__version__ = "1"')
    with pytest.raises(ValueError, match="one top level directory"):
        install_datasette_source(buffer.getvalue(), tmp_path)


def test_rejects_paths_that_escape_site_packages(install_datasette_source, tmp_path):
    site_packages = tmp_path / "site-packages"
    site_packages.mkdir()
    files = {
        "pyproject.toml": PYPROJECT,
        "datasette/version.py": '__version__ = "1.0"',
        "datasette/../../evil.py": "",
    }
    with pytest.raises(ValueError, match="Unsafe path"):
        install_datasette_source(source_zip(files), site_packages)
    assert not (tmp_path / "evil.py").exists()


def versions(page, static_server, ref):
    frame = boot(page, static_server + "/?memory=1&ref=" + ref + "#/-/versions.json", wait_for="pre")
    return json.loads(frame.locator("pre").text_content())


def startup_error(page, static_server, ref):
    page.goto(static_server + "/?memory=1&ref=" + ref)
    page.wait_for_function(
        "document.getElementById('output').textContent.length", timeout=180 * 1000
    )
    return page.locator("#output")


@pytest.mark.network
def test_ref_commit(page, static_server):
    assert versions(page, static_server, SHA)["datasette"]["version"] == "1.0a42"


@pytest.mark.network
def test_ref_main(page, static_server):
    assert re.match(r"^\d+\.\d+", versions(page, static_server, "main")["datasette"]["version"])


@pytest.mark.network
def test_ref_commit_with_plugin(page, static_server):
    # The plugin requires "datasette": it must use the one installed from
    # source, not fetch another from PyPI
    frame = boot(
        page,
        static_server + "/?memory=1&install=datasette-packages&ref=" + SHA + "#/-/versions.json",
        wait_for="pre",
    )
    assert json.loads(frame.locator("pre").text_content())["datasette"]["version"] == "1.0a42"


@pytest.mark.network
def test_ref_unknown_branch(page, static_server):
    expect(startup_error(page, static_server, "no-such-branch-or-tag")).to_contain_text(
        "is not a branch, tag or commit in the Datasette repository"
    )


def test_ref_invalid(page, static_server):
    expect(startup_error(page, static_server, "not%20a%20ref")).to_contain_text(
        "is not a version number, branch, tag or commit"
    )

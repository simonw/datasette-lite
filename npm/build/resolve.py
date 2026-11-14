# Run inside Pyodide by build.mjs: install the requirements with micropip, then
# report every distribution that ended up installed as JSON.
import importlib.metadata
import json

import micropip
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

for requirement in json.loads(requirements_json):
    try:
        await micropip.install(requirement, pre=pre)
    except ValueError as ex:
        # "Requested 'click>=8.3.1', but click==8.1.7 is already installed":
        # micropip cannot upgrade, but nothing has been imported yet so the
        # older one can simply be removed
        import re

        match = re.search(r"Requested '(.+?)', but (\S+)==\S+ is already installed", str(ex))
        if not match:
            raise
        micropip.uninstall(match.group(2))
        await micropip.install(match.group(1))
        await micropip.install(requirement, pre=pre)


def missing_requirements():
    installed = {canonicalize_name(dist.metadata["Name"]) for dist in importlib.metadata.distributions()}
    missing = set()
    for dist in importlib.metadata.distributions():
        for line in dist.requires or []:
            requirement = Requirement(line)
            if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                continue
            if canonicalize_name(requirement.name) not in installed:
                missing.add(requirement.name)
    return sorted(missing)


# Some packages built into the Pyodide distribution do not list their
# dependencies (starlette lists none, so a plugin that needs it is installed
# without anyio). micropip trusts that list, so check against each package's
# own metadata. Repeated, as a fix can bring in a package with the same problem.
repaired = []
for _ in range(3):
    for name in missing_requirements():
        await micropip.install(name)
        repaired.append(name)


def top_level_imports(dist):
    names = set()
    for file in dist.files or []:
        first = file.parts[0]
        if first.endswith((".dist-info", ".data")) or first == "..":
            continue
        if len(file.parts) == 1:
            if first.endswith(".py"):
                names.add(first[:-3])
            elif ".cpython-" in first or first.endswith(".so"):
                names.add(first.split(".")[0])
        else:
            names.add(first)
    return sorted(names)


def requirements_of(dist):
    names = []
    for line in dist.requires or []:
        requirement = Requirement(line)
        if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
            continue
        names.append(canonicalize_name(requirement.name))
    return names


installed = []
for dist in importlib.metadata.distributions():
    installed.append(
        {
            "name": dist.metadata["Name"],
            "version": dist.version,
            # Only set for wheels micropip fetched from PyPI
            "url": dist.read_text("PYODIDE_URL"),
            "sha256": dist.read_text("PYODIDE_SHA256"),
            "imports": top_level_imports(dist),
            "requires": requirements_of(dist),
        }
    )

json.dumps({"installed": installed, "repaired": repaired})

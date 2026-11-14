# Run inside Pyodide by build.mjs: turn the base wheels into one tar.xz, laid
# out from "/" exactly as Pyodide would have installed them.
import json
import site
import tarfile
import zipfile

spec = json.loads(archive_json)
site_packages = site.getsitepackages()[0].strip("/") + "/"
dynlibs = []

with tarfile.open(spec["out"], "w:xz", preset=9) as archive:
    for wheel in spec["wheels"]:
        # Pyodide's shared_library packages (openssl) unpack into /usr/lib
        prefix = "usr/lib/" if wheel["dynlib"] else site_packages
        with zipfile.ZipFile(wheel["path"]) as source:
            for info in sorted(source.infolist(), key=lambda info: info.filename):
                if info.is_dir():
                    continue
                member = tarfile.TarInfo(prefix + info.filename)
                member.size = info.file_size
                member.mode = 0o644
                # No timestamps: the same inputs give the same archive
                member.mtime = 0
                with source.open(info) as fp:
                    archive.addfile(member, fp)
                if info.filename.endswith(".so"):
                    # Libraries other modules link against are loaded globally,
                    # and first
                    dynlibs.append({"path": "/" + member.name, "global": wheel["dynlib"]})

dynlibs.sort(key=lambda lib: (not lib["global"], lib["path"]))
json.dumps({"dynlibs": dynlibs})

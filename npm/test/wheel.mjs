// Packages a single-module Datasette plugin as a wheel, so the tests can load
// it with install: [...] like any other. A wheel is a zip file; this writes
// one with no compression, which needs nothing but a CRC. The same thing as
// build_wheel() in ../../tests/conftest.py.
import fs from "node:fs/promises";
import path from "node:path";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    // version, flags, method (stored), time, date, crc, sizes, name and extra lengths
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt32LE(crc32(data), 10);
    fields.writeUInt32LE(data.length, 14);
    fields.writeUInt32LE(data.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    const local = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), fields, nameBytes, data]);
    const central = Buffer.alloc(46);
    central.write("PK\x01\x02", 0, "latin1");
    central.writeUInt16LE(20, 4);
    fields.copy(central, 6);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    parts.push(local);
    offset += local.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06", 0, "latin1");
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/** Writes the wheel into directory and returns its path */
export async function buildWheel(directory, name, modulePath, version = "0.1") {
  const module = path.basename(modulePath, ".py");
  const dist = name.replace(/-/g, "_");
  const info = `${dist}-${version}.dist-info`;
  const files = {
    [`${module}.py`]: await fs.readFile(modulePath),
    [`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
    [`${info}/WHEEL`]: "Wheel-Version: 1.0\nGenerator: datasette-lite-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    [`${info}/entry_points.txt`]: `[datasette]\n${module} = ${module}\n`,
  };
  files[`${info}/RECORD`] = [...Object.keys(files), `${info}/RECORD`].map((file) => `${file},,\n`).join("");
  await fs.mkdir(directory, { recursive: true });
  const wheel = path.join(directory, `${dist}-${version}-py3-none-any.whl`);
  await fs.writeFile(wheel, zip(files));
  return wheel;
}

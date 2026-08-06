import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export function inspectElfIdentity(contents) {
  assert.ok(Buffer.isBuffer(contents), "native artifact must be a Buffer");
  assert.ok(contents.length >= 20, "native artifact is too short for an ELF header");
  assert.equal(contents.subarray(0, 4).equals(ELF_MAGIC), true, "native artifact ELF magic");
  const endianness = contents[5];
  assert.ok(endianness === 1 || endianness === 2, "native artifact ELF endianness");
  return {
    class: contents[4],
    endianness,
    machine: endianness === 1
      ? contents.readUInt16LE(18)
      : contents.readUInt16BE(18),
    flags: readElfFlags(contents, contents[4], endianness),
  };
}

function readElfFlags(contents, elfClass, endianness) {
  const offset = elfClass === 1 ? 36 : elfClass === 2 ? 48 : -1;
  assert.ok(offset >= 0 && contents.length >= offset + 4, "native artifact ELF flags");
  return endianness === 1
    ? contents.readUInt32LE(offset)
    : contents.readUInt32BE(offset);
}

export function validateNativeArtifact(source, target, { version } = {}) {
  assert.equal(path.basename(source), target.binary, `${target.id} artifact filename`);
  const contents = fs.readFileSync(source);
  assert.ok(contents.length > 0 && contents.length <= 8 * 1024 * 1024);
  assert.deepEqual(inspectElfIdentity(contents), {
    class: target.elf.class,
    endianness: target.elf.endianness,
    machine: target.elf.machine,
    flags: target.elf.flags,
  });
  assert.equal(
    contents.includes(Buffer.from(target.rustTarget)),
    true,
    `${target.id} artifact omits its embedded target triple`,
  );
  if (version !== undefined) {
    assert.equal(
      contents.includes(Buffer.from(version)),
      true,
      `${target.id} artifact omits its embedded package version`,
    );
  }
  return { contents, bytes: contents.length };
}

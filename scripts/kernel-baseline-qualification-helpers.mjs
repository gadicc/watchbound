import assert from "node:assert/strict";
import fs from "node:fs";

export function assertCleanQemuCompletion(result) {
  if (result.error) throw result.error;
  if (result.status === 0 && result.signal === null) return;
  throw new Error(
    `QEMU did not exit cleanly (status=${result.status}, signal=${result.signal})`,
  );
}

export function copyTreePreservingSymlinks(source, destination) {
  assert.ok(fs.statSync(source).isDirectory(), `missing directory ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
}

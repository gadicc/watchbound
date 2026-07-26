import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const INDEPENDENT_NATIVE_MATRIX_EVIDENCE = Object.freeze({
  schemaVersion: 2,
  kind: "watchbound-independent-native-matrix-comparison",
});

export function readOptionalEvidence(source, expectedIdentity) {
  if (!source) return null;
  const value = JSON.parse(fs.readFileSync(path.resolve(source), "utf8"));
  assert.equal(
    value.schemaVersion,
    expectedIdentity.schemaVersion,
    `${expectedIdentity.kind} schema version`,
  );
  assert.equal(
    value.kind,
    expectedIdentity.kind,
    `${expectedIdentity.kind} kind`,
  );
  return value;
}

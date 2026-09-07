import assert from "node:assert/strict";

export const RELEASE_CLASS = Object.freeze({
  NONE: "none",
  WRAPPER: "wrapper",
  NATIVE: "native",
});

const BASELINE_SELECTION_PATH = "config/qualified-native-stack.json";

export function classifyReleaseChanges(paths) {
  assert.ok(Array.isArray(paths), "release paths must be an array");
  const normalized = [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
  if (normalized.length === 0) {
    return classification(RELEASE_CLASS.NONE, normalized, "no-changes");
  }

  const substantive = normalized.filter((entry) => !isDocumentationPath(entry));
  if (substantive.length === 0) {
    return classification(RELEASE_CLASS.NONE, normalized, "documentation-only");
  }
  const releaseRelevant = substantive.filter((entry) => entry !== BASELINE_SELECTION_PATH);
  if (releaseRelevant.length === 0) {
    return classification(RELEASE_CLASS.NONE, normalized, "native-baseline-selection-only");
  }
  if (releaseRelevant.every(isWrapperPath)) {
    return classification(RELEASE_CLASS.WRAPPER, normalized, "wrapper-only");
  }
  return classification(RELEASE_CLASS.NATIVE, normalized, "native-or-uncertain");
}

function classification(releaseClass, paths, reason) {
  return Object.freeze({
    releaseClass,
    reason,
    paths: Object.freeze(paths),
  });
}

function isDocumentationPath(entry) {
  return entry === "README.md" ||
    entry === "AGENTS.md" ||
    entry === "CONTRIBUTING.md" ||
    entry.startsWith("docs/") ||
    entry.startsWith("skills/");
}

function isWrapperPath(entry) {
  if (!entry.startsWith("js/")) return false;
  return !entry.startsWith("js/test/fixtures/native/");
}

function normalizePath(value) {
  assert.equal(typeof value, "string", "release path must be a string");
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").trim();
}

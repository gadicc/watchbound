import assert from "node:assert/strict";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function createReleasePackagePlan({
  releaseClass,
  wrapperVersion,
  nativeStackVersion,
  targets,
}) {
  assert.ok(releaseClass === "native" || releaseClass === "wrapper");
  assert.match(wrapperVersion ?? "", SEMVER_PATTERN);
  assert.match(nativeStackVersion ?? "", SEMVER_PATTERN);
  assert.ok(Array.isArray(targets));
  if (releaseClass === "native") {
    assert.equal(
      wrapperVersion,
      nativeStackVersion,
      "native release package versions must remain lockstep",
    );
  } else {
    assert.ok(
      compareExactVersions(nativeStackVersion, wrapperVersion) < 0,
      "wrapper release packages require an older native stack",
    );
  }
  const targetPins = Object.fromEntries(
    targets.map(({ package: packageName }) => [packageName, nativeStackVersion]),
  );
  return Object.freeze({
    releaseClass,
    wrapper: Object.freeze({
      version: wrapperVersion,
      dependencies: Object.freeze({
        "@gadicc/watchbound-node": nativeStackVersion,
      }),
    }),
    loader: releaseClass === "native"
      ? Object.freeze({
          version: nativeStackVersion,
          optionalDependencies: Object.freeze(targetPins),
        })
      : null,
    targets: releaseClass === "native"
      ? Object.freeze(targets.map((target) => Object.freeze({
          id: target.id,
          name: target.package,
          version: nativeStackVersion,
        })))
      : Object.freeze([]),
  });
}

export function compareExactVersions(left, right) {
  const leftVersion = parseExactVersion(left);
  const rightVersion = parseExactVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] < rightVersion.core[index]) return -1;
    if (leftVersion.core[index] > rightVersion.core[index]) return 1;
  }
  if (leftVersion.prerelease === null) return rightVersion.prerelease === null ? 0 : 1;
  if (rightVersion.prerelease === null) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(leftIdentifier);
      const rightValue = BigInt(rightIdentifier);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseExactVersion(version) {
  const match = SEMVER_PATTERN.exec(version ?? "");
  assert.ok(match, "release version must be exact semver");
  const [major, minor, patch] = version
    .split("-", 1)[0]
    .split(".")
    .map((value) => BigInt(value));
  const separator = version.indexOf("-");
  return {
    core: [major, minor, patch],
    prerelease: separator === -1 ? null : version.slice(separator + 1).split("."),
  };
}

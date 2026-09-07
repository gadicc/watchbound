import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_VERSION,
  assertWorkspaceVersion,
} from "./lib/release-version.mjs";
import { compareExactVersions } from "./lib/release-package-plan.mjs";
import { classifyReleaseChanges } from "./lib/release-classification.mjs";
import { readQualifiedNativeStack } from "./lib/qualified-native-stack.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const plan = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);

assert.equal(plan.schemaVersion, 3, "release plan schema");
assert.equal(plan.kind, "watchbound-release-plan", "release plan kind");
assert.equal(plan.mode, options.mode, "release plan mode");
assert.equal(plan.sourceSha, sourceSha, "release plan source SHA");
assert.equal(plan.sourceVersion, SOURCE_VERSION, "release plan source version");
assert.equal(typeof plan.qualify, "boolean", "release plan qualify value");
assert.equal(
  typeof plan.willRelease,
  "boolean",
  "release plan publication value",
);
assert.ok(["none", "wrapper", "native"].includes(plan.changeClass));
assert.ok(["none", "wrapper", "native"].includes(plan.releaseClass));
assert.ok(Array.isArray(plan.changedPaths), "release plan changed paths");
if (options.mode === "release") {
  assert.match(plan.baseSha ?? "", /^[0-9a-f]{40}$/u, "release plan base SHA");
  const actualPaths = capture("git", [
    "diff",
    "--no-renames",
    "--name-only",
    `${plan.baseSha}..${sourceSha}`,
    "--",
  ]).split("\n").filter(Boolean);
  const classified = classifyReleaseChanges(actualPaths);
  assert.deepEqual(
    plan.changedPaths,
    classified.paths,
    "release plan changed paths differ from Git",
  );
  assert.equal(plan.changeClass, classified.releaseClass, "release plan change class");
  assert.equal(plan.classification, classified.reason, "release plan classification");
}

if (options.mode === "qualification") {
  assert.equal(plan.qualify, true, "qualification plan must qualify");
  assert.equal(plan.releaseClass, "native", "qualification release class");
  assert.equal(plan.baseSha, null, "qualification plan base SHA");
  assert.equal(plan.willRelease, false, "qualification plan cannot publish");
  assert.equal(plan.version, SOURCE_VERSION, "qualification plan version");
  assert.equal(plan.wrapperVersion, SOURCE_VERSION, "qualification wrapper version");
  assert.equal(plan.nativeStackVersion, SOURCE_VERSION, "qualification native version");
  assert.equal(plan.tag, null, "qualification plan cannot select a tag");
} else if (plan.willRelease) {
  assert.equal(plan.releaseClass, plan.changeClass, "release plan selected change class");
  assert.equal(
    plan.qualify,
    plan.releaseClass === "native",
    "only native releases run native qualification",
  );
  assert.match(
    plan.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    "release plan version",
  );
  assert.notEqual(plan.version, SOURCE_VERSION, "release plan uses source placeholder");
  assert.equal(plan.wrapperVersion, plan.version, "release plan wrapper version");
  assert.match(plan.nativeStackVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  if (plan.releaseClass === "native") {
    assert.equal(plan.nativeStackVersion, plan.wrapperVersion, "native release lockstep");
  } else {
    assert.equal(plan.releaseClass, "wrapper", "publishable release class");
    assert.equal(
      plan.nativeStackVersion,
      readQualifiedNativeStack(workspaceRoot).version,
      "wrapper plan selected native baseline",
    );
    assert.ok(
      compareExactVersions(plan.nativeStackVersion, plan.wrapperVersion) < 0,
      "wrapper release requires an older native stack",
    );
  }
  assert.equal(typeof plan.tag, "string", "release plan tag");
  assert.ok(plan.tag.length > 0, "release plan tag cannot be empty");
} else {
  assert.equal(plan.qualify, false, "non-release plan cannot qualify");
  assert.equal(plan.releaseClass, "none", "non-release plan class");
  assert.equal(plan.version, null, "non-release plan cannot select a version");
  assert.equal(plan.wrapperVersion, null, "non-release plan wrapper version");
  assert.equal(plan.nativeStackVersion, null, "non-release plan native version");
  assert.equal(plan.tag, null, "non-release plan cannot select a tag");
}

fs.appendFileSync(
  path.resolve(options["github-output"]),
  [
    `qualify=${plan.qualify}`,
    `will-release=${plan.willRelease}`,
    `change-class=${plan.changeClass}`,
    `release-class=${plan.releaseClass}`,
    `source-version=${plan.sourceVersion}`,
    `version=${plan.version ?? ""}`,
    `wrapper-version=${plan.wrapperVersion ?? ""}`,
    `native-stack-version=${plan.nativeStackVersion ?? ""}`,
    `source-sha=${plan.sourceSha}`,
    `tag=${plan.tag ?? ""}`,
    "",
  ].join("\n"),
);
process.stdout.write(
  `Selected ${plan.mode} plan for ${plan.sourceSha} (qualify=${plan.qualify})\n`,
);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: select-release-plan.mjs --mode <qualification|release> --input <path> --github-output <path>",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(
    parsed.mode === "qualification" || parsed.mode === "release",
    "--mode must be qualification or release",
  );
  assert.ok(parsed.input, "--input is required");
  assert.ok(parsed["github-output"], "--github-output is required");
  return parsed;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

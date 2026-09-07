import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import semanticRelease from "semantic-release";
import { fileURLToPath } from "node:url";
import {
  SOURCE_VERSION,
  assertWorkspaceVersion,
} from "./lib/release-version.mjs";
import {
  RELEASE_CLASS,
  classifyReleaseChanges,
} from "./lib/release-classification.mjs";
import { readQualifiedNativeStack } from "./lib/qualified-native-stack.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);
let plan;

if (options.mode === "qualification") {
  plan = {
    schemaVersion: 3,
    kind: "watchbound-release-plan",
    mode: options.mode,
    changeClass: RELEASE_CLASS.NATIVE,
    releaseClass: RELEASE_CLASS.NATIVE,
    classification: "manual-native-qualification",
    baseSha: null,
    changedPaths: [],
    qualify: true,
    willRelease: false,
    sourceVersion: SOURCE_VERSION,
    version: SOURCE_VERSION,
    wrapperVersion: SOURCE_VERSION,
    nativeStackVersion: SOURCE_VERSION,
    sourceSha,
    tag: null,
  };
} else {
  const result = await semanticRelease(
    {
      dryRun: true,
      ci: false,
    },
    {
      cwd: workspaceRoot,
      env: process.env,
    },
  );
  const lastReleaseSha = result === false
    ? capture("git", ["rev-list", "-n", "1", capture("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"])])
    : result.lastRelease.gitHead;
  const changedPaths = capture("git", [
    "diff",
    "--no-renames",
    "--name-only",
    `${lastReleaseSha}..${sourceSha}`,
    "--",
  ]).split("\n").filter(Boolean);
  const change = classifyReleaseChanges(changedPaths);
  if (result === false) {
    plan = {
      schemaVersion: 3,
      kind: "watchbound-release-plan",
      mode: options.mode,
      changeClass: change.releaseClass,
      releaseClass: RELEASE_CLASS.NONE,
      classification: change.reason,
      baseSha: lastReleaseSha,
      changedPaths: change.paths,
      qualify: false,
      willRelease: false,
      sourceVersion: SOURCE_VERSION,
      version: null,
      wrapperVersion: null,
      nativeStackVersion: null,
      sourceSha,
      tag: null,
    };
  } else {
    assert.match(
      result.nextRelease.version,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
      "semantic-release planned an invalid version",
    );
    assert.notEqual(
      result.nextRelease.version,
      SOURCE_VERSION,
      "semantic-release cannot publish the source placeholder",
    );
    assert.equal(
      result.nextRelease.gitHead,
      sourceSha,
      "semantic-release planned a different source commit",
    );
    const releaseClass = change.releaseClass;
    const willRelease = releaseClass !== RELEASE_CLASS.NONE;
    const nativeStackVersion = releaseClass === RELEASE_CLASS.WRAPPER
      ? readQualifiedNativeStack(workspaceRoot).version
      : result.nextRelease.version;
    plan = {
      schemaVersion: 3,
      kind: "watchbound-release-plan",
      mode: options.mode,
      changeClass: change.releaseClass,
      releaseClass,
      classification: change.reason,
      baseSha: lastReleaseSha,
      changedPaths: change.paths,
      qualify: releaseClass === RELEASE_CLASS.NATIVE,
      willRelease,
      sourceVersion: SOURCE_VERSION,
      version: willRelease ? result.nextRelease.version : null,
      wrapperVersion: willRelease ? result.nextRelease.version : null,
      nativeStackVersion: willRelease ? nativeStackVersion : null,
      sourceSha,
      tag: willRelease ? result.nextRelease.gitTag : null,
    };
  }
}

fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
fs.writeFileSync(
  path.resolve(options.output),
  `${JSON.stringify(plan, null, 2)}\n`,
);
if (options["github-output"]) {
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
}
process.stdout.write(`${JSON.stringify(plan)}\n`);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: plan-release.mjs --mode <qualification|release> --output <path> [--github-output <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(
    parsed.mode === "qualification" || parsed.mode === "release",
    "--mode must be qualification or release",
  );
  assert.ok(parsed.output, "--output is required");
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

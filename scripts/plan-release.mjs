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
    schemaVersion: 2,
    kind: "watchbound-release-plan",
    mode: options.mode,
    qualify: true,
    willRelease: false,
    sourceVersion: SOURCE_VERSION,
    version: SOURCE_VERSION,
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
  if (result === false) {
    plan = {
      schemaVersion: 2,
      kind: "watchbound-release-plan",
      mode: options.mode,
      qualify: false,
      willRelease: false,
      sourceVersion: SOURCE_VERSION,
      version: null,
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
    plan = {
      schemaVersion: 2,
      kind: "watchbound-release-plan",
      mode: options.mode,
      qualify: true,
      willRelease: true,
      sourceVersion: SOURCE_VERSION,
      version: result.nextRelease.version,
      sourceSha,
      tag: result.nextRelease.gitTag,
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
      `source-version=${plan.sourceVersion}`,
      `version=${plan.version ?? ""}`,
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

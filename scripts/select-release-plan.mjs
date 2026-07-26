import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const plan = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
const version = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
).version;
const sourceSha = capture("git", ["rev-parse", "HEAD"]);

assert.equal(plan.schemaVersion, 1, "release plan schema");
assert.equal(plan.kind, "watchbound-release-plan", "release plan kind");
assert.equal(plan.mode, options.mode, "release plan mode");
assert.equal(plan.sourceSha, sourceSha, "release plan source SHA");
assert.equal(typeof plan.qualify, "boolean", "release plan qualify value");
assert.equal(
  typeof plan.willRelease,
  "boolean",
  "release plan publication value",
);

if (options.mode === "qualification") {
  assert.equal(plan.qualify, true, "qualification plan must qualify");
  assert.equal(plan.willRelease, false, "qualification plan cannot publish");
  assert.equal(plan.version, version, "qualification plan version");
  assert.equal(plan.tag, null, "qualification plan cannot select a tag");
} else if (plan.willRelease) {
  assert.equal(plan.qualify, true, "release plan must qualify before publication");
  assert.equal(plan.version, version, "release plan version");
  assert.equal(typeof plan.tag, "string", "release plan tag");
  assert.ok(plan.tag.length > 0, "release plan tag cannot be empty");
} else {
  assert.equal(plan.qualify, false, "non-release plan cannot qualify");
  assert.equal(plan.version, null, "non-release plan cannot select a version");
  assert.equal(plan.tag, null, "non-release plan cannot select a tag");
}

fs.appendFileSync(
  path.resolve(options["github-output"]),
  [
    `qualify=${plan.qualify}`,
    `will-release=${plan.willRelease}`,
    `version=${plan.version ?? ""}`,
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

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { materializeReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const version = process.argv[2];
const options = parseOptions(process.argv.slice(3));
const sourceSha = options.sourceSha ?? captureGitHead();
const releaseClass = options.releaseClass ?? "native";
const nativeStackVersion = options.nativeStackVersion ?? version;

if (
  !version ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
  !/^[0-9a-f]{40}$/u.test(sourceSha ?? "")
) {
  throw new Error(
    "usage: node scripts/set-release-version.mjs <wrapper-semver> [--source-sha <sha>] [--release-class <native|wrapper>] [--native-stack-version <semver>]",
  );
}

materializeReleaseCandidate(workspaceRoot, {
  sourceSha,
  wrapperVersion: version,
  nativeStackVersion,
  releaseClass,
});

process.stdout.write(
  `Stamped Watchbound ${releaseClass} release wrapper=${version} native=${nativeStackVersion}\n`,
);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("release version options must be flag/value pairs");
    }
    const key = flag.slice(2);
    if (key === "source-sha") parsed.sourceSha = value;
    else if (key === "release-class") parsed.releaseClass = value;
    else if (key === "native-stack-version") parsed.nativeStackVersion = value;
    else throw new Error(`unknown release version option: ${flag}`);
  }
  return parsed;
}

function captureGitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

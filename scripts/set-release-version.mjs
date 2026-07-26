import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { materializeReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const version = process.argv[2];
const hasSourceSha = process.argv[3] === "--source-sha";
const sourceSha = hasSourceSha
  ? process.argv[4]
  : captureGitHead();

if (
  !version ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
  (!hasSourceSha && process.argv.length !== 3) ||
  (hasSourceSha && process.argv.length !== 5) ||
  (hasSourceSha && !/^[0-9a-f]{40}$/u.test(sourceSha ?? ""))
) {
  throw new Error(
    "usage: node scripts/set-release-version.mjs <semver> [--source-sha <sha>]",
  );
}

materializeReleaseCandidate(workspaceRoot, { sourceSha, version });

process.stdout.write(`Stamped Watchbound release version ${version}\n`);

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

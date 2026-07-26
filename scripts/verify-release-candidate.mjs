import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const candidate = verifyReleaseCandidate(workspaceRoot, options);
process.stdout.write(
  `Verified ${candidate.sourceSha} materialized as ${candidate.version}\n`,
);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: verify-release-candidate.mjs --source-sha <sha> --version <semver>",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed["source-sha"] || !parsed.version) {
    throw new Error("--source-sha and --version are required");
  }
  return { sourceSha: parsed["source-sha"], version: parsed.version };
}

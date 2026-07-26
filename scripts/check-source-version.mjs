import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_VERSION,
  assertCommittedSourceVersion,
  assertWorkspaceVersion,
  verifyReleaseCandidate,
} from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const candidateVersion = process.env.WATCHBOUND_CANDIDATE_VERSION ?? null;
const candidateSha = process.env.WATCHBOUND_CANDIDATE_SHA ?? null;

if (candidateVersion === null && candidateSha === null) {
  assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);
  process.stdout.write(
    `Verified permanent source version ${SOURCE_VERSION}; semantic-release owns published versions\n`,
  );
} else {
  if (candidateVersion === null || candidateSha === null) {
    throw new Error(
      "WATCHBOUND_CANDIDATE_VERSION and WATCHBOUND_CANDIDATE_SHA must be set together",
    );
  }
  assertCommittedSourceVersion(workspaceRoot);
  verifyReleaseCandidate(workspaceRoot, {
    sourceSha: candidateSha,
    version: candidateVersion,
  });
  process.stdout.write(
    `Verified semantic-release candidate ${candidateSha} at ${candidateVersion}\n`,
  );
}

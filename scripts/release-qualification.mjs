import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  QualificationInputError,
  createQualificationState,
  formatQualificationReport,
  identifyQualificationRun,
  planQualificationDispatch,
  selectActiveQualificationRun,
} from "./lib/release-qualification.mjs";
import { reviewConditionalRerun } from "./lib/release-qualification-review.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAX_REVIEW_JSON_BYTES = 16 * 1024 * 1024;

const HELP = `Usage:
  pnpm release:qualify -- [status] [--ref dev] [--candidate-sha <sha>] [--json]
  pnpm release:qualify -- watch [--ref dev] [--candidate-sha <sha>]
  pnpm release:qualify -- dispatch --scenario <scenario> [--attempt <n>] [--reviewed-run <run-id>] [--accept-rerun <run-id>] [--ref dev] [--candidate-sha <sha>]

The default status command reconstructs progress from exact-SHA GitHub Actions
runs. Watch polls the one active exact-candidate run, then reconstructs status
again without changing the candidate SHA. Dispatch is fail-closed against
duplicates, overlapping runs, GitHub reruns as qualification evidence, stale
refs, skipped attempt numbers, and an unreviewed prerequisite. One green
failed-job rerun may be conditionally accepted only after the fail-closed
automated infrastructure/environmental review passes and the maintainer
explicitly confirms it.
`;

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    process.exitCode = 0;
  } else {
    run(options);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release qualification: ${message}\n`);
  if (error instanceof QualificationInputError) {
    process.stderr.write("Run with --help for guarded usage.\n");
  }
  process.exitCode = 1;
}

function run(options) {
  requireGitHubAuthentication();
  const { repository, state } = loadQualificationContext(options);

  if (options.command === "watch") {
    watchQualificationRun({ repository, state, options });
    return;
  }

  if (options.command === "dispatch") {
    const dispatch = planQualificationDispatch({
      state,
      scenario: options.scenario,
      attempt: options.attempt,
      reviewedRunId: options.reviewedRunId,
      acceptedRerunId: options.acceptedRerunId,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ state, dispatch }, null, 2)}\n`);
      return;
    }
    process.stdout.write(formatQualificationReport(state));
    process.stdout.write(
      `\nDispatching ${dispatch.scenario} attempt ${dispatch.attempt} for ${dispatch.candidateSha}...\n`,
    );
    const output = capture("gh", [...dispatch.args, "--repo", repository]);
    process.stdout.write(output.length > 0 ? `${output}\n` : "Dispatch accepted. Reload status shortly.\n");
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else {
    process.stdout.write(formatQualificationReport(state));
  }
}

function loadQualificationContext(options, knownRepository) {
  const repository = knownRepository ?? parseJson(
    capture("gh", ["repo", "view", "--json", "nameWithOwner"]),
    "GitHub repository identity",
  ).nameWithOwner;
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("gh did not return a repository identity");
  }

  const refRecord = parseJson(
    capture("gh", [
      "api",
      `repos/${repository}/commits/${encodeURIComponent(options.ref)}`,
    ]),
    `remote ${options.ref}`,
  );
  const remoteSha = refRecord.sha;
  const localHead = capture("git", ["rev-parse", "HEAD"]);
  const dirty = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).length > 0;
  const candidateSha = options.candidateSha ?? remoteSha;
  const listedRuns = parseJson(
    capture("gh", [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      "release.yml",
      "--branch",
      options.ref,
      "--commit",
      candidateSha,
      "--event",
      "workflow_dispatch",
      "--limit",
      "50",
      "--json",
      "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,status,updatedAt,url,workflowName",
    ]),
    "qualification run list",
  );
  if (!Array.isArray(listedRuns)) {
    throw new Error("gh run list did not return an array");
  }

  const runs = listedRuns.map((listedRun) => enrichRun(repository, listedRun));
  const state = createQualificationState({
    candidateSha,
    ref: options.ref,
    remoteSha,
    localHead,
    dirty,
    runs,
  });

  return { repository, state };
}

function watchQualificationRun({ repository, state, options }) {
  process.stdout.write(formatQualificationReport(state));
  const activeRun = selectActiveQualificationRun(state);
  if (activeRun === null) {
    process.stdout.write(
      "\nNo active exact-candidate qualification run remains to watch.\n",
    );
    return;
  }

  process.stdout.write(
    `\nWatching GitHub run ${activeRun.databaseId} until completion (15-second polling)...\n`,
  );
  const result = spawnSync(
    "gh",
    [
      "run",
      "watch",
      String(activeRun.databaseId),
      "--repo",
      repository,
      "--compact",
      "--interval",
      "15",
    ],
    { cwd: workspaceRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const outcome = result.signal === null
      ? `status ${result.status}`
      : `signal ${result.signal}`;
    throw new Error(`gh run watch stopped with ${outcome}`);
  }

  process.stdout.write(
    `\nRun ${activeRun.databaseId} finished; refreshing exact-candidate qualification state...\n\n`,
  );
  const refreshed = loadQualificationContext(
    { ...options, candidateSha: state.candidateSha },
    repository,
  );
  process.stdout.write(formatQualificationReport(refreshed.state));
}

function enrichRun(repository, run) {
  const artifactResponse = parseJson(
    capture("gh", [
      "api",
      `repos/${repository}/actions/runs/${run.databaseId}/artifacts?per_page=100`,
    ]),
    `artifacts for run ${run.databaseId}`,
  );
  const artifactNames = Array.isArray(artifactResponse.artifacts)
    ? artifactResponse.artifacts.map((artifact) => artifact.name)
    : [];
  let approvalRecord = null;
  if (artifactNames.includes("watchbound-qualification-plan")) {
    approvalRecord = downloadApprovalRecord(repository, run.databaseId);
  }
  const initial = identifyQualificationRun(run, {
    approvalRecord,
    artifactNames,
  });
  if (!initial.conditionalEligible) return initial;
  const automatedReview = collectConditionalReview(repository, initial);
  return identifyQualificationRun(run, {
    approvalRecord,
    artifactNames,
    automatedReview,
  });
}

function collectConditionalReview(repository, run) {
  try {
    const attemptOne = loadWorkflowAttempt(repository, run.databaseId, 1);
    const attemptTwo = loadWorkflowAttempt(repository, run.databaseId, 2);
    const failedLog = capture("gh", [
      "run",
      "view",
      String(run.databaseId),
      "--repo",
      repository,
      "--attempt",
      "1",
      "--log-failed",
    ]);
    const evidence = downloadOverflowEvidence(repository, run.databaseId);
    return reviewConditionalRerun({
      candidateSha: run.headSha,
      runId: run.databaseId,
      scenario: run.scenario,
      scenarioAttempt: run.scenarioAttempt,
      workflowAttempt: run.workflowAttempt,
      attemptOne,
      attemptTwo,
      failedLog,
      evidence,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      kind: "watchbound-automated-conditional-rerun-review",
      passed: false,
      checks: [],
      issues: [`automated review could not complete: ${message}`],
    };
  }
}

function loadWorkflowAttempt(repository, runId, attempt) {
  return parseJson(
    capture("gh", [
      "run",
      "view",
      String(runId),
      "--repo",
      repository,
      "--attempt",
      String(attempt),
      "--json",
      "attempt,conclusion,jobs,status",
    ]),
    `workflow run ${runId} attempt ${attempt}`,
  );
}

function downloadOverflowEvidence(repository, runId) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), `watchbound-overflow-review-${runId}-`),
  );
  try {
    capture("gh", [
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--pattern",
      "watchbound-release-overflow-*",
      "--dir",
      temporary,
    ]);
    return findFilesNamed(temporary, "preflight.json").map((preflightPath) => {
      const preflight = readJsonFile(
        preflightPath,
        `overflow preflight ${preflightPath}`,
      );
      const reportPath = path.join(path.dirname(preflightPath), "conformance.json");
      if (!fs.existsSync(reportPath)) {
        throw new Error(`overflow artifact is missing ${reportPath}`);
      }
      return {
        target: preflight?.canonicalArtifact?.target ?? null,
        preflight,
        report: readJsonFile(
          reportPath,
          `overflow conformance report ${reportPath}`,
        ),
      };
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function findFilesNamed(root, filename) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === filename) matches.push(candidate);
    }
  }
  return matches.sort();
}

function readJsonFile(filename, label) {
  const size = fs.statSync(filename).size;
  if (size > MAX_REVIEW_JSON_BYTES) {
    throw new Error(
      `${label} exceeds the ${MAX_REVIEW_JSON_BYTES}-byte automated review limit`,
    );
  }
  return parseJson(fs.readFileSync(filename, "utf8"), label);
}

function downloadApprovalRecord(repository, runId) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), `watchbound-qualification-${runId}-`),
  );
  try {
    const result = spawnSync(
      "gh",
      [
        "run",
        "download",
        String(runId),
        "--repo",
        repository,
        "--name",
        "watchbound-qualification-plan",
        "--dir",
        temporary,
      ],
      { cwd: workspaceRoot, encoding: "utf8", stdio: "pipe" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    const approvalPath = path.join(temporary, "qualification-dispatch.json");
    if (!fs.existsSync(approvalPath)) return null;
    return parseJson(fs.readFileSync(approvalPath, "utf8"), `approval for run ${runId}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function requireGitHubAuthentication() {
  const result = spawnSync("gh", ["auth", "status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error?.code === "EPERM") {
    throw new Error(
      "GitHub CLI execution is blocked by the current sandbox; run this command in an authenticated host shell",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "GitHub CLI authentication is unavailable; run `gh auth login -h github.com` and retry outside the Codex sandbox",
    );
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}${details ? `: ${details}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function parseOptions(args) {
  if (args[0] === "--") args = args.slice(1);
  const parsed = {
    command: "status",
    ref: "dev",
    candidateSha: undefined,
    scenario: undefined,
    attempt: undefined,
    reviewedRunId: undefined,
    acceptedRerunId: undefined,
    json: false,
    help: false,
  };
  let index = 0;
  if (args[0] && !args[0].startsWith("--")) {
    parsed.command = args[0];
    index = 1;
  }
  if (!new Set(["status", "watch", "dispatch"]).has(parsed.command)) {
    throw new QualificationInputError("command must be status, watch, or dispatch");
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--json" || flag === "--help") {
      parsed[flag.slice(2)] = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new QualificationInputError(`${flag} requires a value`);
    }
    if (flag === "--ref") parsed.ref = value;
    else if (flag === "--candidate-sha") parsed.candidateSha = value;
    else if (flag === "--scenario") parsed.scenario = value;
    else if (flag === "--attempt") parsed.attempt = value;
    else if (flag === "--reviewed-run") parsed.reviewedRunId = value;
    else if (flag === "--accept-rerun") parsed.acceptedRerunId = value;
    else throw new QualificationInputError(`unknown option: ${flag}`);
    index += 2;
  }
  if (parsed.command === "dispatch" && parsed.scenario === undefined) {
    throw new QualificationInputError("dispatch requires --scenario");
  }
  if (parsed.command === "watch" && parsed.json) {
    throw new QualificationInputError("watch cannot be combined with --json");
  }
  return parsed;
}

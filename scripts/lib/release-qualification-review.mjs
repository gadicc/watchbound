const KERNEL_JOB_PATTERNS = [
  /^Release kernel 5\.15 \((linux-(?:x64|arm64)-gnu|linux-arm-gnueabihf), QEMU component\)$/u,
  /^Qualify exact release source \/ Kernel 5\.15 \((linux-(?:x64|arm64)-gnu|linux-arm-gnueabihf), QEMU component\)$/u,
];
const KERNEL_STEP_NAMES = new Set([
  "Exercise the canonical package on a real pinned 5.15 kernel",
  "Exercise the exact package on a real pinned 5.15 kernel",
]);
const TARGETS = ["linux-x64-gnu", "linux-arm64-gnu"];
const KERNEL_TARGETS = [...TARGETS, "linux-arm-gnueabihf"];
const SEMANTIC_FAILURE_PATTERNS = [
  /AssertionError/u,
  /ERR_ASSERTION/u,
  /WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE=/u,
  /WATCHBOUND_KERNEL_BASELINE_STATUS=failed/u,
  /(?:conformance|semantic)[^\n]{0,120}(?:failed|nonconforming)/iu,
];

export function reviewConditionalRerun({
  candidateSha,
  runId,
  scenario,
  scenarioAttempt,
  workflowAttempt,
  attemptOne,
  attemptTwo,
  failedLog,
  evidence,
}) {
  const checks = [];
  const check = (name, passed, details) => {
    checks.push({ name, passed: passed === true, details });
  };
  const firstJobs = Array.isArray(attemptOne?.jobs) ? attemptOne.jobs : [];
  const secondJobs = Array.isArray(attemptTwo?.jobs) ? attemptTwo.jobs : [];
  const failedJobs = firstJobs.filter((job) => job.conclusion === "failure");
  const failedTargets = failedJobs.map((job) => kernelJobTarget(job.name));

  check(
    "single-diagnostic-rerun",
    workflowAttempt === 2 && attemptTwo?.attempt === 2,
    `workflow attempt ${workflowAttempt}`,
  );
  check(
    "original-attempt-completed-failure",
    attemptOne?.attempt === 1 &&
      attemptOne?.status === "completed" &&
      attemptOne?.conclusion === "failure",
    `${attemptOne?.status ?? "missing"}/${attemptOne?.conclusion ?? "missing"}`,
  );
  check(
    "original-failures-limited-to-kernel-baseline",
    failedJobs.length > 0 &&
      failedJobs.length <= KERNEL_TARGETS.length * KERNEL_JOB_PATTERNS.length &&
      failedTargets.every((target) => target !== null),
    failedJobs.length === 0
      ? "no failed jobs found"
      : failedJobs.map((job) => job.name).join(", "),
  );
  const unexpectedOriginalConclusions = firstJobs.filter(
    (job) => !new Set(["success", "skipped", "failure"]).has(job.conclusion),
  );
  check(
    "original-attempt-has-no-cancelled-or-unknown-jobs",
    firstJobs.length > 0 && unexpectedOriginalConclusions.length === 0,
    unexpectedOriginalConclusions.length === 0
      ? `${firstJobs.length} jobs checked`
      : unexpectedOriginalConclusions
        .map((job) => `${job.name}: ${job.conclusion}`)
        .join(", "),
  );
  check(
    "original-failed-steps-limited-to-kernel-exercise",
    failedJobs.length > 0 && failedJobs.every((job) => {
      const failedSteps = Array.isArray(job.steps)
        ? job.steps.filter((step) => step.conclusion === "failure")
        : [];
      return failedSteps.length === 1 && KERNEL_STEP_NAMES.has(failedSteps[0].name);
    }),
    [...KERNEL_STEP_NAMES].join(" or "),
  );

  const log = typeof failedLog === "string" ? failedLog : "";
  const timeoutTargets = failedTargets.filter((target) =>
    hasTargetTimeoutSignature(log, target)
  );
  check(
    "original-failures-have-qemu-timeout-signatures",
    failedTargets.length > 0 && timeoutTargets.length === failedTargets.length,
    timeoutTargets.length === 0
      ? "no target-specific QEMU ETIMEDOUT signature found"
      : timeoutTargets.join(", "),
  );
  const semanticSignatures = SEMANTIC_FAILURE_PATTERNS
    .filter((pattern) => pattern.test(log))
    .map((pattern) => pattern.source);
  check(
    "original-logs-have-no-semantic-failure-signature",
    semanticSignatures.length === 0,
    semanticSignatures.length === 0
      ? "none"
      : semanticSignatures.join(", "),
  );

  check(
    "diagnostic-rerun-completed-successfully",
    attemptTwo?.status === "completed" && attemptTwo?.conclusion === "success",
    `${attemptTwo?.status ?? "missing"}/${attemptTwo?.conclusion ?? "missing"}`,
  );
  const badSecondJobs = secondJobs.filter(
    (job) => !new Set(["success", "skipped"]).has(job.conclusion),
  );
  check(
    "diagnostic-rerun-has-no-failed-or-cancelled-jobs",
    secondJobs.length > 0 && badSecondJobs.length === 0,
    badSecondJobs.length === 0
      ? `${secondJobs.length} jobs checked`
      : badSecondJobs.map((job) => `${job.name}: ${job.conclusion}`).join(", "),
  );
  const missingSuccessfulReruns = failedJobs.filter((failedJob) =>
    !secondJobs.some(
      (job) => job.name === failedJob.name && job.conclusion === "success",
    )
  );
  check(
    "every-original-failed-job-passed-on-rerun",
    failedJobs.length > 0 && missingSuccessfulReruns.length === 0,
    missingSuccessfulReruns.length === 0
      ? failedJobs.map((job) => job.name).join(", ")
      : missingSuccessfulReruns.map((job) => job.name).join(", "),
  );

  const records = Array.isArray(evidence) ? evidence : [];
  const evidenceTargets = records.map((record) => record.target).sort();
  check(
    "complete-native-overflow-evidence-set",
    JSON.stringify(evidenceTargets) === JSON.stringify([...TARGETS].sort()),
    evidenceTargets.length === 0 ? "none" : evidenceTargets.join(", "),
  );
  for (const target of TARGETS) {
    const record = records.find((candidate) => candidate.target === target);
    validateTargetEvidence({
      check,
      record,
      target,
      candidateSha,
      runId,
      scenario,
      scenarioAttempt,
    });
  }

  const failedChecks = checks.filter((candidate) => !candidate.passed);
  return {
    schemaVersion: 1,
    kind: "watchbound-automated-conditional-rerun-review",
    passed: failedChecks.length === 0,
    checks,
    issues: failedChecks.map(
      (candidate) => `${candidate.name}: ${candidate.details}`,
    ),
  };
}

function validateTargetEvidence({
  check,
  record,
  target,
  candidateSha,
  runId,
  scenario,
  scenarioAttempt,
}) {
  const preflight = record?.preflight;
  const report = record?.report;
  const result = Array.isArray(report?.results) ? report.results[0] : null;
  const resultChecks = Array.isArray(result?.result?.checks)
    ? result.result.checks
    : [];
  const summary = report?.summary;
  const expectedArchitecture = target === "linux-x64-gnu" ? "x64" : "arm64";
  const prefix = target;

  check(
    `${prefix}-preflight-approved`,
    preflight?.schemaVersion === 1 &&
      preflight?.kind === "watchbound-overflow-qualification-preflight" &&
      preflight?.decision?.passed === true &&
      Array.isArray(preflight?.decision?.errors) &&
      preflight.decision.errors.length === 0,
    preflight?.decision?.passed === true ? "passed" : "missing or failed",
  );
  check(
    `${prefix}-preflight-identity`,
    preflight?.source?.gitHead === candidateSha &&
      preflight?.qualification?.scenario === scenario &&
      preflight?.qualification?.attempt === scenarioAttempt &&
      preflight?.canonicalArtifact?.target === target &&
      preflight?.canonicalArtifact?.architecture === expectedArchitecture,
    `expected ${candidateSha}/${scenario}/${scenarioAttempt}/${target}`,
  );
  check(
    `${prefix}-runner-provenance`,
    String(preflight?.runner?.runId ?? "") === String(runId) &&
      String(preflight?.runner?.runAttempt ?? "") === "1",
    `run ${preflight?.runner?.runId ?? "missing"}, attempt ${preflight?.runner?.runAttempt ?? "missing"}`,
  );
  check(
    `${prefix}-strict-conformance-summary`,
    report?.schemaVersion === 2 &&
      report?.suite === "conformance" &&
      summary?.planned === 1 &&
      summary?.executed === 1 &&
      summary?.completed === 1 &&
      summary?.passed === 1 &&
      summary?.excluded === 0 &&
      summary?.nonconforming === 0 &&
      summary?.errors === 0 &&
      summary?.runtimeSkips === 0 &&
      summary?.cleanupErrors === 0 &&
      summary?.skipped === 0,
    summary === undefined ? "missing" : JSON.stringify(summary),
  );
  check(
    `${prefix}-conformance-identity`,
    report?.sourceIdentity?.gitHead === candidateSha &&
      report?.system?.architecture === expectedArchitecture &&
      JSON.stringify(report?.config?.adapters) === JSON.stringify(["watchbound"]) &&
      JSON.stringify(report?.config?.scenarios) === JSON.stringify([scenario]) &&
      report?.config?.runs === 1 &&
      report?.config?.allowForcedOverflow === true &&
      Array.isArray(report?.results) &&
      report.results.length === 1 &&
      result?.adapterId === "watchbound" &&
      result?.scenario === scenario &&
      result?.run === 1 &&
      result?.status === "completed" &&
      result?.outcome === "pass",
    `expected one passing ${scenario} Watchbound trial on ${expectedArchitecture}`,
  );
  check(
    `${prefix}-all-semantic-checks-passed`,
    resultChecks.length > 0 && resultChecks.every((candidate) => candidate.passed === true),
    resultChecks.length === 0
      ? "no semantic checks found"
      : resultChecks
        .filter((candidate) => candidate.passed !== true)
        .map((candidate) => candidate.name)
        .join(", ") || `${resultChecks.length} checks passed`,
  );
  check(
    `${prefix}-canonical-artifact-match`,
    typeof preflight?.canonicalArtifact?.sha256 === "string" &&
      preflight.canonicalArtifact.sha256.length === 64 &&
      result?.adapter?.nativeArtifact?.sha256 === preflight.canonicalArtifact.sha256,
    `preflight ${preflight?.canonicalArtifact?.sha256 ?? "missing"}; report ${result?.adapter?.nativeArtifact?.sha256 ?? "missing"}`,
  );
}

function hasTargetTimeoutSignature(log, target) {
  const emulator = target === "linux-x64-gnu"
    ? "qemu-system-x86_64"
    : target === "linux-arm64-gnu"
    ? "qemu-system-aarch64"
    : "qemu-system-arm";
  return new RegExp(
    `(?:${emulator}[\\s\\S]{0,500}ETIMEDOUT|ETIMEDOUT[\\s\\S]{0,500}${emulator})`,
    "u",
  ).test(log);
}

function kernelJobTarget(name) {
  for (const pattern of KERNEL_JOB_PATTERNS) {
    const target = pattern.exec(name ?? "")?.[1];
    if (target !== undefined) return target;
  }
  return null;
}

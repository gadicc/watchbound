const SCENARIO_ORDER = [
  "overflow-reconciliation",
  "automatic-overflow-reconciliation",
];
const SCENARIOS = new Set(SCENARIO_ORDER);
const QUALIFICATION_TARGETS = new Set([
  "linux-x64-gnu",
  "linux-arm64-gnu",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const OVERFLOW_ARTIFACT_PATTERN =
  /^watchbound-release-overflow-(linux-(?:x64|arm64)-gnu)-(.+)-attempt-([1-9][0-9]*)$/u;
const WORKFLOW_RERUN_ISSUE =
  "GitHub workflow rerun requires explicit conditional acceptance";

export class QualificationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "QualificationInputError";
  }
}

export function qualificationAcknowledgement(scenario, attempt) {
  validateScenario(scenario);
  const normalizedAttempt = normalizeAttempt(attempt);
  return `I ACKNOWLEDGE FORCED OVERFLOW ${scenario} ATTEMPT ${normalizedAttempt}`;
}

export function parseOverflowArtifactName(name) {
  const match = OVERFLOW_ARTIFACT_PATTERN.exec(name ?? "");
  if (!match || !SCENARIOS.has(match[2])) return null;
  return {
    target: match[1],
    scenario: match[2],
    attempt: Number(match[3]),
  };
}

export function identifyQualificationRun(
  run,
  { approvalRecord, artifactNames = [], automatedReview = null } = {},
) {
  const issues = [];
  const identityIssues = [];
  let identity = null;
  let identitySource = null;

  if (approvalRecord !== undefined && approvalRecord !== null) {
    const parsed = parseApprovalRecord(approvalRecord);
    identity = {
      candidateSha: parsed.candidateSha,
      scenario: parsed.scenario,
      attempt: parsed.attempt,
    };
    identitySource = "qualification-plan";
    if (parsed.workflowRunAttempt !== 1) {
      issues.push("qualification approval records a forbidden workflow rerun");
    }
  }

  const artifactIdentities = artifactNames
    .map(parseOverflowArtifactName)
    .filter((value) => value !== null);
  const uniqueArtifactIdentities = new Map(
    artifactIdentities.map(({ scenario, attempt }) => [
      `${scenario}:${attempt}`,
      { scenario, attempt },
    ]),
  );
  if (uniqueArtifactIdentities.size > 1) {
    const issue = "overflow artifacts disagree about scenario or attempt";
    issues.push(issue);
    identityIssues.push(issue);
  } else if (identity === null && uniqueArtifactIdentities.size === 1) {
    const [artifactIdentity] = uniqueArtifactIdentities.values();
    identity = {
      candidateSha: run.headSha,
      ...artifactIdentity,
    };
    identitySource = "overflow-artifact";
  } else if (identity !== null && uniqueArtifactIdentities.size === 1) {
    const [artifactIdentity] = uniqueArtifactIdentities.values();
    if (
      artifactIdentity.scenario !== identity.scenario ||
      artifactIdentity.attempt !== identity.attempt
    ) {
      const issue = "qualification plan and overflow artifacts disagree";
      issues.push(issue);
      identityIssues.push(issue);
    }
  }

  if (Number(run.attempt) !== 1) {
    issues.push(WORKFLOW_RERUN_ISSUE);
  }
  if (identity !== null && identity.candidateSha !== run.headSha) {
    const issue = "qualification approval candidate does not match the run head SHA";
    issues.push(issue);
    identityIssues.push(issue);
  }
  const artifactTargets = new Set(
    artifactIdentities
      .filter(
        (artifact) =>
          identity !== null &&
          artifact.scenario === identity.scenario &&
          artifact.attempt === identity.attempt,
      )
      .map((artifact) => artifact.target),
  );
  const missingArtifactTargets = [...QUALIFICATION_TARGETS].filter(
    (target) => !artifactTargets.has(target),
  );
  if (
    identity !== null &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    missingArtifactTargets.length > 0
  ) {
    issues.push(
      `successful run is missing retained overflow artifacts for: ${missingArtifactTargets.join(", ")}`,
    );
  }

  const identified = identity !== null && identityIssues.length === 0;
  const conditionalEligible =
    identified &&
    Number(run.attempt) === 2 &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    missingArtifactTargets.length === 0 &&
    issues.length === 1 &&
    issues[0] === WORKFLOW_RERUN_ISSUE;
  const conditionalSuccess =
    conditionalEligible && automatedReview?.passed === true;

  return {
    ...run,
    workflowAttempt: Number(run.attempt),
    scenario: identity?.scenario ?? null,
    scenarioAttempt: identity?.attempt ?? null,
    approvedCandidateSha: identity?.candidateSha ?? null,
    identitySource,
    artifactNames: [...artifactNames],
    artifactTargets: [...artifactTargets].sort(),
    artifactsComplete: missingArtifactTargets.length === 0,
    identified,
    identityIssues,
    issues,
    automatedReview,
    conditionalEligible,
    conditionalSuccess,
    valid: identified && issues.length === 0,
  };
}

export function createQualificationState({
  candidateSha,
  ref,
  remoteSha,
  localHead,
  dirty,
  runs,
}) {
  validateSha(candidateSha, "candidate SHA");
  validateSha(remoteSha, "remote ref SHA");
  validateSha(localHead, "local HEAD");
  const exactRuns = [...runs]
    .filter((run) => run.headSha === candidateSha)
    .sort(compareRuns);
  const identifiedRuns = exactRuns.filter((run) => run.identified);
  const recognizedRuns = exactRuns.filter((run) => run.valid);
  const conditionalRuns = identifiedRuns.filter((run) => run.conditionalSuccess);
  const inadmissibleRuns = identifiedRuns.filter(
    (run) => !run.valid && !run.conditionalSuccess,
  );
  const unidentifiedRuns = exactRuns.filter((run) => !run.identified);
  const scenarioRuns = Object.fromEntries(
    SCENARIO_ORDER.map((scenario) => [
      scenario,
      identifiedRuns.filter((run) => run.scenario === scenario),
    ]),
  );
  const state = {
    schemaVersion: 1,
    kind: "watchbound-release-qualification-state",
    candidateSha,
    ref,
    remoteSha,
    localHead,
    dirty: Boolean(dirty),
    candidateMatchesRemote: candidateSha === remoteSha,
    localMatchesCandidate: localHead === candidateSha,
    runs: exactRuns,
    identifiedRuns,
    recognizedRuns,
    conditionalRuns,
    inadmissibleRuns,
    unidentifiedRuns,
    scenarioRuns,
  };
  state.suggestions = qualificationSuggestions(state);
  state.readyForMaintainerReview = SCENARIO_ORDER.every((scenario) =>
    hasReviewableSuccessfulRun(scenarioRuns[scenario]),
  );
  return state;
}

export function selectActiveQualificationRun(state) {
  const activeRuns = state.runs.filter((run) => run.status !== "completed");
  if (activeRuns.length > 1) {
    throw new QualificationInputError(
      `multiple exact-candidate qualification runs are active (${activeRuns.map((run) => run.databaseId).join(", ")}); inspect them manually before continuing`,
    );
  }
  return activeRuns[0] ?? null;
}

export function planQualificationDispatch({
  state,
  scenario,
  attempt,
  reviewedRunId,
  acceptedRerunId,
}) {
  validateScenario(scenario);
  if (!state.candidateMatchesRemote) {
    throw new QualificationInputError(
      `candidate ${state.candidateSha} is not the current ${state.ref} SHA ${state.remoteSha}`,
    );
  }
  if (state.unidentifiedRuns.length > 0) {
    throw new QualificationInputError(
      "an exact-candidate run has not exposed a trustworthy scenario identity yet; wait or inspect it before dispatching",
    );
  }
  const existing = state.scenarioRuns[scenario];
  const expectedAttempt = existing.length === 0
    ? 1
    : Math.max(...existing.map((run) => run.scenarioAttempt)) + 1;
  const selectedAttempt = attempt === undefined
    ? expectedAttempt
    : normalizeAttempt(attempt);
  if (selectedAttempt !== expectedAttempt) {
    throw new QualificationInputError(
      `${scenario} must use attempt ${expectedAttempt}; requested ${selectedAttempt}`,
    );
  }
  if (
    existing.some(
      (run) => run.scenarioAttempt === selectedAttempt,
    )
  ) {
    throw new QualificationInputError(
      `${scenario} attempt ${selectedAttempt} already exists`,
    );
  }
  const active = state.identifiedRuns.find((run) => run.status !== "completed");
  if (active) {
    throw new QualificationInputError(
      `run ${active.databaseId} is still ${active.status}; do not overlap qualification dispatches`,
    );
  }

  let requiredReviewedRun = null;
  let requiredAcceptedRerun = null;
  if (selectedAttempt > 1) {
    const precedingRuns = existing.filter(
      (run) => run.scenarioAttempt === selectedAttempt - 1,
    );
    if (precedingRuns.length > 1) {
      throw new QualificationInputError(
        `scenario attempt ${selectedAttempt - 1} is ambiguous across multiple runs; inspect the duplicate dispatches manually`,
      );
    }
    requiredReviewedRun = precedingRuns[0] ?? null;
    if (!requiredReviewedRun || requiredReviewedRun.status !== "completed") {
      throw new QualificationInputError(
        `attempt ${selectedAttempt - 1} must complete and be reviewed before retrying`,
      );
    }
  } else if (scenario === "automatic-overflow-reconciliation") {
    const manualRuns = state.scenarioRuns["overflow-reconciliation"];
    const cleanSuccess = manualRuns.filter(isSuccessfulRun).at(-1) ?? null;
    const conditionalSuccess = manualRuns
      .filter(isConditionallySuccessfulRun)
      .at(-1) ?? null;
    requiredReviewedRun = cleanSuccess ?? conditionalSuccess;
    if (requiredReviewedRun?.conditionalSuccess) {
      requiredAcceptedRerun = requiredReviewedRun;
    }
    if (!requiredReviewedRun) {
      throw new QualificationInputError(
        "a clean or conditionally acceptable overflow-reconciliation run must be reviewed before the automatic scenario",
      );
    }
  }

  if (requiredReviewedRun !== null) {
    if (reviewedRunId === undefined) {
      throw new QualificationInputError(
        `pass --reviewed-run ${requiredReviewedRun.databaseId} to record explicit review of the prerequisite run`,
      );
    }
    const normalizedReviewedRunId = normalizeRunId(reviewedRunId);
    if (normalizedReviewedRunId !== Number(requiredReviewedRun.databaseId)) {
      throw new QualificationInputError(
        `pass --reviewed-run ${requiredReviewedRun.databaseId} to record explicit review of the prerequisite run`,
      );
    }
  } else if (reviewedRunId !== undefined) {
    throw new QualificationInputError(
      "--reviewed-run is not needed for the first scenario attempt",
    );
  }

  if (requiredAcceptedRerun !== null) {
    if (acceptedRerunId === undefined) {
      throw new QualificationInputError(
        `pass --accept-rerun ${requiredAcceptedRerun.databaseId} to confirm the passed automated infrastructure/environmental review`,
      );
    }
    const normalizedAcceptedRerunId = normalizeRunId(acceptedRerunId);
    if (normalizedAcceptedRerunId !== Number(requiredAcceptedRerun.databaseId)) {
      throw new QualificationInputError(
        `pass --accept-rerun ${requiredAcceptedRerun.databaseId} to accept the reviewed conditional pass`,
      );
    }
  } else if (acceptedRerunId !== undefined) {
    throw new QualificationInputError(
      "--accept-rerun is only valid when the prerequisite is a conditionally successful GitHub rerun",
    );
  }

  const acknowledgement = qualificationAcknowledgement(scenario, selectedAttempt);
  return {
    candidateSha: state.candidateSha,
    ref: state.ref,
    scenario,
    attempt: selectedAttempt,
    acknowledgement,
    reviewedRunId: requiredReviewedRun?.databaseId ?? null,
    acceptedRerunId: requiredAcceptedRerun?.databaseId ?? null,
    args: [
      "workflow",
      "run",
      "release.yml",
      "--ref",
      state.ref,
      "-f",
      `candidate_sha=${state.candidateSha}`,
      "-f",
      `scenario=${scenario}`,
      "-f",
      `attempt=${selectedAttempt}`,
      "-f",
      `acknowledgement=${acknowledgement}`,
    ],
  };
}

export function formatQualificationReport(state) {
  const lines = [
    "Watchbound supervised release qualification",
    `Candidate: ${state.candidateSha}`,
    `Remote ${state.ref}: ${state.remoteSha}${state.candidateMatchesRemote ? " (match)" : " (DIFFERENT)"}`,
    `Local HEAD: ${state.localHead}${state.localMatchesCandidate ? " (match)" : " (different)"}`,
    `Worktree: ${state.dirty ? "dirty (remote qualification remains exact)" : "clean"}`,
    "",
    "Discovered runs:",
  ];
  if (state.runs.length === 0) {
    lines.push("  none for this exact candidate");
  } else {
    for (const run of state.runs) {
      const identity = run.scenario === null
        ? "identity pending"
        : `${run.scenario} attempt ${run.scenarioAttempt}`;
      const result = run.status === "completed"
        ? run.conclusion
        : run.status;
      const marker = run.valid
        ? "✓"
        : run.conditionalSuccess
          ? "~"
          : run.identified
            ? "×"
            : "!";
      const workflowAttempt = run.workflowAttempt === 1
        ? ""
        : `; GitHub workflow attempt ${run.workflowAttempt}`;
      lines.push(`  ${marker} ${run.databaseId}: ${identity} — ${result}${workflowAttempt}`);
      lines.push(`    ${run.url}`);
      if (run.artifactTargets.length > 0) {
        lines.push(`    retained targets: ${run.artifactTargets.join(", ")}`);
      }
      if (run.automatedReview !== null) {
        const review = run.automatedReview;
        lines.push(
          `    automated conditional review: ${review.passed ? "PASSED" : "FAILED"} (${review.checks.filter((check) => check.passed).length}/${review.checks.length} checks)`,
        );
        for (const issue of review.issues) {
          lines.push(`    review issue: ${issue}`);
        }
      }
      for (const issue of run.issues) lines.push(`    warning: ${issue}`);
    }
  }
  lines.push("", "Suggested next steps:");
  for (const suggestion of state.suggestions) {
    lines.push(`  ${suggestion.message}`);
    if (suggestion.command) lines.push(`  ${suggestion.command}`);
    for (const command of suggestion.commands ?? []) lines.push(`  ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

function qualificationSuggestions(state) {
  if (!state.candidateMatchesRemote) {
    return [{
      message: "The selected candidate is no longer the remote ref tip. Inspect only; do not dispatch it with this ref.",
    }];
  }
  const activeUnknown = state.unidentifiedRuns.find(
    (run) => run.status !== "completed",
  );
  if (activeUnknown) {
    return [{
      message: `Wait for run ${activeUnknown.databaseId} to upload its qualification plan, then reload status.`,
      command: watchCommand(activeUnknown),
    }];
  }
  if (state.unidentifiedRuns.length > 0) {
    return [{
      message: "Inspect the unidentified exact-candidate run before authorizing another dispatch.",
      command: `gh run view ${state.unidentifiedRuns.at(-1).databaseId}`,
    }];
  }

  const manual = state.scenarioRuns["overflow-reconciliation"];
  const automatic = state.scenarioRuns["automatic-overflow-reconciliation"];
  const manualActive = manual.find((run) => run.status !== "completed");
  if (manualActive) return [waitSuggestion(manualActive)];
  const manualCleanSuccess = manual.filter(isSuccessfulRun).at(-1) ?? null;
  const manualConditionalSuccess = manual
    .filter(isConditionallySuccessfulRun)
    .at(-1) ?? null;
  const manualSuccess = manualCleanSuccess ?? manualConditionalSuccess;
  if (!manualSuccess) {
    const latest = manual.at(-1) ?? null;
    if (latest) return retrySuggestions(latest);
    return [{
      message: "Dispatch the first, read-only overflow-reconciliation gate.",
      command: dispatchCommand("overflow-reconciliation", 1),
    }];
  }

  const automaticActive = automatic.find((run) => run.status !== "completed");
  if (automaticActive) return [waitSuggestion(automaticActive)];
  const automaticCleanSuccess = automatic.filter(isSuccessfulRun).at(-1) ?? null;
  const automaticConditionalSuccess = automatic
    .filter(isConditionallySuccessfulRun)
    .at(-1) ?? null;
  const automaticSuccess = automaticCleanSuccess ?? automaticConditionalSuccess;
  if (!automaticSuccess) {
    const latest = automatic.at(-1) ?? null;
    if (latest) return retrySuggestions(latest);
    if (manualSuccess.conditionalSuccess) {
      return conditionalContinuationSuggestions(manualSuccess);
    }
    return [{
      message: `Review run ${manualSuccess.databaseId} and both native artifacts, then explicitly authorize the automatic scenario.`,
      commands: [
        `gh run view ${manualSuccess.databaseId}`,
        artifactDownloadCommand(manualSuccess.databaseId),
        dispatchCommand(
          "automatic-overflow-reconciliation",
          1,
          manualSuccess.databaseId,
        ),
      ],
    }];
  }
  const conditionalRuns = [manualSuccess, automaticSuccess].filter(
    isConditionallySuccessfulRun,
  );
  const conditionalNote = conditionalRuns.length === 0
    ? ""
    : ` Conditional pass${conditionalRuns.length === 1 ? "" : "es"} ${conditionalRuns.map((run) => run.databaseId).join(", ")} require final confirmation that the first-attempt failures were infrastructure or environmental.`;
  const conditionalReviewCommands = conditionalRuns.flatMap((run) => [
    `gh run view ${run.databaseId} --attempt 1 --log-failed`,
    `gh run view ${run.databaseId} --attempt 2`,
  ]);
  return [{
    message: `Both scenarios have reviewable exact-candidate evidence (${manualSuccess.databaseId}, ${automaticSuccess.databaseId}).${conditionalNote} Review retained evidence and make the final maintainer release decision; dispatch no further qualification runs.`,
    commands: [
      ...conditionalReviewCommands,
      artifactDownloadCommand(manualSuccess.databaseId),
      artifactDownloadCommand(automaticSuccess.databaseId),
    ],
  }];
}

function conditionalContinuationSuggestions(run) {
  return [
    {
      message: `1. Automated fail-closed review passed all ${run.automatedReview.checks.length} checks: original failures were limited to target-specific QEMU timeouts, rerun jobs passed, and both native conformance artifacts are internally consistent.`,
    },
    {
      message: "2. Choose exactly one path below; do not run both dispatch commands.",
    },
    {
      message: "2A — Accept the automated infrastructure/environmental conditional pass and continue to the automatic scenario.",
      command: dispatchCommand(
        "automatic-overflow-reconciliation",
        1,
        run.databaseId,
        run.databaseId,
      ),
    },
    {
      message: "2B — For extra conservatism, require a clean new manual-scenario attempt instead.",
      command: dispatchCommand(
        run.scenario,
        run.scenarioAttempt + 1,
        run.databaseId,
      ),
    },
  ];
}

function waitSuggestion(run) {
  return {
    message: `Run ${run.databaseId} is ${run.status}; do not dispatch an overlapping gate.`,
    command: watchCommand(run),
  };
}

function watchCommand(run) {
  return `pnpm release:qualify -- watch --candidate-sha ${run.headSha}`;
}

function retrySuggestions(run) {
  const nextAttempt = run.scenarioAttempt + 1;
  const canRerunFailedJobsForDiagnosis =
    run.valid && run.workflowAttempt === 1 && run.conclusion === "failure";
  const outcome = run.valid
    ? `concluded ${run.conclusion}`
    : `is identified but inadmissible (${run.issues.join("; ")})`;
  const suggestions = [];
  if (run.workflowAttempt > 1) {
    suggestions.push(
      {
        message: `1. Run ${run.databaseId} ${outcome}. Review the original failed attempt first.`,
        command: `gh run view ${run.databaseId} --attempt 1 --log-failed`,
      },
      {
        message: `2. Review the latest workflow attempt (${run.workflowAttempt}).`,
        command: `gh run view ${run.databaseId} --attempt ${run.workflowAttempt} --verbose`,
      },
    );
  } else {
    suggestions.push({
      message: `1. Run ${run.databaseId} ${outcome}. Review and classify its failure before choosing a retry path.`,
      command: run.conclusion === "failure"
        ? `gh run view ${run.databaseId} --log-failed`
        : `gh run view ${run.databaseId} --verbose`,
    });
  }
  if (run.artifactTargets.length > 0) {
    suggestions.push({
      message: `${suggestions.length + 1}. Download and inspect every retained native overflow artifact.`,
      command: artifactDownloadCommand(run.databaseId),
    });
  }
  if (canRerunFailedJobsForDiagnosis) {
    suggestions.push(
      {
        message: "Option A — If more evidence is needed, rerun failed jobs for diagnosis only. Wait for it to finish, then run `pnpm release:qualify` again; do not dispatch the fresh attempt now.",
        command: `gh run rerun ${run.databaseId} --failed`,
      },
      {
        message: "Option B — If the failure is already classified, skip the diagnostic rerun and dispatch a fresh scenario attempt.",
        command: dispatchCommand(run.scenario, nextAttempt, run.databaseId),
      },
    );
  } else {
    suggestions.push({
      message: "After review, dispatch a clean new scenario attempt; do not rerun this GitHub workflow again.",
      command: dispatchCommand(run.scenario, nextAttempt, run.databaseId),
    });
  }
  return suggestions;
}

function artifactDownloadCommand(runId) {
  return `gh run download ${runId} --pattern 'watchbound-release-overflow-*' --dir dist/qualification-run-${runId}`;
}

function dispatchCommand(scenario, attempt, reviewedRunId, acceptedRerunId) {
  const reviewed = reviewedRunId === undefined
    ? ""
    : ` --reviewed-run ${reviewedRunId}`;
  const accepted = acceptedRerunId === undefined
    ? ""
    : ` --accept-rerun ${acceptedRerunId}`;
  return `pnpm release:qualify -- dispatch --scenario ${scenario} --attempt ${attempt}${reviewed}${accepted}`;
}

function parseApprovalRecord(record) {
  if (
    record?.schemaVersion !== 1 ||
    record.kind !== "watchbound-overflow-dispatch-approval"
  ) {
    throw new QualificationInputError("invalid qualification approval record");
  }
  validateSha(record.candidateSha, "approval candidate SHA");
  validateScenario(record.scenario);
  const attempt = normalizeAttempt(record.attempt);
  if (
    record.acknowledgement !==
    qualificationAcknowledgement(record.scenario, attempt)
  ) {
    throw new QualificationInputError(
      "qualification approval acknowledgement does not match its scenario and attempt",
    );
  }
  return {
    candidateSha: record.candidateSha,
    scenario: record.scenario,
    attempt,
    workflowRunAttempt: normalizeAttempt(record.workflowRunAttempt),
  };
}

function validateSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) {
    throw new QualificationInputError(`${label} must be a lowercase 40-character SHA`);
  }
}

function validateScenario(scenario) {
  if (!SCENARIOS.has(scenario)) {
    throw new QualificationInputError(
      `scenario must be one of: ${SCENARIO_ORDER.join(", ")}`,
    );
  }
}

function normalizeAttempt(attempt) {
  const value = String(attempt ?? "");
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new QualificationInputError("attempt must be a positive integer");
  }
  return Number(value);
}

function normalizeRunId(runId) {
  const value = String(runId ?? "");
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new QualificationInputError("--reviewed-run must be a positive GitHub run ID");
  }
  return Number(value);
}

function compareRuns(left, right) {
  const created = String(left.createdAt).localeCompare(String(right.createdAt));
  if (created !== 0) return created;
  return Number(left.databaseId) - Number(right.databaseId);
}

function isSuccessfulRun(run) {
  return run.valid && run.status === "completed" && run.conclusion === "success";
}

function isConditionallySuccessfulRun(run) {
  return run.conditionalSuccess === true;
}

function hasReviewableSuccessfulRun(runs) {
  return runs.some(
    (run) => isSuccessfulRun(run) || isConditionallySuccessfulRun(run),
  );
}

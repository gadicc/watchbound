import assert from "node:assert/strict";
import test from "node:test";
import {
  QualificationInputError,
  createQualificationState,
  formatQualificationReport,
  identifyQualificationRun,
  parseOverflowArtifactName,
  planQualificationDispatch,
  qualificationAcknowledgement,
  selectActiveQualificationRun,
} from "../../scripts/lib/release-qualification.mjs";
import {
  reviewConditionalRerun,
} from "../../scripts/lib/release-qualification-review.mjs";

const CANDIDATE = "a".repeat(40);
const OTHER = "b".repeat(40);

test("overflow artifact names recover scenario identity without local state", () => {
  assert.deepEqual(
    parseOverflowArtifactName(
      "watchbound-release-overflow-linux-arm64-gnu-overflow-reconciliation-attempt-2",
    ),
    {
      target: "linux-arm64-gnu",
      scenario: "overflow-reconciliation",
      attempt: 2,
    },
  );
  assert.equal(parseOverflowArtifactName("watchbound-qualification-plan"), null);
});

test("an empty session recommends the exact first guarded dispatch", () => {
  const state = makeState([]);
  assert.equal(state.readyForMaintainerReview, false);
  assert.match(
    state.suggestions[0].command,
    /dispatch --scenario overflow-reconciliation --attempt 1$/u,
  );
  const dispatch = planQualificationDispatch({
    state,
    scenario: "overflow-reconciliation",
    attempt: 1,
  });
  assert.equal(dispatch.reviewedRunId, null);
  assert.deepEqual(dispatch.args.slice(0, 6), [
    "workflow",
    "run",
    "release.yml",
    "--ref",
    "dev",
    "-f",
  ]);
  assert.ok(dispatch.args.includes(`candidate_sha=${CANDIDATE}`));
  assert.ok(
    dispatch.args.includes(
      "acknowledgement=I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    ),
  );
});

test("a half-complete session discovers the first run and requires its review", () => {
  const manual = qualificationRun({
    id: 101,
    scenario: "overflow-reconciliation",
    conclusion: "success",
  });
  const state = makeState([manual]);
  assert.match(state.suggestions[0].message, /Review run 101/u);
  assert.match(state.suggestions[0].commands.at(-1), /--reviewed-run 101$/u);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "automatic-overflow-reconciliation",
      attempt: 1,
    }),
    (error) =>
      error instanceof QualificationInputError &&
      /--reviewed-run 101/u.test(error.message),
  );
  const dispatch = planQualificationDispatch({
    state,
    scenario: "automatic-overflow-reconciliation",
    attempt: 1,
    reviewedRunId: 101,
  });
  assert.equal(dispatch.reviewedRunId, 101);
  assert.equal(
    dispatch.acknowledgement,
    "I ACKNOWLEDGE FORCED OVERFLOW automatic-overflow-reconciliation ATTEMPT 1",
  );
});

test("active unidentified runs block a duplicate while artifacts are pending", () => {
  const unknown = identifyQualificationRun(rawRun({
    id: 102,
    status: "in_progress",
    conclusion: "",
  }));
  const state = makeState([unknown]);
  assert.match(state.suggestions[0].message, /Wait for run 102/u);
  assert.match(
    state.suggestions[0].command,
    /release:qualify -- watch --candidate-sha a{40}$/u,
  );
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 1,
    }),
    /has not exposed a trustworthy scenario identity/u,
  );
});

test("failed attempts require review and a new numbered dispatch", () => {
  const failed = qualificationRun({
    id: 103,
    scenario: "overflow-reconciliation",
    conclusion: "failure",
  });
  const state = makeState([failed]);
  assert.match(state.suggestions[0].command, /--log-failed$/u);
  assert.match(state.suggestions[1].message, /more evidence is needed/u);
  assert.equal(state.suggestions[1].command, "gh run rerun 103 --failed");
  assert.match(state.suggestions[2].message, /already classified/u);
  assert.match(
    state.suggestions[2].command,
    /--attempt 2 --reviewed-run 103$/u,
  );
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 2,
    }),
    /--reviewed-run 103/u,
  );
  const retry = planQualificationDispatch({
    state,
    scenario: "overflow-reconciliation",
    attempt: 2,
    reviewedRunId: "103",
  });
  assert.equal(retry.attempt, 2);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 3,
      reviewedRunId: 103,
    }),
    /must use attempt 2/u,
  );
});

test("the automatic scenario cannot start before a successful manual gate", () => {
  const state = makeState([]);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "automatic-overflow-reconciliation",
      attempt: 1,
    }),
    /overflow-reconciliation run must be reviewed/u,
  );
});

test("overlapping workflows fail closed", () => {
  const active = qualificationRun({
    id: 104,
    scenario: "overflow-reconciliation",
    status: "in_progress",
    conclusion: "",
  });
  const activeState = makeState([active]);
  assert.equal(selectActiveQualificationRun(activeState), active);
  assert.match(
    activeState.suggestions[0].command,
    /release:qualify -- watch --candidate-sha a{40}$/u,
  );
  assert.throws(
    () => planQualificationDispatch({
      state: activeState,
      scenario: "overflow-reconciliation",
      attempt: 2,
      reviewedRunId: 104,
    }),
    /still in_progress/u,
  );
});

test("watch selection is recoverable and fails closed on overlapping runs", () => {
  assert.equal(selectActiveQualificationRun(makeState([])), null);
  const first = qualificationRun({
    id: 118,
    scenario: "overflow-reconciliation",
    status: "in_progress",
    conclusion: "",
  });
  const second = qualificationRun({
    id: 119,
    scenario: "automatic-overflow-reconciliation",
    status: "queued",
    conclusion: "",
    createdAt: "2026-08-02T02:00:00Z",
  });
  assert.throws(
    () => selectActiveQualificationRun(makeState([first, second])),
    /multiple exact-candidate qualification runs are active \(118, 119\)/u,
  );
});

test("one green GitHub rerun offers conditional acceptance or a fresh attempt", () => {
  const rerun = qualificationRun({
    id: 105,
    scenario: "overflow-reconciliation",
    conclusion: "success",
    workflowAttempt: 2,
  });
  assert.equal(rerun.identified, true);
  assert.equal(rerun.valid, false);
  assert.equal(rerun.conditionalSuccess, true);
  assert.ok(
    rerun.issues.includes(
      "GitHub workflow rerun requires explicit conditional acceptance",
    ),
  );
  const rerunState = makeState([rerun]);
  assert.equal(rerunState.readyForMaintainerReview, false);
  assert.deepEqual(rerunState.unidentifiedRuns, []);
  assert.deepEqual(rerunState.conditionalRuns, [rerun]);
  assert.deepEqual(rerunState.inadmissibleRuns, []);
  assert.match(
    rerunState.suggestions[0].message,
    /Automated fail-closed review passed all 1 checks/u,
  );
  assert.match(
    rerunState.suggestions[1].message,
    /Choose exactly one path/u,
  );
  assert.match(
    rerunState.suggestions[2].command,
    /automatic-overflow-reconciliation --attempt 1 --reviewed-run 105 --accept-rerun 105$/u,
  );
  assert.match(
    rerunState.suggestions[3].command,
    /overflow-reconciliation --attempt 2 --reviewed-run 105$/u,
  );
  const report = formatQualificationReport(rerunState);
  const reviewSteps = [
    "1. Automated fail-closed review",
    "2. Choose exactly one path",
    "2A — Accept",
    "2B — For extra conservatism",
  ];
  let previousIndex = -1;
  for (const step of reviewSteps) {
    const index = report.indexOf(step);
    assert.ok(index > previousIndex, `${step} should follow the prior review step`);
    previousIndex = index;
  }
  assert.throws(
    () => planQualificationDispatch({
      state: rerunState,
      scenario: "automatic-overflow-reconciliation",
      attempt: 1,
    }),
    /--reviewed-run 105/u,
  );
  assert.throws(
    () => planQualificationDispatch({
      state: rerunState,
      scenario: "automatic-overflow-reconciliation",
      attempt: 1,
      reviewedRunId: 105,
    }),
    /--accept-rerun 105/u,
  );
  const accepted = planQualificationDispatch({
    state: rerunState,
    scenario: "automatic-overflow-reconciliation",
    attempt: 1,
    reviewedRunId: 105,
    acceptedRerunId: 105,
  });
  assert.equal(accepted.reviewedRunId, 105);
  assert.equal(accepted.acceptedRerunId, 105);

  const retry = planQualificationDispatch({
    state: rerunState,
    scenario: "overflow-reconciliation",
    attempt: 2,
    reviewedRunId: 105,
  });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.reviewedRunId, 105);
  assert.equal(retry.acceptedRerunId, null);
  assert.throws(
    () => planQualificationDispatch({
      state: rerunState,
      scenario: "overflow-reconciliation",
      attempt: 2,
      reviewedRunId: 105,
      acceptedRerunId: 105,
    }),
    /only valid when the prerequisite is a conditionally successful/u,
  );
});

test("an active diagnostic rerun blocks a fresh dispatch until it completes", () => {
  const diagnostic = qualificationRun({
    id: 113,
    scenario: "overflow-reconciliation",
    status: "in_progress",
    conclusion: "",
    workflowAttempt: 2,
  });
  const state = makeState([diagnostic]);
  assert.equal(diagnostic.identified, true);
  assert.equal(diagnostic.valid, false);
  assert.equal(diagnostic.conditionalSuccess, false);
  assert.deepEqual(state.unidentifiedRuns, []);
  assert.match(state.suggestions[0].message, /is in_progress/u);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 2,
      reviewedRunId: 113,
    }),
    /still in_progress/u,
  );
});

test("conflicting run identity remains unidentified and blocks recovery", () => {
  const ambiguous = identifyQualificationRun(rawRun({ id: 110 }), {
    approvalRecord: {
      schemaVersion: 1,
      kind: "watchbound-overflow-dispatch-approval",
      candidateSha: CANDIDATE,
      scenario: "overflow-reconciliation",
      attempt: 1,
      workflowRunAttempt: 1,
      acknowledgement:
        "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    },
    artifactNames: artifactNames("automatic-overflow-reconciliation", 1),
  });
  assert.equal(ambiguous.identified, false);
  assert.equal(ambiguous.valid, false);
  assert.match(ambiguous.identityIssues[0], /plan and overflow artifacts disagree/u);
  const state = makeState([ambiguous]);
  assert.deepEqual(state.inadmissibleRuns, []);
  assert.deepEqual(state.unidentifiedRuns, [ambiguous]);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 2,
      reviewedRunId: 110,
    }),
    /trustworthy scenario identity/u,
  );
});

test("duplicate preceding scenario attempts are too ambiguous to review by one run ID", () => {
  const state = makeState([
    qualificationRun({
      id: 111,
      scenario: "overflow-reconciliation",
      conclusion: "failure",
    }),
    qualificationRun({
      id: 112,
      scenario: "overflow-reconciliation",
      conclusion: "failure",
      createdAt: "2026-08-02T01:30:00Z",
    }),
  ]);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 2,
      reviewedRunId: 112,
    }),
    /ambiguous across multiple runs/u,
  );
});

test("successful independent scenarios make the candidate review-ready", () => {
  const state = makeState([
    qualificationRun({
      id: 106,
      scenario: "overflow-reconciliation",
      conclusion: "success",
    }),
    qualificationRun({
      id: 107,
      scenario: "automatic-overflow-reconciliation",
      conclusion: "success",
      createdAt: "2026-08-02T02:00:00Z",
    }),
  ]);
  assert.equal(state.readyForMaintainerReview, true);
  assert.match(state.suggestions[0].message, /Both scenarios/u);
  assert.equal(state.suggestions[0].command, undefined);
  assert.equal(state.suggestions[0].commands.length, 2);
});

test("conditional and clean scenario evidence reaches final maintainer review", () => {
  const conditional = qualificationRun({
    id: 114,
    scenario: "overflow-reconciliation",
    conclusion: "success",
    workflowAttempt: 2,
  });
  const state = makeState([
    conditional,
    qualificationRun({
      id: 115,
      scenario: "automatic-overflow-reconciliation",
      conclusion: "success",
      createdAt: "2026-08-02T02:00:00Z",
    }),
  ]);
  assert.equal(state.readyForMaintainerReview, true);
  assert.match(state.suggestions[0].message, /Conditional pass 114/u);
  assert.match(state.suggestions[0].message, /final confirmation/u);
});

test("only one green rerun with complete artifacts is conditionally acceptable", () => {
  const thirdWorkflowAttempt = qualificationRun({
    id: 116,
    scenario: "overflow-reconciliation",
    conclusion: "success",
    workflowAttempt: 3,
  });
  assert.equal(thirdWorkflowAttempt.conditionalSuccess, false);

  const missingArtifact = identifyQualificationRun(rawRun({
    id: 117,
    workflowAttempt: 2,
  }), {
    approvalRecord: {
      schemaVersion: 1,
      kind: "watchbound-overflow-dispatch-approval",
      candidateSha: CANDIDATE,
      scenario: "overflow-reconciliation",
      attempt: 1,
      workflowRunAttempt: 1,
      acknowledgement:
        "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    },
    artifactNames: [
      "watchbound-release-overflow-linux-x64-gnu-overflow-reconciliation-attempt-1",
    ],
  });
  assert.equal(missingArtifact.conditionalSuccess, false);
});

test("automated rerun review accepts only known QEMU timeouts and complete evidence", () => {
  const review = reviewConditionalRerun(automatedReviewInput());
  assert.equal(review.passed, true);
  assert.equal(review.issues.length, 0);
  assert.ok(review.checks.length >= 20);
  assert.equal(review.checks.every((check) => check.passed), true);
});

test("automated rerun review fails closed on semantic logs or incomplete evidence", () => {
  const semantic = automatedReviewInput();
  semantic.failedLog += "\nAssertionError: semantic mismatch\n";
  const semanticReview = reviewConditionalRerun(semantic);
  assert.equal(semanticReview.passed, false);
  assert.ok(
    semanticReview.issues.some((issue) =>
      issue.startsWith("original-logs-have-no-semantic-failure-signature:")
    ),
  );

  const incomplete = automatedReviewInput();
  incomplete.evidence.pop();
  const incompleteReview = reviewConditionalRerun(incomplete);
  assert.equal(incompleteReview.passed, false);
  assert.ok(
    incompleteReview.issues.some((issue) =>
      issue.startsWith("complete-native-overflow-evidence-set:")
    ),
  );

  const wrongProvenance = automatedReviewInput();
  wrongProvenance.evidence[0].preflight.runner.runAttempt = "2";
  const wrongProvenanceReview = reviewConditionalRerun(wrongProvenance);
  assert.equal(wrongProvenanceReview.passed, false);
  assert.ok(
    wrongProvenanceReview.issues.some((issue) =>
      issue.startsWith("linux-x64-gnu-runner-provenance:")
    ),
  );
});

test("approval records cannot claim a different candidate", () => {
  const run = identifyQualificationRun(rawRun({ id: 108 }), {
    approvalRecord: {
      schemaVersion: 1,
      kind: "watchbound-overflow-dispatch-approval",
      candidateSha: OTHER,
      scenario: "overflow-reconciliation",
      attempt: 1,
      workflowRunAttempt: 1,
      acknowledgement:
        "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    },
    artifactNames: artifactNames("overflow-reconciliation", 1),
  });
  assert.equal(run.identified, false);
  assert.equal(run.valid, false);
  assert.ok(
    run.issues.includes(
      "qualification approval candidate does not match the run head SHA",
    ),
  );
});

test("a green run requires retained overflow evidence from both targets", () => {
  const run = identifyQualificationRun(rawRun({ id: 109 }), {
    approvalRecord: {
      schemaVersion: 1,
      kind: "watchbound-overflow-dispatch-approval",
      candidateSha: CANDIDATE,
      scenario: "overflow-reconciliation",
      attempt: 1,
      workflowRunAttempt: 1,
      acknowledgement:
        "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    },
    artifactNames: [
      "watchbound-release-overflow-linux-x64-gnu-overflow-reconciliation-attempt-1",
    ],
  });
  assert.equal(run.valid, false);
  assert.deepEqual(run.artifactTargets, ["linux-x64-gnu"]);
  assert.match(run.issues[0], /linux-arm64-gnu/u);
});

test("stale refs can be inspected but never dispatched", () => {
  const state = makeState([], { remoteSha: OTHER });
  assert.equal(state.candidateMatchesRemote, false);
  assert.throws(
    () => planQualificationDispatch({
      state,
      scenario: "overflow-reconciliation",
      attempt: 1,
    }),
    /is not the current dev SHA/u,
  );
});

test("acknowledgements reject unsupported scenarios and invalid attempts", () => {
  assert.throws(
    () => qualificationAcknowledgement("not-a-scenario", 1),
    /scenario must be one of/u,
  );
  assert.throws(
    () => qualificationAcknowledgement("overflow-reconciliation", 0),
    /positive integer/u,
  );
});

function makeState(runs, overrides = {}) {
  return createQualificationState({
    candidateSha: CANDIDATE,
    ref: "dev",
    remoteSha: CANDIDATE,
    localHead: CANDIDATE,
    dirty: false,
    runs,
    ...overrides,
  });
}

function qualificationRun({
  id,
  scenario,
  conclusion,
  status = "completed",
  scenarioAttempt = 1,
  workflowAttempt = 1,
  createdAt = "2026-08-02T01:00:00Z",
}) {
  return identifyQualificationRun(
    rawRun({
      id,
      status,
      conclusion,
      workflowAttempt,
      createdAt,
    }),
    {
      approvalRecord: {
        schemaVersion: 1,
        kind: "watchbound-overflow-dispatch-approval",
        candidateSha: CANDIDATE,
        scenario,
        attempt: scenarioAttempt,
        workflowRunAttempt: 1,
        acknowledgement: qualificationAcknowledgement(scenario, scenarioAttempt),
      },
      artifactNames: status === "completed" && conclusion === "success"
        ? artifactNames(scenario, scenarioAttempt)
        : [],
      automatedReview:
        workflowAttempt === 2 && status === "completed" && conclusion === "success"
          ? passingAutomatedReview()
          : null,
    },
  );
}

function passingAutomatedReview() {
  return {
    schemaVersion: 1,
    kind: "watchbound-automated-conditional-rerun-review",
    passed: true,
    checks: [{ name: "fixture-review", passed: true, details: "passed" }],
    issues: [],
  };
}

function automatedReviewInput() {
  const targets = ["linux-x64-gnu", "linux-arm64-gnu"];
  const failedJobs = [
    {
      name: "Release kernel 5.15 (linux-arm64-gnu, QEMU component)",
      step: "Exercise the canonical package on a real pinned 5.15 kernel",
    },
    {
      name: "Qualify exact release source / Kernel 5.15 (linux-arm64-gnu, QEMU component)",
      step: "Exercise the exact package on a real pinned 5.15 kernel",
    },
  ].map(({ name, step }) => ({
    name,
    conclusion: "failure",
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: step, conclusion: "failure" },
    ],
  }));
  return {
    candidateSha: CANDIDATE,
    runId: 105,
    scenario: "overflow-reconciliation",
    scenarioAttempt: 1,
    workflowAttempt: 2,
    attemptOne: {
      attempt: 1,
      status: "completed",
      conclusion: "failure",
      jobs: [
        { name: "Tests", conclusion: "success", steps: [] },
        ...failedJobs,
        { name: "Manual qualification verified", conclusion: "skipped", steps: [] },
      ],
    },
    attemptTwo: {
      attempt: 2,
      status: "completed",
      conclusion: "success",
      jobs: [
        ...failedJobs.map((job) => ({
          ...job,
          conclusion: "success",
          steps: job.steps.map((step) => ({ ...step, conclusion: "success" })),
        })),
        { name: "Manual qualification verified", conclusion: "success", steps: [] },
      ],
    },
    failedLog: [
      "Error: spawnSync /usr/bin/qemu-system-aarch64 ETIMEDOUT",
    ].join("\n"),
    evidence: targets.map((target, index) =>
      automatedEvidence(target, String(index + 1).repeat(64))
    ),
  };
}

function automatedEvidence(target, sha256) {
  const architecture = target === "linux-x64-gnu" ? "x64" : "arm64";
  return {
    target,
    preflight: {
      schemaVersion: 1,
      kind: "watchbound-overflow-qualification-preflight",
      source: { gitHead: CANDIDATE },
      qualification: { scenario: "overflow-reconciliation", attempt: 1 },
      canonicalArtifact: { target, architecture, sha256 },
      runner: { runId: "105", runAttempt: "1" },
      decision: { passed: true, errors: [] },
    },
    report: {
      schemaVersion: 2,
      suite: "conformance",
      sourceIdentity: { gitHead: CANDIDATE },
      system: { architecture },
      config: {
        adapters: ["watchbound"],
        scenarios: ["overflow-reconciliation"],
        runs: 1,
        allowForcedOverflow: true,
      },
      summary: {
        planned: 1,
        executed: 1,
        excluded: 0,
        completed: 1,
        passed: 1,
        nonconforming: 0,
        errors: 0,
        runtimeSkips: 0,
        cleanupErrors: 0,
        skipped: 0,
      },
      results: [{
        adapterId: "watchbound",
        adapter: { nativeArtifact: { sha256 } },
        scenario: "overflow-reconciliation",
        run: 1,
        status: "completed",
        outcome: "pass",
        result: { checks: [{ name: "semantic-contract", passed: true }] },
      }],
    },
  };
}

function artifactNames(scenario, attempt) {
  return ["linux-x64-gnu", "linux-arm64-gnu"].map(
    (target) =>
      `watchbound-release-overflow-${target}-${scenario}-attempt-${attempt}`,
  );
}

function rawRun({
  id,
  status = "completed",
  conclusion = "success",
  workflowAttempt = 1,
  createdAt = "2026-08-02T01:00:00Z",
}) {
  return {
    attempt: workflowAttempt,
    conclusion,
    createdAt,
    databaseId: id,
    displayTitle: "Release",
    event: "workflow_dispatch",
    headBranch: "dev",
    headSha: CANDIDATE,
    status,
    updatedAt: createdAt,
    url: `https://github.com/gadicc/watchbound/actions/runs/${id}`,
    workflowName: "Release",
  };
}

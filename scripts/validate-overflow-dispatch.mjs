import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const allowedScenarios = new Set([
  "overflow-reconciliation",
  "automatic-overflow-reconciliation",
]);

export function validateOverflowDispatch({
  candidateSha,
  workflowSha,
  checkedOutSha,
  scenario,
  attempt,
  runAttempt,
  acknowledgement,
}) {
  assert.match(
    candidateSha ?? "",
    /^[0-9a-f]{40}$/u,
    "candidate SHA must be an exact lowercase 40-character commit SHA",
  );
  assert.equal(
    workflowSha,
    candidateSha,
    "workflow ref does not identify the approved candidate SHA",
  );
  assert.equal(
    checkedOutSha,
    candidateSha,
    "checked-out candidate does not match the approved candidate SHA",
  );
  assert.ok(
    allowedScenarios.has(scenario),
    "scenario must be one forced-overflow qualification scenario",
  );
  assert.match(
    attempt ?? "",
    /^[1-9][0-9]*$/u,
    "qualification attempt must be a positive integer",
  );
  assert.equal(
    runAttempt,
    "1",
    "qualification workflow reruns are forbidden; create a new dispatch after review",
  );
  const requiredAcknowledgement =
    `I ACKNOWLEDGE FORCED OVERFLOW ${scenario} ATTEMPT ${attempt}`;
  assert.equal(
    acknowledgement,
    requiredAcknowledgement,
    `acknowledgement must be exactly: ${requiredAcknowledgement}`,
  );
  return { candidateSha, scenario, attempt: Number(attempt) };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: validate-overflow-dispatch.mjs --candidate-sha <sha> --workflow-sha <sha> --checked-out-sha <sha> --scenario <name> --attempt <n> --run-attempt 1 --acknowledgement <text> [--output <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const options = parseOptions(process.argv.slice(2));
  const validated = validateOverflowDispatch({
    candidateSha: options["candidate-sha"],
    workflowSha: options["workflow-sha"],
    checkedOutSha: options["checked-out-sha"],
    scenario: options.scenario,
    attempt: options.attempt,
    runAttempt: options["run-attempt"],
    acknowledgement: options.acknowledgement,
  });
  const record = {
    schemaVersion: 1,
    kind: "watchbound-overflow-dispatch-approval",
    ...validated,
    workflowRunAttempt: Number(options["run-attempt"]),
    acknowledgement: options.acknowledgement,
  };
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

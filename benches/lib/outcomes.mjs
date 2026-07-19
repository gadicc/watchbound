export function outcomeFromChecks(checks = []) {
  const applicable = checks.filter(
    (check) => check.passed != null && check.countsTowardOutcome !== false,
  );
  if (applicable.length === 0) return "observed";
  return applicable.every((check) => check.passed) ? "pass" : "fail";
}

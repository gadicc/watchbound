import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS = 4_000;
export const MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS = 60_000;

export function parseInstalledSmokeWaitTimeoutMs(value) {
  if (value === undefined) return DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new RangeError(
      `--wait-timeout-ms must be an integer from 1 through ${MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS}`,
    );
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `--wait-timeout-ms must be an integer from 1 through ${MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export async function recoverStableReplacement(
  subscription,
  {
    timeoutMs = 4_000,
    retryDelayMs = 10,
    now = Date.now,
    sleep = delay,
  } = {},
) {
  const deadline = now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineReached = delay(
    timeoutMs,
    undefined,
    { signal: deadlineController.signal },
  ).then(() => {
    throw new Error(`root recovery did not settle within ${timeoutMs}ms`);
  });
  try {
    while (true) {
      const recovery = await Promise.race([
        Promise.resolve().then(() => subscription.recoverRoot({
          identityPolicy: "accept-replacement",
        })),
        deadlineReached,
      ]);
      if (
        recovery.attachment !== "not-attached" ||
        recovery.reason !== "identity-unstable" ||
        now() >= deadline
      ) {
        return recovery;
      }
      await Promise.race([
        Promise.resolve().then(() => sleep(retryDelayMs)),
        deadlineReached,
      ]);
    }
  } finally {
    deadlineController.abort();
  }
}

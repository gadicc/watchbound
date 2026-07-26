import { setTimeout as delay } from "node:timers/promises";

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
  while (true) {
    const recovery = await subscription.recoverRoot({
      identityPolicy: "accept-replacement",
    });
    if (
      recovery.attachment !== "not-attached" ||
      recovery.reason !== "identity-unstable" ||
      now() >= deadline
    ) {
      return recovery;
    }
    await sleep(retryDelayMs);
  }
}

// Existing qualification evidence and the repository's expected Linux default
// both use max_queued_events=16,384. Refuse a larger host setting until its
// higher I/O, inode, memory, timeout, and cleanup envelope is explicitly
// reviewed instead of silently expanding or weakening the overflow workload.
export const MAX_APPROVED_KERNEL_QUEUE_EVENTS = 16_384;
export const OVERFLOW_EVENT_MARGIN = 4_096;

export function planOverflowWorkload(rawKernelQueueLimit) {
  const normalized = typeof rawKernelQueueLimit === "string"
    ? rawKernelQueueLimit.trim()
    : "";
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new TypeError(
      "max_queued_events must be a positive base-10 integer",
    );
  }

  const kernelQueueLimit = Number(normalized);
  if (!Number.isSafeInteger(kernelQueueLimit)) {
    throw new TypeError(
      "max_queued_events must be a positive base-10 integer",
    );
  }
  if (kernelQueueLimit > MAX_APPROVED_KERNEL_QUEUE_EVENTS) {
    throw new RangeError(
      `max_queued_events ${kernelQueueLimit} exceeds approved forced-overflow ceiling ${MAX_APPROVED_KERNEL_QUEUE_EVENTS}`,
    );
  }

  return Object.freeze({
    kernelQueueLimit,
    generatedEventCount: kernelQueueLimit + OVERFLOW_EVENT_MARGIN,
    exceededQueueBy: OVERFLOW_EVENT_MARGIN,
    approvedMaximumKernelQueueLimit: MAX_APPROVED_KERNEL_QUEUE_EVENTS,
  });
}

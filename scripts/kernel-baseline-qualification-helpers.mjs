export function assertCleanQemuCompletion(result) {
  if (result.error) throw result.error;
  if (result.status === 0 && result.signal === null) return;
  throw new Error(
    `QEMU did not exit cleanly (status=${result.status}, signal=${result.signal})`,
  );
}

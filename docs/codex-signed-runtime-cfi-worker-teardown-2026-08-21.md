# Signed-runtime CFI rejection of Node-API environment cleanup hooks — 2026-08-21

## Summary

Codex Desktop Linux (signed OpenAI/Owl runtime) crashes with `SIGILL` in
`node::CleanupQueue::Drain()` whenever a Node Worker environment is destroyed
while a Node-API environment cleanup hook registered from an external native
addon is still pending. The crash is a deliberate LLVM forward-edge CFI
(`cfi-icall`) trap: the signed executable validates the cleanup callback
against an internal jump table that can only contain functions compiled into
the host binary, so any legitimate callback living in a loaded `.node` DSO is
rejected deterministically.

This is a host build/instrumentation incompatibility, not a Watchbound defect.
Watchbound's callback is a correctly-typed `void (*)(void*)` trampoline, its
payload is intact at the moment of the trap, and the DSO is mapped and
byte-identical to the shipped artifact. No Watchbound lifecycle change is
indicated, and the environment cleanup hook must not be removed: it is
required for joined, safe teardown.

## Evidence

Three organic cores and one reproduction core share one signature:

| Crash | Date (BST) | Executable SHA-256 prefix | Drain trap offset |
| --- | --- | --- | --- |
| PID 761261 | 2026-08-19 11:49 | `85e03c4b…` | `+0x27c` |
| PID 27263 | 2026-08-20 18:19 | `85e03c4b…` | `+0x27c` |
| PID 4041268 | 2026-08-21 11:28 | `17f2d51c…` | `+0x27c` |
| reproduction | 2026-08-21 | `17f2d51c…` (byte-preserved copy) | `+0x27c` |

In all four cores the crashing thread is a Node worker (`git`) running
`Worker::Run → Environment::RunCleanup → CleanupQueue::Drain`, and:

- `rip` is the `ud1` at `Drain()+0x27c` (decimal +636).
- `r8` (the rejected callback target) is the published
  `@gadicc/watchbound-node-linux-x64-gnu@2.1.2` addon (SHA-256
  `1f4713bb126bc8652d83e66d25219e0c0f3c354b3e0efeafcc2ec5e8b0bbec45`) at DSO
  virtual address `0x4c400`. The bytes at `r8` in each core are byte-identical
  to the on-disk artifact: the napi-rs
  `cleanup_env::<EnvironmentCleanupHook>` monomorphization, the trampoline
  `Env::add_env_cleanup_hook` supplies to `napi_add_env_cleanup_hook`.
- `r13` (the callback payload) is an intact napi-rs
  `CleanupEnvHookData<EnvironmentCleanupHook>` box (40 bytes): a valid
  `napi_env` raw key, a valid `Arc` record pointer, `environment_id = 1`, the
  zero-sized hook data pointer `1`, and a vtable at DSO virtual address
  `0x1690e8` (`size = 0`, `align = 1`, `call_once = 0x4b450`, chaining into
  Watchbound's `cleanup_environment`).

The instrumented callsite (`Drain()+0x180`, both signed builds):

```asm
lea    <jump-table anchor>,%rax   # host-binary .text, e.g. vaddr 0x119ca8d8
sub    %r8,%rax
ror    $0x3,%rax
cmp    $0x1be3,%rax
ja     <Drain+0x27c>              # ud1 0x2(%eax),%eax  — the trap
mov    %r13,%rdi
call   *%r8
```

The table is 7,140 eight-byte entries (`0x1be4`, including index zero), each a
`jmp rel32` into a `void
(void*)`-shaped function inside the host binary plus `int3` padding. A
callback address in an external DSO produces an enormous rotated offset and
can never satisfy the membership test, so the trap is deterministic, not
corruption-dependent. Stock Electron 42.3.0 and stock Node emit a bare
indirect `call *%r8` here with no check.

## Reproduction

Using the exact published addon and the stock teardown fixture
(`node/test/fixtures/environment-teardown-worker.cjs`, which accepts
`workerData.bindingPath`), with a live subscription whose delivery completion
is deliberately held:

- Signed Owl runtime (Node 24.14.0), Worker destroyed via
  `worker.terminate()`: SIGILL 3/3 runs. Worker exits naturally after joined
  disposal: SIGILL 1/1. The tested main-process exit path with a live
  subscription in the main environment was clean and did not reach the trapped
  Worker cleanup path, explaining why ordinary application quits did not expose
  this failure in the acceptance run.
- Stock Electron 42.3.0 (Node 24.15.0): terminate and natural-exit runs clean.
- Stock Node 24.19.0: 100 terminate cycles + 20 natural-exit cycles clean;
  Node 25.2.1 spot check clean.

The signed-runtime reproduction used a temporary runtime root (byte-preserved
copy of the signed executable, symlinked payload, minimal replacement
`app.asar`) so no Codex installation state was modified. The signed executable
ignores `ELECTRON_RUN_AS_NODE` and argv app paths, so direct fixture launch is
not a valid technique.

## Scope and corroboration

Any Node-API addon that registers `napi_add_env_cleanup_hook` (directly or via
napi-rs `Env::add_env_cleanup_hook`) traps Worker environment teardown on this
runtime; the four observed callbacks were Watchbound's because Watchbound was
the registered hook in those environments. The 2026-08-14 acceptance record
independently observed `SIGILL` from the signed runtime's native
`process.report.getReport()`, a second host-side trap unrelated to Watchbound.

The host machine has a known-unstable CPU. That confounder is refuted for this
crash class: the trap is an intentional instruction emitted by the compiler,
the rejected pointer targets byte-exact shipped code in every core, and the
failure reproduces deterministically on demand.

## Recommendations

Consumer/upstream (the defect owner is the signed runtime build):

- Suppress `cfi-icall` at Node-API boundary callsites that invoke third-party
  DSO callbacks — minimally `node::CleanupQueue::Drain`'s `CleanupHookCallback`
  invocation — or disable CFI for the embedded Node component. Clang's
  [experimental cross-DSO CFI mode][clang-cross-dso] can permit calls from
  instrumented code into known uninstrumented DSOs, but has an unstable ABI and
  additional runtime requirements. A localized exemption at this external ABI
  boundary is therefore the narrower practical remedy; the current monolithic
  host jump table cannot admit callbacks from arbitrarily loaded `.node` addons.
- Until the runtime is fixed, avoid tearing down Node Worker environments that
  have Node-API environment cleanup hooks registered (or accept the crash on
  such teardown). The tested main-process quit path is unaffected.
- Extend signed-runtime acceptance to destroy a Worker with a live registered
  environment cleanup hook; the 2026-08-14 acceptance disposed subscriptions
  explicitly and never crossed that path.

Watchbound:

- No lifecycle code change is justified; the ABI chain, payload ownership, and
  `NODELETE` loading were re-verified and are correct.
- Keep the `bindingPath` injection seam in the teardown fixture; it lets
  external harnesses exercise the exact published native artifact.
- `node/test/environment-teardown.cjs` now repeats Worker environment
  create/destroy cycles and asserts full resource release each cycle, guarding
  per-environment hook registration/removal across generations.

[clang-cross-dso]: https://clang.llvm.org/docs/ControlFlowIntegrityDesign.html#shared-library-support

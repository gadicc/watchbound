# Node binding decision

Status: selected for the maintained-unpublished source-build package and
qualified narrow target. This is not a stable public package commitment.

## Choice

Use napi-rs v3 with Node-API 6 for the thin binding.

- `napi` 3.10.5 with its default dynamic-symbol loading and the `napi6`
  feature;
- `napi-derive` 3.5.10;
- `napi-build` 2.3.2;
- `@napi-rs/cli` 3.7.3 for the pinned controlled source build.

The workspace declares Rust 1.88 as its minimum because napi-rs v3 requires it.
The engine itself does not depend on napi-rs.

Node-API is the important architectural choice: it is a C ABI maintained by
Node and avoids binding this package directly to V8 or libuv APIs. Node-API 6
also gives the proof a JavaScript `bigint` representation for monotonic batch
sequences.

napi-rs is preferred over handwritten Node-API FFI for this milestone because
it supplies checked value conversion, thread-safe functions, asynchronous tasks,
module registration, and established native-package tooling while keeping the
binding source small. Handwritten FFI would make callback and environment
cleanup the riskiest part of a filesystem prototype.

The proof deliberately does not enable napi-rs's Tokio integration. Initial
subscription and joined disposal can run as Node-API asynchronous tasks on the
existing worker pool. A dedicated bridge thread waits for Rust engine batches
and crosses into JavaScript through one bounded thread-safe function.

The same representation-only rule applies to root recovery. Node converts
fixed-size `(device, inode)` and root-state fields to bigint/string objects,
validates the two policy spellings, and runs the blocking `RootRecoveryHandle`
as an asynchronous task. Candidate selection, ancestry checks, topology,
coverage, exclusions, and boundary ordering remain entirely in the engine.

The rule also applies to operation failures. The binding transports the
engine's stable `WATCHBOUND_*` code and operation, centrally derived
`retryable`/`retryAfter` fields, and an optional bounded `systemCause` onto a
JavaScript `Error`; it does not reclassify failures from their message text.
Errors are constructed on the JavaScript thread, and the public wrapper
normalizes native-shaped errors into `WatchboundError`. Unknown or malformed
native failures become `WATCHBOUND_INTERNAL` rather than inheriting untrusted
retry metadata. Partial and uncertain coverage, and expected `not-attached`
root-recovery outcomes, remain successful structured results.

These fields are governed by schema version 1 of the
[structured operation-error contract](error-contract.md). The schema version is
a compatibility-contract version, not a property repeated on each error;
consumers branch on `code`, and treat `message` and `systemCause` as bounded
diagnostics only.

## Native identity, capabilities, and engine handles

The one native binary loaded into the process exposes schema version 1 binding
metadata: native and engine versions, binding API version 1, Node-API 6, target
triple, and build profile. Its raw capabilities also provide feature flags,
Rust subscription defaults, the shared positive-`u32` option bounds, process
budgeting, and shared-native-watch support. The wrapper combines those values
with its own version, runtime facts, the approved support target, automatic
policy limits, and observability semantics.

The resulting public `capabilities` object is deeply frozen and
JSON-serializable. Under `schemaVersion: 1`, its stable sections are `versions`,
`build`, `runtime`, `support`, `features`, `options`, and `observability`.
Observed platform, architecture, kernel, libc, Node, and Node-API values in
`runtime` identify the current process only. They are not a support decision;
`support.status` is `supported` for the fixed narrow target regardless of the
current process facts, and those facts never broaden that target.

Node exposes a cheap `NativeEngine`, and the wrapper exposes
`createEngine({ nativeWatchBudget: number | null })`. Creation stores a request
but acquires no descriptors, worker, watches, or runtime lease. The wrapper's
top-level `subscribe()` lazily creates one unbounded default engine. Every
engine from this binary shares the engine's process-wide runtime registry.
Equal configurations can coexist; unequal bounded budgets or bounded versus
unbounded establishment reject with
`WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT` and
`retryAfter: "runtime-disposed"`.

The first admitted establishment's runtime acquisition is provisional. A
differently configured concurrent call may see a conflict even if the first
call later fails establishment; releasing its final lease joins shutdown, after
which retry may succeed. The final live subscription's joined disposal likewise
permits a later configuration when it releases the final runtime lease.
`nativeWatchBudget` reports the handle's request, while `runtimeStats()` reports
actual process-global state and can therefore show another handle's active
budget. Its inactive result is the zero/null snapshot, not the handle request.

## Loader and source-build boundary

`node/index.js` and `node/index.d.ts` are hand-owned. The napi-rs build runs
with `--no-js` and writes its diagnostic declaration output only to the ignored
`native.generated.d.ts`; the workspace build verifies that the hand-owned
loader, declarations, and loader implementation remain byte-identical.

The loader accepts exactly `watchbound.linux-x64-gnu.node` beside the package.
It has no environment-variable override, optional-package lookup, WASI branch,
download, or install-time build fallback. Before exporting the binding it
requires Linux x64, detected glibc, Node-API 6 or newer, metadata schema 1,
binding API 1, matching package/native/engine versions, Node-API build floor 6,
the `x86_64-unknown-linux-gnu` target, and a release build profile. The wrapper
then asserts its own package version against the native package version.

Definitive loader failures have bounded `WATCHBOUND_UNSUPPORTED_PLATFORM`,
`WATCHBOUND_UNSUPPORTED_LIBC`, `WATCHBOUND_UNSUPPORTED_NODE_API`,
`WATCHBOUND_NATIVE_NOT_BUILT`, `WATCHBOUND_NATIVE_LOAD_FAILED`,
`WATCHBOUND_NATIVE_VERSION_MISMATCH`, or `WATCHBOUND_NATIVE_API_MISMATCH`
codes. These import-time packaging diagnostics are separate from the
schema-version-1 operational error taxonomy. Runtime facts outside the fixed
support matrix do not become supported merely because a locally built addon can
load. The full delivery decision and future prebuild gates are in
[`native-delivery.md`](native-delivery.md).

## Establishment and observed state

The engine captures `initial_coverage` and `initial_root_state` in one
establishment acknowledgement. Node exposes them as `initialCoverage` and
`initialRootState`, and the JavaScript wrapper normalizes them into its immutable
sequence-zero, exclusion-generation-zero, root-generation-zero baseline.

The wrapper's `observedState` is one frozen projection of that baseline or the
last batch whose bridge callback entered JavaScript. Callback entry can race
the subscribe promise's continuation, so the wrapper retains an early batch and
does not overwrite it when constructing the public subscription. On every
delivery it updates `observedState` before automatic policy and the user's
callback; a callback exception therefore does not erase the observation.

This projection is intentionally separate from Node's live `rootState` and
`exclusionGeneration` getters. Those getters and completed native operations
may be ahead. An operation acknowledgement establishes native commit and any
required bounded enqueue, not callback execution, and cannot advance
`observedState`. A successful operation that needs no batch can leave the
projection behind indefinitely. Ordered batches remain authoritative for what
has entered wrapper JavaScript.

## Lifecycle requirements

The bridge must preserve two independent bounds: the engine output channel and
the Node-API callback queue. It must never create an unbounded promise or closure
per native event.

Disposal is asynchronous so JavaScript remains able to drain or cancel native
callbacks while the engine and bridge join. The disposal promise may resolve
only after no queued or in-flight callback can newly enter JavaScript.
An already admitted reconciliation, exclusion update, or root recovery is
joined or explicitly interrupted by the same lifecycle boundary.

One cleanup hook is registered per Node environment. Each subscription adds a
removable weak registration; environment teardown signals all still-live
subscriptions without waiting for JavaScript callbacks. Native object
finalization launches a reaper for best-effort joined cleanup. Teardown cannot
depend on JavaScript callbacks running, and explicit disposal remains the only
full user-visible guarantee.

The ordinary Node suite destroys a worker environment while its production
binding has a live, callback-proven subscription. The parent process observes
the shared runtime return to its exact inactive baseline and then establishes,
uses, and explicitly disposes a fresh subscription. This is cleanup evidence,
not an upgrade of best-effort environment teardown into the joined public
disposal guarantee.

The JavaScript wrapper owns the callback strongly through the returned
subscription, while the native callback closure reaches that holder through a
`WeakRef`. This breaks callback-captures-subscription GC cycles without letting
an otherwise live subscription lose its callback. Callback exceptions and
thread-safe-function delivery failures are counted separately; the former do
not stop the bridge, while the latter are terminal and surface when disposal
joins it.

## Still gated

- whether a separately approved later milestone should design or produce a
  prebuilt platform/libc matrix;
- package signing, provenance, SBOM, attestation, reproducibility, and release
  automation;
- any package publication or consumer integration.

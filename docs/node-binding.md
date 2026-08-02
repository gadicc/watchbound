# Node binding decision

Status: selected for controlled source builds and the one-target public
bootstrap. The historical `0.1.0` baseline and the bootstrap implementation
baseline have narrow-target evidence. The `1.0.0` binding API 3 async callback
source qualified, and the corrected `1.0.1` package restored the JSR route.
Release `1.1.0` retained generation-zero exclusions and added exact x64/ARM64
package selection. Release `1.2.0` advances to binding API 4 for whole-policy
exclusion replacement; both targets completed exact qualification and the
release is published.

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

The resulting `.node` file is a shared library loaded into the Node or Electron
process. It is not a helper executable. Synchronous binding entry points,
native faults, descriptors, Rust threads, and memory therefore belong to the
host process.

napi-rs is preferred over handwritten Node-API FFI for this milestone because
it supplies checked value conversion, thread-safe functions, asynchronous tasks,
module registration, and established native-package tooling while keeping the
binding source small. Handwritten FFI would make callback and environment
cleanup the riskiest part of a filesystem prototype.

The binding deliberately does not enable napi-rs's Tokio integration.
Establishment, exclusion replacement, reconciliation, root recovery, and joined
disposal run as Node-API asynchronous tasks on the shared libuv worker pool.
Queued work occupies no slot before compute starts. Started work retains one
slot until its ordered engine result completes, including cancellation rollback
or final runtime shutdown; cancellation does not dequeue it or release that
slot early.

Delivery uses at most one `watchbound-node-dispatcher` thread per Node
environment rather than one bridge thread per subscription. All environments
share the one lazy `watchbound-linux-runtime` thread in the loaded binding.
Each registration keeps a separate bounded engine queue, one-entry thread-safe
function, and one admission credit. Garbage collection, delivery failure, or
environment teardown can create at most one transient
`watchbound-node-cleanup` coordinator per affected environment, with the
retained dispatcher as fallback. Steady-state Watchbound thread count is
therefore one runtime plus one dispatcher per environment with live
subscriptions, independent of subscription count within each environment.

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

These fields are governed by schema version 2 of the
[structured operation-error contract](error-contract.md). The schema version is
a compatibility-contract version, not a property repeated on each error;
consumers branch on `code`, and treat `message` and `systemCause` as bounded
diagnostics only.

Promise-returning native methods still do synchronous work before napi-rs
queues compute. The JavaScript thread resolves roots, validates and converts
options, obtains the environment record, installs the cleanup hook, starts or
joins an environment dispatcher when required, creates and attaches the
thread-safe function, encodes wrapper exclusion policies, validates root
recovery policy, and closes disposal admission. Module loading, metadata and
capability calls, engine creation, statistics, subscription getters,
cancellation-token methods, result conversion, batch normalization, and the
consumer callback's entry are synchronous too. A returned Promise-like resumes
through ordinary JavaScript jobs while retaining that subscription's delivery
credit. The filesystem traversal and joined
topology/disposal work remain off the JavaScript thread, but large inputs,
caller accessors, callback work, or contended locks can still pause it.

## Native identity, capabilities, and engine handles

The one native binary loaded into the process exposes metadata schema version 1:
native and engine versions, binding API version 4, Node-API 6, target triple,
and build profile. Its raw capability schema is version 4 and also provides
establishment-cancellation, shared-delivery, and callback-completion facts
alongside feature flags, including generation-zero initial exclusions,
recursive directory-name exclusions, observed excluded boundaries, Rust
subscription defaults, the shared positive-`u32` option bounds, process
budgeting, and shared-native-watch support. The wrapper combines those values
with its own version, runtime facts, the approved support target, automatic
policy limits, and observability semantics.

The resulting public `capabilities` object is deeply frozen and
JSON-serializable. Under `schemaVersion: 5`, its stable sections are `versions`,
`build`, `runtime`, `support`, `features`, `options`, and `observability`.
Observed platform, architecture, kernel, libc, Node, and Node-API values in
`runtime` identify the current process only. They are not a support decision.
The release metadata marks both exact GNU/Linux target entries `supported`
after the complete status-bearing matrix. The release workflow still requires
all exact artifacts and independent publication guards. Current process facts
never broaden the target matrix.

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
binding API 4, matching package/native/engine versions, Node-API build floor 6,
the `x86_64-unknown-linux-gnu` target, and a release build profile. The wrapper
then asserts its own package version against the native package version.

Definitive loader failures have bounded `WATCHBOUND_UNSUPPORTED_PLATFORM`,
`WATCHBOUND_UNSUPPORTED_LIBC`, `WATCHBOUND_UNSUPPORTED_NODE_API`,
`WATCHBOUND_NATIVE_NOT_BUILT`, `WATCHBOUND_NATIVE_LOAD_FAILED`,
`WATCHBOUND_NATIVE_VERSION_MISMATCH`, or `WATCHBOUND_NATIVE_API_MISMATCH`
codes. These import-time packaging diagnostics are separate from the
schema-version-2 operational error taxonomy. Runtime facts outside the fixed
support matrix do not become supported merely because a locally built addon can
load. The full delivery decision and future prebuild gates are in
[`native-delivery.md`](native-delivery.md).

## Establishment and observed state

The engine captures `initial_coverage` and `initial_root_state` in one
establishment acknowledgement. Node exposes them as `initialCoverage` and
`initialRootState`, and the JavaScript wrapper normalizes them into its immutable
sequence-zero, exclusion-generation-zero, root-generation-zero baseline.

The wrapper accepts `initialExclusions` as exact string or `Uint8Array`
prefixes and encodes them into raw Node `Buffer` values. Native validation
occurs before runtime acquisition; the engine applies the complete set before
opening topology directories, so excluded subtrees consume no establishment
watches. The set is part of the sequence-zero baseline.

The wrapper likewise encodes `excludedDirectoryNames` and
`observedExcludedPaths` exactly. Names must be one nonempty normal component
and prune matching directories at every depth. Observed paths must be nonempty
normalized root-relative boundaries; their descendants remain excluded and
unwatched, while exact boundary lifecycle changes remain deliverable. The raw
`replaceExclusions` method accepts either the legacy `Buffer[]` or a
`JsExclusionPolicy` object. Candidate objects are copied and validated before
runtime mutation, and the binding delegates topology meaning to the engine.

The wrapper accepts `signal?: AbortSignal` for establishment only. After pure
argument validation it creates one native single-bind cancellation token,
registers a temporary abort listener, strips `signal` from native subscription
options, and passes the token as the optional fourth raw subscribe argument.
Cancellation before or during native work rejects with non-retryable
`WATCHBOUND_OPERATION_CANCELLED` only after rollback is joined. Native success
is provisional until the wrapper calls synchronous
`commitPublicSuccess()`. If cancellation already won, the wrapper disposes the
provisional native subscription and waits before rejecting; a disposal/join
failure supersedes cancellation. After a successful commit, signal abort is a
no-op. Queued work still waits for a libuv worker turn, and started work keeps
its worker through rollback. Listener removal is attempted on every terminal
wrapper path and succeeds for a conforming `AbortSignal`. A removal throw before
public commit requests cancellation, joins provisional disposal, and rejects
with `WATCHBOUND_INVALID_ARGUMENT`; a final cleanup retry cannot replace an
already authoritative native error or cancellation result. The complete
terminal precedence and race boundaries are in
[`api-lifecycle.md`](api-lifecycle.md).

A raw pending-attempt error is not published while its provisional Node
resources remain live. After a thread-safe function exists, the binding closes
admission, removes the unpublished registration, abort-releases the function,
waits for its finalizer, and joins an inactive dispatcher before error
settlement in a live environment. Dispatcher creation failure before that
allocation creates no thread-safe function, and attachment races with
environment teardown under the environment admission barrier.

The wrapper's `observedState` is one frozen projection of that baseline or the
last batch whose dispatcher callback entered JavaScript. Callback entry can race
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

Delivery preserves two independent bounds: the engine output channel and the
Node-API callback queue. One dispatcher per environment inspects a fixed number
of registrations per turn. Its sole per-subscription admission credit prevents
a second receive or thread-safe-function call until callback completion, so
`QueueFull` is not used as flow control and no pending-batch or readiness queue
exists. These delivery bounds do not impose a native-watch bound: the default
subscription and default engine have `watchLimit: null` and
`nativeWatchBudget: null` until a consumer configures them.

Binding API 4 passes an opaque bigint delivery ID beside each raw batch. The
public wrapper returns the private boolean ownership marker, assimilates the
user's Promise-like, and calls `completeDelivery(id, callbackError, stop)`
exactly once. Native code restores credit only for the current ticket in the
same environment generation. Duplicate, stale, or cross-environment
acknowledgements do nothing. Raw private callbacks that do not return the
ownership marker retain synchronous auto-completion for low-level tests.

Every callback in one environment still executes on that environment's
JavaScript thread. A synchronously blocked callback delays peer callback
completion even though the dispatcher and filesystem runtime continue.
Sustained peer traffic can fill each peer's own bounded engine queue and mark
it independently `consumer-backpressure` uncertain. A separate Worker
environment has a separate JavaScript thread and dispatcher and can make
callback progress.

Disposal is asynchronous so JavaScript remains able to settle or cooperatively
cancel native callbacks while the engine and dispatcher registration join. The
disposal promise may resolve only after an admitted callback completion is
acknowledged and no queued or in-flight callback can newly enter JavaScript.
Environment teardown and subscription GC instead abandon an outstanding ticket
before native cleanup so they never depend on JavaScript promise settlement.
An already admitted reconciliation, exclusion update, or root recovery is
joined or explicitly interrupted by the same lifecycle boundary.

One cleanup hook and generation-specific environment record are registered per
Node environment; raw `napi_env` pointers are lookup keys rather than identity.
Environment teardown closes the shared admission barrier, signals pending and
established attempts, and requests native cleanup without waiting for
JavaScript callbacks. Finalization uses a deduplicated per-environment cleanup
table and at most one transient coordinator per affected environment, rather
than one reaper thread per object. Selection and Node cleanup phases are
bounded. Established engine disposal removes at most 64 stored items per
runtime scheduler turn, suppresses new work for that subscription, and yields
to runnable peers between turns. After the worker closes its sender, the
calling cleanup path drains queued batches and their paths in separate 64-item
destructor quanta before final runtime release. A coordinator still waits for
that joined result before advancing the same registration, so one large
cleanup can delay later cleanup in the same environment without monopolizing
the engine runtime. The dispatcher and other environments remain independent,
and coordinator failure uses the retained dispatcher as a cycle-safe fallback.
Teardown cannot depend on JavaScript callbacks running, and explicit disposal
remains the only full user-visible guarantee.

The ordinary Node suite destroys a worker environment while its production
binding has a live, callback-proven subscription. The parent process observes
the shared runtime return to its exact inactive baseline and then establishes,
uses, and explicitly disposes a fresh subscription. This is cleanup evidence,
not an upgrade of best-effort environment teardown into the joined public
disposal guarantee.

A separate size-one-libuv-pool child initiates Worker teardown while
establishment work is queued. Node itself does not enter the environment
cleanup hook until that queued async work can advance, so the test then releases
its deterministic blocker. From hook entry onward, Watchbound cleanup requires
neither a JavaScript callback nor a second libuv worker and must restore the
exact Node/runtime baseline before a fresh subscription is accepted.

The JavaScript wrapper owns the callback strongly through the returned
subscription, while the native callback closure reaches that holder through a
`WeakRef`. This breaks callback-captures-subscription GC cycles without letting
an otherwise live subscription lose its callback. Callback exceptions and
thread-safe-function delivery failures are counted separately; the former do
not stop later delivery, while the latter close only that registration and
surface when disposal joins it.

## Release boundary

- qualify the exact release commit on native x64/ARM64, pinned distro,
  Electron ASAR, Nix, and supervised overflow lanes;
- build each registry artifact on two isolated clean Ubuntu 22.04 native
  builders and compare it byte for byte before publication;
- publish only from an intentional `main` push after every pre-publication gate;
- verify exact npm and JSR Node-route installs on fresh supported hosts after
  immutable publication.

Checksums, CycloneDX SBOM generation, binary inspection, same-runner and
independent-builder reproducibility, npm/JSR provenance, and `main`-push
semantic-release automation are implemented in the release-package boundary.
They do not widen the loader's exact selected target or its qualification.

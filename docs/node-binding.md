# Node binding decision

Status: selected for the feasibility proof, not a stable package commitment.

## Choice

Use napi-rs v3 with Node-API 6 for the thin binding.

- `napi` 3.10.5 with its default dynamic-symbol loading and the `napi6`
  feature;
- `napi-derive` 3.5.10;
- `napi-build` 2.3.2;
- `@napi-rs/cli` 3.7.3 for local proof builds only.

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

## Lifecycle requirements

The bridge must preserve two independent bounds: the engine output channel and
the Node-API callback queue. It must never create an unbounded promise or closure
per native event.

Disposal is asynchronous so JavaScript remains able to drain or cancel native
callbacks while the engine and bridge join. The disposal promise may resolve
only after no queued or in-flight callback can newly enter JavaScript.

One cleanup hook is registered per Node environment. Each subscription adds a
removable weak registration; environment teardown signals all still-live
subscriptions without waiting for JavaScript callbacks. Native object
finalization launches a reaper for best-effort joined cleanup. Teardown cannot
depend on JavaScript callbacks running, and explicit disposal remains the only
full user-visible guarantee.

The JavaScript wrapper owns the callback strongly through the returned
subscription, while the native callback closure reaches that holder through a
`WeakRef`. This breaks callback-captures-subscription GC cycles without letting
an otherwise live subscription lose its callback. Callback exceptions and
thread-safe-function delivery failures are counted separately; the former do
not stop the bridge, while the latter are terminal and surface when disposal
joins it.

## Not decided here

- supported Node release matrix beyond the workspace's current Node 18 floor;
- prebuilt platform/architecture matrix and libc variants;
- package signing, provenance, and release automation;
- whether a future binding should use a shared process-wide engine dispatcher.

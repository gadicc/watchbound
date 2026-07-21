# Structured operation-error contract

Status: schema version 1, approved for the maintained-unpublished API.

Watchbound errors describe why an operation could not complete. They are not a
substitute for coverage: watch pressure encountered during traversal remains a
successful `partial` result, ordinary delivery loss remains `uncertain`, and
expected root-recovery refusals remain successful `not-attached` results.

## JavaScript shape

Public wrapper failures are `WatchboundError` instances with:

- `name: "WatchboundError"`;
- a stable `code` from the table below;
- the stable lowercase `operation` that failed;
- a centrally derived boolean `retryable`;
- an optional stable `retryAfter` condition;
- an optional bounded `systemCause` for diagnostics;
- a bounded human-readable `message` that is not a compatibility surface.

The Node binding transports the same metadata. The JavaScript wrapper rebuilds
a public `WatchboundError` from native-shaped failures and conservatively maps
an unrecognized native exception to `WATCHBOUND_INTERNAL`. Consumers must not
parse messages to make policy decisions.

The operation values are `create-engine`, `subscribe`, `replace-exclusions`,
`reconcile`, `recover-root`, `dispose`, and `deliver-batch`.

## Codes and retry conditions

| Code | Meaning | Retryable | Retry only after |
| --- | --- | --- | --- |
| `WATCHBOUND_INVALID_ARGUMENT` | The request cannot satisfy the API contract. | No | Correcting the request |
| `WATCHBOUND_SUBSCRIPTION_CLOSED` | New work observed a disposing or disposed subscription. | No | Creating a different subscription |
| `WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT` | Another topology transaction already owns the subscription-local slot. | Yes | `topology-transaction-settles` |
| `WATCHBOUND_OPERATION_INTERRUPTED` | Already admitted work was cancelled by disposal or environment teardown. | No | Not applicable |
| `WATCHBOUND_CONSUMER_BACKPRESSURE` | A required operation boundary could not enter a full delivery queue. | Yes | `delivery-drains` |
| `WATCHBOUND_ROOT_STATE_CONFLICT` | The requested operation conflicts with the current attached/lost root state. | Yes | `root-state-changes` through the explicit root workflow |
| `WATCHBOUND_ROOT_UNAVAILABLE` | Initial root admission could not establish a stable accessible directory. | Yes | `filesystem-state-changes` |
| `WATCHBOUND_RESOURCE_UNAVAILABLE` | The process runtime, native primitives, or required bridge thread could not be created. | Yes | `resources-available` |
| `WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT` | A live shared runtime has a different native-watch budget. | Yes | `runtime-disposed` after its final joined subscription disposal |
| `WATCHBOUND_INTERNAL` | An invariant, channel, worker, or binding mechanism failed. | No | Investigation rather than automatic retry |

Retryability is derived from the code in the Rust engine and mirrored by the
binding and wrapper. A call site cannot assign contradictory retry metadata.
Retryable means a retry is permitted after the named external condition; it is
not a promise that the retry will succeed or permission for an unbounded loop.

## Successful non-error states

These conditions intentionally do not reject:

- logical or native watch pressure found during traversal produces reasoned
  `partial` coverage;
- dropped ordinary batches produce sticky `uncertain` coverage and a bounded
  root invalidation rather than reconstructed detail;
- root recovery returns `attachment: "not-attached"` for replacement refusal,
  missing/non-directory/symlink candidates, unstable identity, or unavailable
  root watch;
- an exclusion or root-recovery boundary that cannot be delivered reports the
  conservative coverage/result already defined by that operation.

## Policy use

Automatic reconciliation may use exact codes and retry metadata only. In
particular, `WATCHBOUND_ROOT_STATE_CONFLICT` blocks reconciliation until an
explicit root decision, while bounded retries may handle topology conflicts or
consumer backpressure. Text resembling “root replaced” has no policy meaning.

`systemCause` is diagnostic evidence, not a portable decision surface. Its
domain is `os` or `node-api`; it may include a numeric/string code and an
implementation kind, and its message is bounded. Consumers should branch on
the Watchbound code instead.

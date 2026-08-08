# Watchbound contributor guidance

## Project

Watchbound is an experimental Linux-first recursive directory watcher. The
Rust engine uses inotify directly, the Node package is a thin Node-API proof,
and the JavaScript package supplies the ergonomic public wrapper.

The defining contract is conservative coverage: never silently claim more
filesystem coverage than the watcher has. Preserve explicit complete, partial,
and uncertain states; bounded batches and queues; and joined disposal.

This repository is still a feasibility project. Do not publish packages or
integrate it into Codex Desktop unless the user explicitly expands the scope.

## Repository layout

- `engine/`: reusable Rust engine and Linux inotify state machine.
- `node/`: thin napi-rs representation and lifecycle bridge.
- `js/`: ESM wrapper and TypeScript declarations.
- `benches/`: isolated conformance and benchmark adapters and harnesses.
- `docs/`: architecture, lifecycle, methodology, findings, and decisions.
- `scripts/`: repository checks.

Keep filesystem semantics in `engine/`. The Node binding should translate
representations and lifecycle only. Git-ignore rules, Codex policy, UI behavior,
and logical workspace mapping belong to consumers, not the engine.

## Development

Requirements are Linux, Rust 1.88 or newer, Node.js 18 or newer, pnpm, and a C
linker.

```sh
pnpm install
pnpm build:node
pnpm test
pnpm check
```

- Use test-driven changes for watcher semantics and lifecycle behavior.
- Run focused tests while iterating, then `pnpm test` and `pnpm check` before
  handing off a code change.
- `pnpm check` enforces Rust formatting, Clippy with warnings denied, and
  JavaScript syntax checks.
- Preserve exact Linux path bytes at the native boundary. Do not normalize away
  path components before native symlink validation.
- Keep every checked-in npm, Cargo, and lockfile version at
  `0.0.0-development`. Semantic-release is the only published-version
  authority; release jobs apply its planned version as a deterministic,
  uncommitted transform of the exact source SHA.
- Keep Ubuntu 22.04/glibc 2.35 as the release builder and guest compatibility
  floor. System-QEMU runs on the target's explicit Ubuntu 24.04
  `kernelRunner`; that Actions host is emulator tooling, not support evidence.
  Do not couple a QEMU host update to the pinned Ubuntu 22.04 userspace or
  kernel-5.15 guest contract.
- Do not follow directory symlinks or weaken explicit watch/resource limits.
- Keep output cardinality and native-to-JavaScript delivery bounded. On loss or
  pressure, prefer a root invalidation and explicit uncertainty over detailed
  claims that may be incomplete.
- Disposal must be idempotent and must prevent a callback from starting after
  the disposal promise resolves.

## Release qualification invariants

- Validate runnable native artifacts through the production loader and its
  `bindingMetadata()` contract. Do not reintroduce raw version or target-string
  scans for runnable artifacts: optimizing compilers may encode short strings
  without contiguous bytes even when runtime metadata is correct.
- The raw target/version scan for a non-runnable cross build is a deliberate,
  compiler-sensitive early sanity gate, not authoritative metadata evidence.
  Do not generalize it or silently remove it. The authoritative ARMv7 proof is
  the production loader executing the exact canonical artifact digest under
  QEMU; see `docs/native-delivery.md`.
- Discover installed registry targets through module resolution from the native
  loader. Do not inspect only the project-root `node_modules`: npm may flatten
  transitive optional targets there, while pnpm's strict layout deliberately
  keeps them inside the loader's dependency graph.
- Keep system-QEMU output live but bounded, and always join emulator termination
  before deleting its disk or writing success evidence. Preserve emulator-adjacent
  `ETIMEDOUT` diagnostics because the supervised rerun reviewer distinguishes
  infrastructure timeouts from semantic failures.
- The kernel-floor guest remains `-smp 1`. ARM64 alone uses explicit MTTCG as a
  controlled scheduler mitigation for recurring hosted-runner stalls; it is not
  a proven speedup or permission to add vCPUs, broaden MTTCG to new host/guest
  pairs, or claim the flake fixed without repeated retained CI evidence.
- Installed-smoke observation deadlines are semantic failures. Emit their
  semantic marker before cleanup and never allow one through the QEMU-timeout
  rerun waiver. Release callback gates before cleanup, but keep disposal truly
  joined; a `Promise.race()` deadline must never treat subscribe rollback,
  disposal, exclusion replacement, reconciliation, or recovery as complete or
  bypass their eventual joined cleanup.

## JSR documentation and score

Treat the current complete JSR score factors as release invariants, not as an
80% target:

- Keep a substantive root `README.md` and a main-entrypoint module doc.
- Keep at least one working package-usage example in a fenced code block in
  the root README or main module doc. Build and test commands alone are not a
  substitute for an API example.
- Put a JSDoc module summary with `@module` in every JSR entrypoint. When an
  entrypoint is added or renamed, update its module doc and the generated
  `jsr.json` exports together.
- Document every exported symbol and every public member of exported
  interfaces and classes with meaningful JSDoc. This includes type aliases,
  constants, overloads, re-exports, options, result fields, methods, and newly
  public types reached through another exported type. Require 100% coverage
  even though JSR awards the factor at 80%.
- Preserve `/* @ts-self-types="./index.d.ts" */` on the JavaScript entrypoint
  and keep its declaration surface synchronized with the runtime exports.
- Keep every public type fast for JSR: exported variables, functions, class
  members, parameters, and return values need explicit or simply inferable
  types; do not introduce public module/global augmentation, CommonJS export
  forms, export destructuring, private-type references, or expandos.

Run `deno doc --lint js/index.d.ts` after any public declaration or
documentation change. Before handoff of package-surface or entrypoint changes,
also run `pnpm test:packages`; it prepares the exact JSR tree and exercises the
JSR publish dry run. Recheck all score factors whenever JSR changes its scoring
rules.

## Benchmarks and conformance

- Quick or targeted functionality checks are allowed during development.
- Do not record or replace final benchmark readings until the user confirms the
  host is sufficiently quiet and prepared.
- Run trials serially and keep the rotating adapter order.
- Compare the exact configured Codex helper and exactly `@parcel/watcher` 2.5.6
  with its inotify backend forced; do not substitute approximations.
- Keep failed semantic trials out of performance aggregates while retaining all
  raw correctness results.
- Forced overflow is I/O-heavy conformance evidence. Use the supervised helper
  and do not run it casually as part of a quick check.
- Raw JSON under `benches/results/` is intentionally ignored by Git. Retain it
  locally and record filenames, hashes, host state, ranges, and caveats in the
  results documentation.

## Commits

- Use conventional commits with scopes for title.
- In the body, include the motivation, summary of changes, and anything else of
  note.
- At bottom: "Co-authored with <Assistant> (<model>, reasoning <level>)"
- If and only if YOU are the Codex tool, use the top-level `model` and
  `model_reasoning_effort` values from `~/.codex/config.toml` for `<model>` and
  `<level>` when present (not relevant for Antigravity or other non-Codex
  assistants).
- If the exact assistant name, model and reasoning level are unknown and cannot
  be inferred, ask the user before committing and then reuse that answer for the
  rest of the session.

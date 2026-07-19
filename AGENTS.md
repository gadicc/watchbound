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
- Do not follow directory symlinks or weaken explicit watch/resource limits.
- Keep output cardinality and native-to-JavaScript delivery bounded. On loss or
  pressure, prefer a root invalidation and explicit uncertainty over detailed
  claims that may be incomplete.
- Disposal must be idempotent and must prevent a callback from starting after
  the disposal promise resolves.

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

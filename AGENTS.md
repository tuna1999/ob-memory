# Repository Guidelines

## Project Overview

`ob-memory` is an oh-my-pi (omp) extension that keeps long sessions coherent across compaction. It maintains a branch-local, source-backed memory ledger — observations → reflections → drop tombstones — stored as custom session entries and rendered deterministically into omp's compaction summary. No vector DB, no per-turn retrieval, no second memory store. Version `0.3.1`; MIT, with prompt/architecture attribution to `pi-observational-memory` in `NOTICE`.

## Architecture & Data Flow

- **Registration**: `src/index.ts` `obMemory(pi)` registers the `/ob-memory` command, the `ob_recall` tool, compaction handlers, and lifecycle events. The single `SessionRuntime` lives in the factory closure; non-`main` agents are ignored.
- **Write path**: `session_start` → `bindSession` builds the runtime → `turn_end` / `agent_end` call `scheduleConsolidation` (debounced via a module `WeakMap`) → `workers/trigger.ts` `consolidate()` resolves the worker model, chunks unobserved entries (`ledger/serialize.ts`), then runs observer → reflector → dropper. Each stage appends custom entries through `pi.appendEntry` (`ob-memory.observations.recorded`, `…reflections.recorded`, `…observations.dropped`). Observation timestamps are model-supplied and pattern-validated; ids and token counts are computed locally.
- **Read path**: `ledger/fold.ts` (`foldLedger`, `fullProjection`, `visibleProjection`, `compactionProjection`) rebuilds state from entries; `ledger/render.ts` renders within a token budget; `commands/view.ts` and `commands/status.ts` present it.
- **Compaction**: `session_before_compact` may own the summary by returning a custom `CompactionResult` (`hooks/compaction.ts`); otherwise `session.compacting` supplies rendered memory to native summarization where the method consumes it. `hooks/cut.ts` resolves a safe cut; unobserved source is retained when it fits, otherwise compaction delegates.
- **Branch locality**: every pass re-reads `ctx.sessionManager.getBranch()`; the runtime is rebuilt on session-id changes (switch/branch/fork). Same-session tree navigation keeps the runtime and only refreshes context, so no ledger state is cached across paths.

Patterns to preserve:

- Model output supplies content only; ids, timestamps, token counts, and source ids are computed locally.
- `signal.throwIfAborted()` before any append; `append` returns `false` once disposed.
- Coverage watermarks may not exceed the last sent source entry; partial coverage advances only through cited ids.
- Drops are tombstones applied at the tip, never deletions of history.
- Redaction (`security/redact.ts`) wraps worker input, rendered output, notifications, logs, and recall.

## Key Directories

| Path | Purpose |
|---|---|
| `src/commands/` | `/ob-memory` subcommands (`control.ts`) and presentation (`view.ts`, `status.ts`); argument completions in `completions.ts` |
| `src/hooks/` | Compaction ownership, cut resolution, policy, fallback injection |
|`src/ledger/`|Entry types/guards, fold/projections, provider usage deltas, renderer, serialization/chunking, recall, quality filter|
| `src/workers/` | Observer/reflector/dropper, worker loop, prompt text, model resolution, consolidation trigger |
| `src/tools/` | `ob_recall` tool registration |
| `src/security/` | Secret redaction |
| `src/util/` | Id hashing, token estimation, time helpers |
| `tests/` | `bun:test` suites and shared harness |
| `docs/` | Config keys (`config.md`) and data-flow/privacy (`privacy.md`) |
| `scripts/` | `bench.ts` hot-path benchmark |

## Development Commands

```bash
bun install                  # install deps (Bun only)
bun run typecheck            # tsc --noEmit (src, tests, scripts)
bun test                     # full suite
bun test tests/ledger.test.ts
bun test -t "compaction"     # filter by test name
bun run check                # typecheck + test
bun run bench                # fold/render/chunk benchmark
omp -e ./src/index.ts        # run omp with this extension from source
omp plugin install "$PWD"    # install the working tree as a plugin
```

There is no compile/bundle step, no lint/format config, and no CI: verification is `bun run check`.

## Code Conventions & Common Patterns

- **TypeScript**: strict plus `noUncheckedIndexedAccess` (narrow indexed reads), `noImplicitOverride`, `useUnknownInCatchVariables`. `verbatimModuleSyntax` means type-only imports must use `import type` (e.g. `src/index.ts:1`). Relative imports are extensionless.
- **Dependency injection**: host APIs arrive as `pi` / `ctx` and are stored on `SessionRuntime`; tests pass fake `pi` / `ctx` and a scripted `complete`.
- **State**: mutable per-session state only on `SessionRuntime`; module scope is constants plus the `pendingByRuntime` timer map (`src/workers/trigger.ts`). No global caches.
- **Errors**: config loading never throws (warnings + ignore); hook/command boundaries catch and `recordError`; a failed `append` is recorded and returns `false`; exceptions escaping `runExclusive` apply exponential backoff; invalid worker output becomes a textual `isError` tool result instead of an exception.
- **Async**: thread `AbortSignal` through worker calls, combine with `AbortSignal.any`, and check abort before side effects. Scheduling goes through `runtime` timers, not raw `setTimeout`.
- **Determinism**: ids are `sha256(...).slice(0, 12)` with nonce collision avoidance (`src/util/ids.ts`); memory content is single-line and low-value filler is rejected (`ledger/quality.ts`); token counts are local estimates with a bytes/4 fallback (`src/util/tokens.ts`).
- **Naming**: `camelCase` functions/variables, `PascalCase` types/classes, `UPPER_SNAKE` constants; custom entry types are `ob-memory.*` (`src/constants.ts`).

## Important Files

- `src/index.ts` — extension entrypoint, lifecycle wiring, command registration.
- `src/runtime.ts` — per-session state, append, exclusive execution, timers, error/backoff tracking.
- `src/constants.ts` — entry types, version, id/timestamp patterns, token fallback.
- `src/config.ts` / `src/config-types.ts` — precedence, validation, defaults, `publicConfig`.
- `src/ledger/fold.ts`, `render.ts`, `serialize.ts` — ledger reconstruction and budgeted rendering.
- `src/hooks/compaction.ts`, `cut.ts`, `policy.ts` — compaction ownership and safe cuts.
- `src/workers/trigger.ts` — consolidation orchestration and scheduling.
- `tests/helpers.ts` — `makeHarness`, `scriptedComplete`, entry builders.
- `package.json`, `tsconfig.json`, `scripts/bench.ts`, `docs/config.md`, `docs/privacy.md`.

## Runtime/Tooling Preferences

- **Bun only**: `bun.lock`, `@types/bun`; no npm/yarn/pnpm workflow and no `engines`/`packageManager` constraint declared.
- omp loads `./src/index.ts` directly via the `"omp": { "extensions": ["./src/index.ts"] }` manifest; `allowImportingTsExtensions` is enabled but unused.
- `@oh-my-pi/pi-coding-agent` is a devDependency, not a runtime dependency; the only runtime value imported from it is `getAgentDir` (`src/index.ts:1`) — everything else is `import type`. Runtime dependencies are `@oh-my-pi/pi-agent-core` and `@oh-my-pi/pi-ai`, pinned at `18.13.3`.
- Version is duplicated: keep `EXTENSION_VERSION` (`src/constants.ts`) equal to `package.json#version`; `tests/version.test.ts` enforces it.
- `.omp/` is ignored because `<cwd>/.omp/ob-memory.json` is a local override; `dist/` is unused.

## Testing & QA

- Framework: `bun:test` only; 17 files, 107 tests at current HEAD. No coverage collector or thresholds.
- Harness: `makeHarness()` fakes `pi`/`ctx`, `scriptedComplete()` replays canned assistant messages, and `makeModel()` uses `https://example.invalid/v1` — tests never hit the network or a real model.
- Style: behavioral assertions on returned values and appended ledger entries (no `mock.module`, `spyOn`, or fake timers); frozen timestamps (`2026-10-29T10:00:00Z`); temp dirs via `mkdtempSync` and `rmSync` in `afterEach`; env vars passed explicitly (only `tests/extension.test.ts` mutates `PI_CODING_AGENT_DIR` and restores it).
- Expectation: changes to ledger, workers, compaction, or config need a regression test in the closest suite; keep tests deterministic and offline.

## Plane Tracking

Mapped Plane project:

- Name: `OBM — Observational Memory`, identifier prefix `OBM`
- Repo: `https://github.com/tuna1999/ob-memory`
- Resolve its id with `project list` and match `identifier`/`name`; never guess another project.

Workflow for every code or doc change in this repo:

1. Before editing, find or create a work item in OBM (`state: Todo`): name `T<n> — <summary>`, `area:*` + `kind:*` labels, a checkable acceptance line, and the verification command.
2. Move the item to `In Progress` when work starts.
3. Move to `Done` only after verification passes, and record evidence in the item (commit hash, test counts, smoke output) as a description update or comment.
4. If work landed without an item, backfill a retrospective item instead of silently skipping.
5. If the Plane MCP server is unavailable or a call fails, continue the coding task and report that Plane synchronization was skipped; never block the task on Plane.

Deployment notes:

- States: `Backlog` = design/deferred, `Todo` = actionable, `In Progress` = being worked, `Done` = acceptance evidence recorded.
- Epics `E1`–`E6` group tasks; labels are the grouping mechanism otherwise.
- Work item types are not enabled in this deployment (`workitem_type` returns HTTP 404); omit `type_id`.
- Never store the Plane API key or other credentials in this repo.

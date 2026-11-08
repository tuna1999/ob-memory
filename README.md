# ob-memory

Observational memory for [oh-my-pi](https://omp.sh) (omp). It keeps long sessions coherent across compactions by maintaining a branch-local, source-backed memory ledger and rendering that ledger into omp's compaction summary.

No vector database. No per-turn retrieval. No second copy of the transcript. Tested against omp 18.13.3.

## What it does

- **Observer** distills unobserved conversation chunks into timestamped, relevance-rated observations. Every observation cites the exact source entry ids that support it.
- **Reflector** crystallizes stable, durable facts from active observations into reflections.
- **Dropper** retires observations when the pool exceeds its budget. Low/medium relevance records may be dropped without reflection coverage; high relevance needs reflection coverage, and critical records are never drop candidates. Drops are ledger tombstones, not history deletion.
- **Compaction ownership** replaces omp's native summary with a deterministic memory render when the ledger covers the summarized range. If the observer has not covered the cut, the plugin retains the unobserved tail or delegates to native compaction.
- **`ob_recall`** recovers one exact observation/reflection id plus its source evidence. It is a provenance tool, not semantic search.
- **`/ob-memory`** exposes view, status, config, passive mode, and a manual consolidation pass.

The ledger is stored as ordinary omp session entries:

```text
ob-memory.observations.recorded
ob-memory.reflections.recorded
ob-memory.observations.dropped
ob-memory.folded          (compaction details)
```

The session journal remains the only persistent store. Folding on read makes the ledger branch-local automatically: a fork or resume only sees entries on its own root-to-leaf path.

## Install

The plugin is distributed from the public GitHub repository (it is not published to npm):

```bash
omp plugin install github:tuna1999/ob-memory
```

A full git URL works too:

```bash
omp plugin install https://github.com/tuna1999/ob-memory
```

Git installs need `git` on `PATH`; omp supplies its own Bun for the install itself.

Update a GitHub install later with:

```bash
omp plugin upgrade ob-memory
```

For local development, clone the repository and link the checkout instead:

```bash
git clone https://github.com/tuna1999/ob-memory.git
cd ob-memory
bun install
omp plugin install "$PWD"
```

Or load a checkout directly without installing it:

```bash
omp --no-extensions -e ./src/index.ts
```

`--no-extensions` prevents an installed copy from loading alongside the
checkout; explicit `-e` paths still load. Without it, both copies register
handlers and can append duplicate ledger entries.

Development checks:

```bash
bun run typecheck
bun test
```

## Configuration

Configuration is merged in this order:

1. built-in defaults
2. `~/.omp/agent/ob-memory.json` (respects the active omp profile / `PI_CODING_AGENT_DIR`)
3. `<cwd>/.omp/ob-memory.json`
4. `OB_MEMORY_*` environment variables

A broken config warns and keeps the default; it never prevents the extension from loading. See [`docs/config.md`](docs/config.md) for every key.

Minimal example:

```json
{
  "observeAfterTokens": 6000,
  "reflectAfterTokens": 4000,
  "observationsPoolMaxTokens": 16000,
  "compactionSummaryMaxTokens": 8000,
  "model": "anthropic/claude-sonnet-5-5",
  "fallbackModel": "openai/gpt-6.1-sol"
}
```

Without `model`, memory workers use the active session model. A configured `fallbackModel` is used only when the primary cannot be resolved or authenticated.

## Commands

| Command | Purpose |
|---|---|
| `/ob-memory view` | Memory the model can currently see: the latest compaction's records when it was memory-owned; after a newer native compaction it points to `view full`; with no compaction, or after a `/clear` newer than the latest compaction, the live ledger minus records cleared by that `/clear`. The interactive view keeps the newest 120 lines (the header reports how many older lines were dropped) so large ledgers stay responsive. |
| `/ob-memory view full` | Full active ledger on the current branch, including records cleared by `/clear` (shown for audit, never sent to a model); the interactive view keeps the newest 240 lines and reports the rest. |
| `/ob-memory status` | Counts, coverage watermarks, pressure, drift, last run/error, omp Hide Secrets state and pause |
| `/ob-memory observe-now` | Run one consolidation pass immediately (refused while paused for omp Hide Secrets) |
| `/ob-memory passive on\|off` | Pause/resume automatic workers, compaction ownership and native-compaction memory context for this session (session only); `on` also stops the running pass |
| `/ob-memory config` | Effective config, including the worker model the next pass would select (`workerModelSource`: configured, session, fallback, or unavailable) |
| `/ob-memory help` | Command help |

Tool:

```json
{ "id": "fe1bc972f74d" }
```

`ob_recall` returns the record, supporting observations for a reflection, and source evidence within a token cap. It declares the `read` approval tier, so read-only approval modes auto-approve it. Records cleared by `/clear` are reported as cleared.

## Compaction behavior

`session_before_compact` takes ownership only when:

- the reason is not `overflow`;
- `ownManualCompaction` / `ownAutoCompaction` permits it;
- the observer has covered every source entry that would be summarized (a chunk the observer skipped after repeated failures does not count while it is still in context).

If the observer is behind the proposed cut, the plugin first tries a bounded synchronous catch-up (`compactionCatchUpMaxChunks`, `compactionCatchUpBudgetMs`), aborting any background consolidation that is still running so it does not skip catch-up. If that is not enough, it either:

- moves the cut back to retain the unobserved tail, subject to `compactionMaxRetainedTokens`, or
- delegates to omp's native summarizer.

Owned compactions are sized to the check omp runs after a compaction. After a threshold compaction, the estimated system prompt and tool schemas, the kept or retained tail, and the memory summary must fit omp's post-compaction recovery band (80% of the compaction threshold); after an incomplete-turn retry they must fit the window less omp's budget reserve (the larger of 15% of the window and `compaction.reserveTokens`, default 16,384); overflow recovery always delegates. omp does not check idle compactions or manual `/compact`, so their summary is not shrunk. A summary that does not fit is shrunk to the room left, listing records about the compacted range before records about messages that stay in context; omitted records stay in the ledger (`/ob-memory view full`) and are rendered again by the next owned compaction. A retained unobserved tail is always held to the band and to `compactionMaxRetainedTokens`, and compaction is delegated when the room left is below the native fallback size and cannot hold every record about the compacted range. The fixed context is an estimate, so this makes omp's dead-end rescue path unlikely rather than impossible.

With `compaction.experimentalContextManagement` enabled, catch-up is skipped because omp cancels a rollover whose branch leaf moved during the hook.

Installing ob-memory turns off omp's async (speculative) compaction once a session binds with a config that can own compaction, because omp keeps blocking semantics for extensions that intercept `session_before_compact`. See [`docs/config.md`](docs/config.md#async-compaction).

When delegating (unless passive, including the omp Hide Secrets pause), `session.compacting` supplies the rendered ledger as extra summary context and records `preserveData["ob-memory"]`. This hook is advisory: native methods that consume summarizer context (for example `soft`) generally use it, while deterministic methods such as `snapcompact` and `handoff` may not embed it in the final summary. The context is supplied on every compaction attempt, including host method fallbacks. The host skips `session.compacting` when a custom result was supplied, so the two paths cannot duplicate memory in one pass. Focused `/compact <instructions>` deliberately delegates so the native summarizer can honor the user's focus while still receiving the memory context. If memory must be authoritative in the retained context, keep compaction ownership enabled and coverage current.

## Privacy

- Credentials are redacted from worker prompts, stored observations/reflections, compaction summaries, recall output, notifications, and debug logs. Redaction is best-effort pattern matching, not encryption.
- omp's Hide Secrets obfuscation does not apply to worker requests, so while it is on ob-memory pauses automatic memory passes, and stops supplying memory to compaction, by default (`pauseOnHostSecrets`; `/ob-memory passive off` overrides for the session). See [`docs/privacy.md`](docs/privacy.md#omp-hide-secrets).
- Images are placeholders by default. `observeAttachments: true` includes only mime-type metadata, never image bytes.
- Debug logs are off by default. When enabled they go to `<agentDir>/ob-memory/debug/<sessionId>.ndjson` and contain redacted metadata and usage, not full prompts.
- The plugin does not create a second database or send data anywhere except the configured model provider.

See [`docs/privacy.md`](docs/privacy.md).

## Development verification

```bash
bun run typecheck
bun test
bun run bench
```

The benchmark folds 10,000 journal entries, renders summaries, chunks a 12k-token source window, and runs 100 compaction projections. Representative result on the development host:

```text
entries=10000 compactions=100
foldLedger (tip)                       1.057 ms/op
fullProjection (tip)                   1.751 ms/op
renderMemory (all records)             0.720 ms/op
renderMemory (4k budget)               0.416 ms/op
chunkUnobserved (12k budget)           2.065 ms/op
compactionProjection x100              1.062 ms/op
```

## Scope

In scope: session continuity across compactions, branch-local memory, source traceability, safe compaction integration.

Out of scope: a cross-session knowledge base (use omp's memory backend), semantic/vector search, graph memory, replacing native compaction modes, and subagent memory (the extension binds only main sessions).

## Design references

- [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory) and [research notes](https://mastra.ai/research/observational-memory)
- [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) (MIT), especially its observer/reflector/dropper prompts and coverage model
- omp extension/compaction/session documentation (`omp://extensions.md`, `omp://compaction.md`, `omp://session.md`)

The implementation here is independent and targets omp's `@oh-my-pi/*` APIs; it does not depend on the Pi extension packages.

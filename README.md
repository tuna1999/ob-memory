# ob-memory

Observational memory for [oh-my-pi](https://omp.sh) (omp). It keeps long sessions coherent across compactions by maintaining a branch-local, source-backed memory ledger and rendering that ledger into omp's compaction summary.

No vector database. No per-turn retrieval. No second copy of the transcript. Tested against omp 18.13.3.

## What it does

- **Observer** distills unobserved conversation chunks into timestamped, relevance-rated observations. Every observation cites the exact source entry ids that support it.
- **Reflector** crystallizes stable, durable facts from active observations into reflections.
- **Dropper** retires only observations whose meaning is safely captured elsewhere. Critical records are never drop candidates; drops are ledger tombstones, not history deletion.
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

```bash
omp plugin install /absolute/path/to/ob-memory
```

or load it explicitly:

```bash
omp -e /absolute/path/to/ob-memory/src/index.ts
```

For local development:

```bash
bun install
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
  "model": "anthropic/claude-sonnet-4-6",
  "fallbackModel": "openai/gpt-5.2"
}
```

Without `model`, memory workers use the active session model. A configured `fallbackModel` is used only when the primary cannot be resolved or authenticated.

## Commands

| Command | Purpose |
|---|---|
| `/ob-memory view` | Visible memory from the latest memory compaction (or the full ledger if none) |
| `/ob-memory view full` | Full active ledger on the current branch |
| `/ob-memory status` | Counts, coverage watermarks, pressure, drift, last run/error |
| `/ob-memory observe-now` | Run one consolidation pass immediately |
| `/ob-memory passive on\|off` | Pause/resume automatic workers for this session (session only) |
| `/ob-memory config` | Effective config |
| `/ob-memory help` | Command help |

Tool:

```json
{ "id": "fe1bc972f74d" }
```

`ob_recall` returns the record, supporting observations for a reflection, and source evidence within a token cap.

## Compaction behavior

`session_before_compact` takes ownership only when:

- the reason is not `overflow`;
- `ownManualCompaction` / `ownAutoCompaction` permits it;
- the observer's `coversUpToId` reaches every source entry that would be summarized.

If the observer is behind the proposed cut, the plugin first tries a bounded synchronous catch-up (`compactionCatchUpMaxChunks`, `compactionCatchUpBudgetMs`). If that is not enough, it either:

- moves the cut back to retain the unobserved tail, subject to `compactionMaxRetainedTokens`, or
- delegates to omp's native summarizer.

Native compaction is never silently starved of context. When delegating, `session.compacting` injects the rendered ledger as extra summary context and records `preserveData["ob-memory"]`. The host skips `session.compacting` when a custom result was supplied, so the two paths cannot duplicate memory in one pass. Focused `/compact <instructions>` deliberately delegates so the native summarizer can honor the user's focus while still receiving the memory context.

## Privacy

- Credentials are redacted from worker prompts, stored observations/reflections, compaction summaries, recall output, and debug logs. Redaction is best-effort pattern matching, not encryption.
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
foldLedger (tip)                       1.481 ms/op
fullProjection (tip)                   1.660 ms/op
renderMemory (4k budget)               0.503 ms/op
chunkUnobserved (12k budget)           1.988 ms/op
compactionProjection x100              1.082 ms/op
```

## Scope

In scope: session continuity across compactions, branch-local memory, source traceability, safe compaction integration.

Out of scope: a cross-session knowledge base (use omp's memory backend), semantic/vector search, graph memory, replacing native compaction modes, and subagent memory (the extension binds only main sessions).

## Design references

- [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory) and [research notes](https://mastra.ai/research/observational-memory)
- [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) (MIT), especially its observer/reflector/dropper prompts and coverage model
- omp extension/compaction/session documentation (`omp://extensions.md`, `omp://compaction.md`, `omp://session.md`)

The implementation here is independent and targets omp's `@oh-my-pi/*` APIs; it does not depend on the Pi extension packages.

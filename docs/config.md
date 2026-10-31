# Configuration

All fields are optional. Defaults are shown.

## Files and precedence

1. `<agentDir>/ob-memory.json`
2. `<cwd>/.omp/ob-memory.json`
3. `OB_MEMORY_*` environment variables

`agentDir` is omp's active agent directory (`~/.omp/agent` by default; profiles and `PI_CODING_AGENT_DIR` are respected). Later sources override earlier ones. Invalid values warn and fall back to the previous valid value.

Project files are repository-controlled. Review `<cwd>/.omp/ob-memory.json` before running an untrusted checkout: it can change `redactSecrets`, `debugLog`, worker model selection, and resource budgets. The plugin does not prompt before applying that layer.

## Observer due clock

The observer runs when either the raw unobserved-source estimate or provider-reported context growth since the latest observation coverage (or compaction anchor) reaches `observeAfterTokens`. The provider clock catches content the character heuristic undercounts.

Before the first observation coverage and without a compaction, only the raw estimate is used: provider context at that point includes the system prompt and tools, which are not unobserved conversation. After the first coverage, `/ob-memory status` shows the provider delta separately.

After an empty observer run, the observer also waits for a coverage change or for progress beyond `max(1000, observeAfterTokens / 2)` past the empty-run watermark.

## Fields

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for all memory work, including manual `observe-now` passes. |
| `model` | string or object | session model | Worker model, e.g. `"openai/gpt-5.2"` or `{ "provider": "openai", "id": "gpt-5.2", "thinking": "low" }`. |
| `fallbackModel` | same | unset | Used only when the primary worker model cannot be resolved or authenticated. |
| `observeAfterTokens` | positive integer | `6000` | Raw unobserved source tokens that trigger an observer pass. |
| `reflectAfterTokens` | positive integer | `4000` | Active observation tokens that trigger a reflector pass. Clamped down to `observationsPoolMaxTokens`, so a valid dropper gate always exists. |
| `observerChunkMaxTokens` | positive integer | derived: 20% of the resolved worker model context window, minimum 256; `12000` when unknown | Maximum source chunk sent to one observer request; explicit values above 1,000,000 clamp. |
| `observationsPoolMaxTokens` | positive integer | `16000` | Active-observation pool size above which the dropper is considered. |
| `observationsPoolTargetTokens` | positive integer | `10000` | Soft target used to size dropper candidates. Clamped to the max. |
| `compactionSummaryMaxTokens` | positive integer | context window / 8, clamped 2k–16k | Rendered memory summary budget. |
| `compactionMaxRetainedTokens` | positive integer | max(4000, context window / 2) | Maximum raw tail retained when the observer is behind the cut. |
| `compactionCatchUpMaxChunks` | non-negative integer | `2` | Observer chunks attempted synchronously inside `session_before_compact`. `0` disables catch-up; values above 8 clamp. |
| `compactionCatchUpBudgetMs` | non-negative integer | `18000` | Wall-clock budget for synchronous catch-up, including up to 5s spent preempting a background consolidation that is still running; values above 25000 clamp. Keep below omp's 30s handler budget. |
| `workerMemoryMaxTokens` | positive integer | derived: 25% of the resolved worker model context window, minimum 256; `16000` when unknown | Prior memory attached to one worker request; explicit values above 1,000,000 clamp. |
| `agentMaxTurns` | positive integer | `8` | Maximum assistant turns in one worker tool loop; values above 32 clamp. |
| `agentMaxTokens` | positive integer | `4096` | Maximum worker output tokens per request. |
| `consolidateWhenIdle` | boolean | `true` | Suppress `turn_end` consolidation while the agent is not idle. Terminal `agent_end`, session start, and manual runs are still allowed. |
| `observeAttachments` | boolean | `false` | Include image mime-type metadata in source chunks. Image bytes are never sent. |
| `redactSecrets` | boolean | `true` | Redact credentials before worker input and storage. |
| `passive` | boolean | `false` | Disable automatic workers and compaction ownership. `/ob-memory passive` changes this for the session only. |
| `ownManualCompaction` | boolean | `true` | Allow custom summaries for `/compact`. |
| `ownAutoCompaction` | boolean | `true` | Allow custom summaries for threshold/idle/incomplete auto compaction. Overflow recovery always delegates. |
| `debugLog` | boolean | `false` | Write NDJSON diagnostics to `<agentDir>/ob-memory/debug/<sessionId>.ndjson`. |
| `showNotifications` | boolean | `true` | Show automatic warnings (config load, model-unavailable failures) via `ctx.ui.notify`. Other provider/tool failures are recorded in `/ob-memory status` and debug logs. Explicit `/ob-memory` output is always shown. |

## Environment variables

Use the upper-snake form with the `OB_MEMORY_` prefix:

```bash
OB_MEMORY_MODEL=openai/gpt-5.2
OB_MEMORY_FALLBACK_MODEL=anthropic/claude-sonnet-4-6
OB_MEMORY_OBSERVE_AFTER_TOKENS=8000
OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS=0
OB_MEMORY_DEBUG_LOG=true
OB_MEMORY_PASSIVE=true
```

Boolean env vars accept `true/false`, `1/0`, `yes/no`, `on/off`.

## Model choice

`model` and `fallbackModel` accept:

- `"provider/model-id"`
- `{ "provider": "...", "id": "...", "thinking": "off|minimal|low|medium|high|xhigh|max" }`

`thinking` is a hint; models without reasoning support simply omit it. Worker calls are capped by both `agentMaxTokens` and the model's catalog output cap.

## Derived worker budgets

`observerChunkMaxTokens` and `workerMemoryMaxTokens` are resolved per consolidation pass from the worker model actually selected for that pass — the configured `model`, the session model, or `fallbackModel` after a resolution failure. A fallback with a smaller context window therefore also shrinks the chunk and prior-memory caps, so a retry is never handed a prompt sized only for the larger primary.

Explicit values always win. When the model advertises no context window, the plugin keeps conservative fallbacks (`12000` for the chunk, `16000` for prior memory). The minimum of `256` prevents a tiny advertised window from producing a request that cannot carry source labels, an omission marker, and useful context.

These budgets do not resize `agentMaxTokens`. On a very small context window, lower `agentMaxTokens` explicitly so the system prompt, source chunk, prior memory, and output all fit.

## Compaction budgets

If `compactionSummaryMaxTokens` is unset, the budget is one eighth of the active model's context window, clamped to 2,000–16,000 tokens. If `compactionMaxRetainedTokens` is unset, it is half the context window with a 4,000-token floor. The custom compaction result is declined when the retained tail plus the summary would exceed that tail budget.

# Configuration

All fields are optional. Defaults are shown.

## Files and precedence

1. `<agentDir>/ob-memory.json`
2. `<cwd>/.omp/ob-memory.json`
3. `OB_MEMORY_*` environment variables

`agentDir` is omp's active agent directory (`~/.omp/agent` by default; profiles and `PI_CODING_AGENT_DIR` are respected). Later sources override earlier ones. Invalid values warn and fall back to the previous valid value.

Cross-field limits (`observationsPoolTargetTokens` and `reflectAfterTokens` may not exceed `observationsPoolMaxTokens`) and resource maximums are applied once, to the merged result, so a later source that raises a limit is never undercut by an earlier clamp. Each clamp warning names the source that last set the conflicting key. Numeric values given as strings must be plain decimal digits: blank, signed, hex, or exponent strings (for example an empty `OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS=`) are rejected with a warning instead of being read as `0`.

Project files are repository-controlled. Review `<cwd>/.omp/ob-memory.json` before running an untrusted checkout: it can change `redactSecrets`, `pauseOnHostSecrets` (`false` keeps workers sending requests that omp's Hide Secrets does not obfuscate), `showNotifications` (which also hides that warning; it still reaches the omp log and `/ob-memory status`), `enabled`/`passive`, `debugLog`, worker model selection, and resource budgets. The plugin does not prompt before applying that layer.

## Observer due clock

The observer runs when either the raw unobserved-source estimate or provider-reported context growth since the latest observation coverage (or compaction anchor) reaches `observeAfterTokens`. The provider clock catches content the character heuristic undercounts.

Before the first observation coverage and without a compaction, only the raw estimate is used: provider context at that point includes the system prompt and tools, which are not unobserved conversation. After the first coverage, `/ob-memory status` shows the provider delta separately.

When the observer finishes a chunk cleanly without recording anything, ob-memory appends a coverage-only `ob-memory.observations.recorded` entry (empty `observations`) so the same chunk is not sent again. A reply made without calling the tool counts as clean only when it is a short "nothing new" answer (at most 200 characters) that opens with a verdict: "Nothing new.", "No new observations.", "Observations: none.", "There is nothing new to record." or "All of this is already in memory.". A brief explanation may follow, on the same line or the next, only if it says why nothing is new (the chunk only repeats memory, is small talk or an acknowledgement) and adds no exception ("but…", "except…") and nothing that looks like observations or a tool call written as text. Verdict words inside a sentence about the conversation ("The user found no new information.") are not a verdict. The check is a heuristic that errs toward retrying: any other reply is treated as facts written as prose. If a run accepts nothing because every proposal was rejected, the output was truncated or hit `agentMaxTurns`, or the model answered in prose (or with no text) instead of calling the tool, the observer waits for a coverage change or for progress beyond `max(1000, observeAfterTokens / 2)` past that point, runs the observer on the same chunk at most 3 times (the first try plus 2 retries; each run is a tool loop of up to `agentMaxTurns` requests, and every request resends the chunk), and then skips it (recorded in the debug log) so progress is guaranteed. Neither this wait nor the attempt count carries over to another path after `/tree` navigation, or past a `/clear`. Older ob-memory versions ignore coverage-only entries and would re-observe those chunks.

A skipped chunk never enters memory, and compaction never treats it as observed. While it is still in model context (including entries omp replays after a provider-native compaction), compaction keeps it verbatim (moving the cut back) or delegates to native compaction, and compaction catch-up does not spend chunks on it. Once a native compaction has summarized it, ownership resumes, and every later owned summary carries that native summary forward under "Earlier compaction summary", because it is the only record of the skipped chunk. The carried text counts against `compactionSummaryMaxTokens`; if it would leave less than the fallback injection size for memory, compaction is delegated to native instead.

## Background passes

One pass observes one chunk. When a pass advances coverage and the observer is still due, ob-memory schedules a follow-up pass about 250 ms later, only while the session is idle and at most 8 per lifecycle trigger, so a backlog larger than one chunk drains without waiting for more turns. A trigger that finds another pass running retries up to 3 times, 1 s apart. Consolidation is also scheduled when a run settles while waiting for background jobs (`agent_end` with `awaitingAsyncWork`). A new agent run (`agent_start`) cancels a scheduled pass and aborts a running pass unless `consolidateWhenIdle` is `false`. A pass that started in an `awaitingAsyncWork` wait (the settle's own pass, or a follow-up draining its backlog) is left to finish when that wait ends: it began while the session idled, and aborting it would discard worker output already paid for. A compaction catch-up is still aborted.

After any reflector pass, automatic reflector and dropper passes wait until at least `max(1000, reflectAfterTokens / 2)` new observation tokens are recorded on the branch, so an unchanged pool is not reflected again. A `/clear` (including one made while a pass is running) or a move to another `/tree` path lifts this wait. If a dropper call that was due is aborted or fails, the next automatic pass retries the dropper alone while the pool is still over `observationsPoolMaxTokens`, without running the reflector again. A failed retry is recorded as the last error but does not fail its pass or start the failure backoff; after 3 failed dropper calls (aborts do not count) the retry stops and the next reflector pass runs the dropper again. `/ob-memory observe-now` bypasses this wait.

## `/clear`

Memory distilled from conversation before the latest `/clear` (omp's `reset_boundary`) is never sent to a model again: it is excluded from owned compaction summaries, from the context added to native compaction, from worker prompts, and from `ob_recall`, which reports the record as cleared. The records stay in the session file and are listed by `/ob-memory view full` for audit. Observation resumes after the boundary. A record written by 0.3.2 or earlier that mixes both sides of the boundary is cleared entirely, including its post-clear facts: an observation that cites any source entry from before the `/clear`, and a reflection supported by any cleared observation. Current versions never write such records.

## Fields

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for all memory work, including manual `observe-now` passes. |
| `model` | string or object | session model | Worker model, e.g. `"openai/gpt-5.2"` or `{ "provider": "openai", "id": "gpt-5.2", "thinking": "low" }`. |
| `fallbackModel` | same | unset | Used only when the primary worker model cannot be resolved or authenticated. |
| `observeAfterTokens` | positive integer | `6000` | Raw unobserved source tokens that trigger an observer pass. |
| `reflectAfterTokens` | positive integer | `4000` | Active observation tokens that trigger a reflector pass. Clamped down to `observationsPoolMaxTokens`, so a valid dropper gate always exists. |
| `observerChunkMaxTokens` | positive integer | derived: 20% of the resolved worker model context window, minimum 256; `12000` when unknown | Maximum source chunk sent to one observer request, measured with the session tokenizer (bytes/4 fallback); explicit values above 1,000,000 clamp. A chunk never separates a tool call from its first result; if the budget or the per-chunk entry cap runs out inside a tool run, the chunk ends before that run when the whole run fits one chunk; a run too large for one chunk is split between tool results instead, and the next chunk resumes mid-run. An entry is truncated (token-accurate) only when it, or a call plus its first result, alone exceeds the budget. |
| `observationsPoolMaxTokens` | positive integer | `16000` | Active-observation pool size above which the dropper is considered. |
| `observationsPoolTargetTokens` | positive integer | `10000` | Soft target used to size dropper candidates. Clamped to the max. |
| `compactionSummaryMaxTokens` | positive integer | context window / 8, clamped 2k–16k | Rendered memory summary budget. |
| `compactionMaxRetainedTokens` | positive integer | max(4000, context window / 2) | Upper bound for the raw tail retained when the observer is behind the cut. The effective budget is also capped by omp's post-compaction recovery band (see [Compaction budgets](#compaction-budgets)). |
| `compactionCatchUpMaxChunks` | non-negative integer | `2` | Observer chunks attempted synchronously inside `session_before_compact`. `0` disables catch-up; values above 8 clamp. Catch-up stops as soon as everything before the proposed cut is observed, and a worker error keeps chunks already recorded. |
| `compactionCatchUpBudgetMs` | non-negative integer | `18000` | Wall-clock budget for synchronous catch-up, including up to 5s spent preempting a background consolidation that is still running; values above 25000 clamp. Keep below omp's 30s handler budget. |
| `workerMemoryMaxTokens` | positive integer | derived: 25% of the resolved worker model context window, minimum 256; `16000` when unknown | Prior memory attached to one worker request; explicit values above 1,000,000 clamp. At least half is reserved for observations in reflector and dropper requests. |
| `agentMaxTurns` | positive integer | `8` | Maximum assistant turns in one worker tool loop; values above 32 clamp. |
| `agentMaxTokens` | positive integer, max 16384 | `4096` | Maximum worker output tokens per request. Values above 16,384 clamp with a warning. |
| `consolidateWhenIdle` | boolean | `true` | Suppress `turn_end` consolidation while the agent is not idle. Terminal `agent_end`, session start, and manual runs are still allowed. When `false`, a new agent run does not abort or cancel a running or scheduled pass. |
| `observeAttachments` | boolean | `false` | Include image mime-type metadata in source chunks. Image bytes are never sent. |
| `redactSecrets` | boolean | `true` | Redact credentials before worker input and storage. |
| `passive` | boolean | `false` | Disable automatic workers, compaction ownership, and the `session.compacting` memory context for native compactions; recorded memory stays in the ledger (`/ob-memory view full`, `ob_recall`). `/ob-memory passive` changes this for the session only. |
| `ownManualCompaction` | boolean | `true` | Allow custom summaries for `/compact`. |
| `ownAutoCompaction` | boolean | `true` | Allow custom summaries for threshold/idle/incomplete auto compaction. Overflow recovery always delegates. |
| `debugLog` | boolean | `false` | Write NDJSON diagnostics to `<agentDir>/ob-memory/debug/<sessionId>.ndjson`. |
| `showNotifications` | boolean | `true` | Show automatic warnings (config load, model-unavailable failures, the omp Hide Secrets pause, resume and warning) via `ctx.ui.notify`. Other provider/tool failures are recorded in `/ob-memory status` and debug logs. Explicit `/ob-memory` output is always shown. `/ob-memory status` always shows the Hide Secrets state, and the Hide Secrets pause and warning are also written to the omp log. |
| `pauseOnHostSecrets` | boolean | `true` | While omp's Hide Secrets (`secrets.enabled`) is detected, pause automatic memory passes for the session (the session goes `passive`), because worker requests cannot use omp's obfuscation. Like any passive session, compactions are then native and ob-memory supplies neither a summary nor `session.compacting` context, because omp does not obfuscate extension-supplied summarizer context either; memory recorded before the pause stays in the ledger (`/ob-memory view full`, `ob_recall`) and reaches compaction again once the pause lifts. Checked at session start, at agent, turn and tree events, before every automatic pass, each of its observer, reflector and dropper stages and every worker turn, before `/ob-memory observe-now`, and at compaction and each catch-up chunk, so Hide Secrets turned on mid-session is caught before the next worker request. Turning Hide Secrets off lifts the pause: passive returns to its earlier value, and an explicit `/ob-memory passive on` is kept. `/ob-memory passive off` overrides the pause for the session, with a warning. `/ob-memory observe-now` refuses while paused. `false` keeps workers running and warns once, the first time workers may run with Hide Secrets on (including a first `observe-now` in a passive session). |

## Environment variables

Use the upper-snake form with the `OB_MEMORY_` prefix:

```bash
OB_MEMORY_MODEL=openai/gpt-5.2
OB_MEMORY_FALLBACK_MODEL=anthropic/claude-sonnet-4-6
OB_MEMORY_OBSERVE_AFTER_TOKENS=8000
OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS=0
OB_MEMORY_DEBUG_LOG=true
OB_MEMORY_PASSIVE=true
OB_MEMORY_PAUSE_ON_HOST_SECRETS=false
```

Boolean env vars accept `true/false`, `1/0`, `yes/no`, `on/off`.

## Model choice

`model` and `fallbackModel` accept:

- `"provider/model-id"`
- `{ "provider": "...", "id": "...", "thinking": "off|minimal|low|medium|high|xhigh|max" }`

`thinking` is a hint; models without reasoning support simply omit it. Worker calls are capped by `agentMaxTokens`, by the model's catalog output cap, and by a hard 16,384-token ceiling. A model with no catalog cap is treated as 64k before that ceiling applies.

## Derived worker budgets

`observerChunkMaxTokens` and `workerMemoryMaxTokens` are resolved per consolidation pass from the worker model actually selected for that pass — the configured `model`, the session model, or `fallbackModel` after a resolution failure. A fallback with a smaller context window therefore also shrinks the chunk and prior-memory caps, so a retry is never handed a prompt sized only for the larger primary.

Explicit values always win. When the model advertises no context window, the plugin keeps conservative fallbacks (`12000` for the chunk, `16000` for prior memory). The minimum of `256` prevents a tiny advertised window from producing a request that cannot carry source labels, an omission marker, and useful context.

These budgets do not resize `agentMaxTokens`. On a very small context window, lower `agentMaxTokens` explicitly so the system prompt, source chunk, prior memory, and output all fit.

## Compaction budgets

If `compactionSummaryMaxTokens` is unset, the budget is one eighth of the active model's context window, clamped to 2,000–16,000 tokens. If `compactionMaxRetainedTokens` is unset, it is half the context window with a 4,000-token floor. When the observer is behind the cut, the retained tail plus the summary must fit both that budget and omp's post-compaction recovery band (80% of the active compaction threshold from `compaction.thresholdPercent`, `thresholdTokens`, or per-model limits) after the estimated system prompt and tool schemas. If the full summary does not fit, it is shrunk, with records about the compacted range first. If the room left is below the fallback injection size (one third of `compactionSummaryMaxTokens`, clamped to 1,000–3,000 tokens, and never more than `compactionSummaryMaxTokens`) and cannot hold every record about the compacted range, compaction is delegated to native.

When the observer has covered the cut, omp's own kept tail plus the summary is held to the check omp runs for that compaction: the band after threshold compactions, the window less the reserve after incomplete-turn retries (overflow recovery always delegates), and nothing after idle compactions or manual `/compact`. The summary is shrunk to fit and is never delegated for lack of room.

The fixed context is derived from omp's context usage, which counts everything before the latest assistant turn with usage plus the messages after it; that turn itself is not subtracted. The retained tail is measured the way omp measures it: whole messages, with images priced by the model's image rule, not the truncated worker-prompt rendering.

With omp's `compaction.experimentalContextManagement` (notes-backed rollover), catch-up is skipped and any running background consolidation is aborted, because omp cancels or skips a rollover whose branch leaf moved during the hook; the unobserved tail is retained or compaction is delegated.

## Async compaction

omp turns off its async (speculative) compaction (`compaction.asyncEnabled`) whenever an extension handles `session_before_compact`, so threshold compactions then block on building the summary. ob-memory registers that hook only once a main session binds with a config that can own compaction (`enabled`, not `passive`, and `ownAutoCompaction` or `ownManualCompaction`). With `enabled: false`, `passive: true` at session start, or both `own*Compaction: false`, omp's async compaction keeps working. `/ob-memory passive off` registers the hook, and it stays registered until omp reloads the extension.

`{ "ownAutoCompaction": false }` alone still registers the hook, because `/compact` ownership (`ownManualCompaction`, default `true`) needs it; set both to `false` to keep omp's async compaction. A session paused for omp Hide Secrets at start does not register the hook until `/ob-memory passive off`, or until Hide Secrets is turned off. `/ob-memory passive on` does not unregister it, because omp gives extensions no way to remove an event handler; the hook stays registered and delegates every compaction while passive, and no memory context is passed to the native summarizer.

# Changelog

## Unreleased

### Reflection condenser

- Reflections were append-only, and every budget that holds them keeps the newest records, so in long sessions the oldest reflections fell out of compaction summaries and worker prompts without notice (measured on real sessions: 18–25k reflection tokens against a 16k summary budget). A new condenser stage runs when the active reflection pool exceeds `reflectionsPoolMaxTokens` (default 7500): it merges overlapping reflections into one shorter line and retires obsolete ones, at most enough to reach `reflectionsPoolTargetTokens` (default 5500). Merged lines are distilled (decisions, reasons, constraints, preferences, outcomes, open work and the names needed to find the work stay; line-level detail and replaced history go), must cut at least a tenth of what they replace (the prompt asks for about half) cover one subject that each merge names without joining several (finished work is reduced to what was done, where to find it, and the decisions that still bind later work), may not use a path, file name, commit, code name, ticket number or long number that none of their sources mention, and stay under about 200 tokens (250 when merging already-merged lines), are condensed again only after every never-condensed reflection has been and only when those cannot supply the needed cut (then by tier, lowest first, so no line is distilled twice before every line of its tier had its turn), keep the union of their sources' supporting observations, and take the place of the oldest reflection they replace; a reflection supported by a critical observation is never retired. The newest reflections (up to 2,000 tokens) are never condensed, and the rest of the pool is shown beside each batch as read-only context so covered and superseded reflections can be retired.
- Each merge that passes the local rules is checked by one more worker request against the original reflections behind it; a merged line that binds a name to the wrong item, fuses separate facts, changes an order, cause or number, states a plan as done, or joins a fact about a separate subject is rejected with the finding so the condenser can correct it (a failed check accepts the merges). On replays of a real 236-reflection session, blind-judged line by line, this cut merged lines with a confirmed distortion from 28% (18 of 65 lines, two runs without the check) to 8% (6 of 75 lines, two runs of the final code) and lines that mix subjects from 23% to 16%, with no change in how much of the oldest third reaches the summary, at about twice the condenser tokens and two to three times its time; a shorter session whose lines were merged at most twice showed no difference (about 4% either way). `condenserCheck: false` skips the check.
- A run is one `ob-memory.reflections.condensed` entry: replacements and retirements apply together, at the tip, like observation drops. Retired reflections stay in the session file; `ob_recall` reports them as retired and names the reflection they were merged into, and shows `condensed from` for a merged one. Older versions ignore the entry.
- One condenser call handles one batch of at most 3,000 reflection tokens in at most 4 model turns, and a pass skips it while the observer still has a backlog, so a large pool shrinks over several short passes (with idle follow-ups) instead of one long call that a new agent run would abort. A call that failed, changed nothing, or shrank the pool by less than 200 tokens makes automatic calls wait for new reflections; a failure is recorded without failing the pass. `/ob-memory status` shows active and retired reflections, the reflection pool against its budget, and the last condenser run; `/ob-memory observe-now` reports condensed reflections.

## 0.4.1

### Commands

- `/ob-memory view` and `/ob-memory view full` cap the interactive buffer at the newest 120 and 240 lines, with an omission count in the header and a note at the end of the buffer. The TUI editor lays out its whole buffer on every frame, so a large ledger made scrolling and typing slow (measured ~15 ms/frame at 280 lines and ~90 ms/frame at 1726 lines); `ob_recall` and the session file still hold every record.

## 0.4.0

### Privacy and redaction

- omp Hide Secrets: worker requests cannot use omp's obfuscation, so while it is detected ob-memory now pauses automatic memory passes for the session by default (new `pauseOnHostSecrets`, env `OB_MEMORY_PAUSE_ON_HOST_SECRETS`). While paused, as in any passive session, ob-memory owns no compaction and supplies no `session.compacting` context, which omp would also send unobfuscated. It is re-checked before every automatic pass, each of its observer, reflector and dropper stages, every worker turn and each compaction catch-up chunk, so a mid-session switch is caught before the next worker request; turning Hide Secrets off lifts the pause, `/ob-memory passive off` overrides it for the session, and `/ob-memory observe-now` refuses while paused. The state is shown in `/ob-memory status`. For headless sessions a pause or lift is written to the omp log, and the state at session start is recorded in the `session_bind` lifecycle entry. With `pauseOnHostSecrets: false` ob-memory warns once instead.
- Redaction engine reworked. An assignment whose key is not sensitive no longer swallows its value, so secrets inside JSON tool-call arguments and URL query strings are found. A match never crosses a line break (JSON `\n` escapes included), so a `getpass("Password: ")` prompt can no longer erase the source entries after it. Sensitive keys are detected per word (`SecretAccessKey`, `clientSecret`, `X-Api-Key`, `LABEL_STUDIO_API_KEY` match; `maxTokens`, `tokenizer`, `TOKEN_PREFIX`, `password_file` do not); a bare `auth:` key counts only with a credential-shaped value.
- Private keys: PGP armor, blocks whose BEGIN or END line was truncated away, keys printed on one line (`echo $KEY`, a list of lines, inside a JSON-escaped tool call), lines decorated by `cat -A`/`cat -n`/`grep -n`, and blocks over 32 KiB are redacted.
- Line-start values: dotenv `KEY=value` lines (also in `cat -n`/`grep -n` output, written file contents and quoted shell strings) are redacted whole with no word limit; YAML values and block scalars are covered. A Title-case prose label (`- Token: 15 minute access tokens`) keeps its phrase: only the label and the value's first word are redacted. `Basic`/`Digest`/`Bearer` prose ("basic authentication", "basic GitHub/GitLab support"), modern TypeScript, Rust imports and Docker bind mounts are left alone, while literal secrets that merely start like code (`New-Hire-2024!`, `Hunter::Two`, single-quoted `$…`) are redacted. All passes run in linear time.
- Source entries are redacted before they are truncated to a chunk, catch-up or recall budget, so a cut can no longer split a private key into pieces the patterns miss.
- Content that imitates a source label or role header is escaped before it reaches a worker, robust to invisible, control and look-alike characters and re-checked after every truncation; the worker prompts state that source and memory text are untrusted data.
- Config-load warnings are redacted before they are shown.

### /clear and message roles

- Memory distilled before the latest `/clear` (`reset_boundary`) is no longer sent to any model: owned compaction summaries, native-compaction context, worker prompts and `ob_recall` (which reports the record as cleared). The records stay in the session file and in `/ob-memory view full`. Records written by 0.3.2 or earlier that mix both sides of the boundary are cleared entirely.
- Observation, the raw token clock, the reflection gate, the empty-run backoff and the attempt counter restart after a `/clear`, including one made while a pass is running.
- `/ob-memory view` says records were cleared by `/clear` instead of blaming a native compaction.
- User shell commands (`!cmd`), Python (`$ code`) and `@file` mentions are observed in the same form omp sends them to the main model; executions excluded from context (`!!`, `$$`) are skipped.

### Observer liveness and scheduling

- A chunk with nothing worth recording gets a coverage-only `ob-memory.observations.recorded` entry (empty `observations`), so it is not re-sent forever. Older ob-memory versions ignore coverage-only entries.
- A reply without a tool call counts as "nothing new" only when it opens with a verdict ("Nothing new.", "There is nothing new to record.") and any explanation only says why nothing is new, without an exception. A one-line fact in prose (even one that contains "no new information" or "already in memory"), JSON-looking text or an empty reply is retried, so compaction does not summarize away a chunk the model only described in prose. An unproductive chunk is tried at most 3 times (2 retries) and then skipped; the attempt count does not carry across `/tree` paths.
- A backlog larger than one chunk drains through bounded follow-up passes while the session is idle; a trigger that finds a pass running retries. A tool run too large for one chunk is split between tool results instead of costing an extra prefix-only chunk.
- Keyless local providers (`"N/A"` auth sentinel: Ollama, LM Studio, llama.cpp) can be used as worker models.
- After a reflector pass, automatic reflector and dropper passes wait for enough new observation tokens instead of re-reflecting an unchanged pool; an aborted or failed dropper call is retried alone. A failed retry does not fail its pass or start the failure backoff, and after 3 failed dropper calls the retry waits for the next reflector pass.
- Accepted records are kept when a later worker turn fails. Worker tool results report per-item rejection reasons.
- `agent_start` no longer aborts a running pass when `consolidateWhenIdle` is `false`. Consolidation is also scheduled when a run settles waiting for background jobs, and a pass started in that wait (or a follow-up draining its backlog) is left to finish.

### Compaction

- Owned compactions are sized to the check omp runs afterwards: the post-compaction recovery band (80% of the compaction threshold, after the estimated system prompt and tool schemas) after threshold compactions, the window less omp's budget reserve after incomplete-turn retries. A summary that does not fit is shrunk, listing records about the compacted range first; a retained unobserved tail that cannot fit is delegated. The tail is measured like omp measures it, images included, and the fixed-context estimate no longer subtracts the latest assistant turn.
- A chunk the observer skipped after repeated failures is never treated as observed while it is in context: it is retained or compaction is delegated. Once a native compaction has summarized it, owned compactions carry that summary forward.
- Catch-up keeps chunks it already recorded when a later chunk fails, and stops once everything before the cut is observed.
- With omp's experimental context management (notes-backed rollover), ob-memory appends nothing inside `session_before_compact` and aborts background passes, since omp cancels a rollover whose leaf moved.
- `session.compacting` no longer drops memory context on a host method-fallback retry, and handles rollover-wrapped compaction details.
- `session_before_compact` is registered only when a session can actually own compaction, so omp's async compaction keeps working with `enabled: false`, `passive: true`, or both `own*Compaction: false`.

### Config and commands

- Cross-field and resource clamps are applied once to the merged config, naming the source in the warning. Numeric strings must be plain decimal digits; blank, signed, hex and exponent strings are rejected instead of being read as `0`.
- `agentMaxTokens` is capped at 16,384.
- `/ob-memory passive on` cancels the scheduled pass and aborts the running one.
- `/ob-memory config` reports the worker model actually selected (`workerModelSource`).
- `/ob-memory view` explains an empty view after a native compaction.
- `ob_recall` is declared a read-only tool.
- `createObMemory({ agentDir, env })` factory for embedding hosts and tests; the default export is unchanged.

## 0.3.2

- Redaction masks passwords in URL userinfo (`scheme://user:pass@host`, including an empty user) and short values of sensitive keys (`password=abc`).
- Failure backoff now actually reaches its 5 minute cap instead of stopping at 64 s.
- Compaction catch-up preempts an in-flight background consolidation (bounded wait inside the catch-up budget) instead of skipping catch-up while that pass keeps calling the worker model and appending entries.
- Documented that the dropper may run after a reflection pass that produced nothing; its local guards still protect critical and uncovered high records.

## 0.3.1

- Redaction now recognizes unquoted `Authorization`/`Proxy-Authorization`/`X-Auth-Token` headers with `Bearer`, `Basic`, `Digest`, or `Token` schemes, and runs header/token patterns before assignment redaction.
- Observer output truncated by `stopReason: "length"` is treated as partial coverage, so the watermark only advances through cited source ids.
- `consolidateWhenIdle: false` now actually permits `turn_end` scheduling while the agent is busy.
- `reflectAfterTokens` is clamped to `observationsPoolMaxTokens`; agent turns, worker memory/chunk budgets, and catch-up work gain upper limits.
- Catch-up enforces its wall-clock budget on in-flight worker calls and does not apply failure backoff when the compaction signal cancels work.
- `visibleProjection` no longer presents an older memory compaction after a newer native compaction.
- `/ob-memory config` reports derived effective budgets and active models; `/ob-memory view` redacts rendered output.
- Docs: corrected development load command, native compaction injection limits, dropper safety, notifications, worker prompt contents, and AGENTS lifecycle claims.

## 0.3.0

- `observerChunkMaxTokens` and `workerMemoryMaxTokens` are now optional and default to 20% / 25% of the resolved memory model context window (minimum 256; `12000` / `16000` when the window is unknown). Explicit values still win, and a smaller `fallbackModel` window caps both budgets.
- Observer due detection now also uses provider-reported context growth since the latest observation coverage or compaction anchor. `/ob-memory status` reports that provider clock separately; before the first coverage and when no trustworthy baseline exists, the raw token estimate remains authoritative.
- Compaction now folds memory through the observation coverage marker when the observer is ahead of omp's retention boundary. Observations recorded past the cut are no longer dropped from the summary, which previously forced a native fallback.

## 0.2.0

- `/ob-memory` now offers argument completions in the TUI: subcommands on the first token, `view full` once a tail prefix is typed, and `passive on|off` immediately.
- Added repository guidelines in `AGENTS.md`, including the Plane tracking workflow.

## 0.1.1

- Fixed observer coverage advancing past an entry that was omitted from an over-budget chunk (tool-pair overflow). Every selected entry is now serialized, with per-entry truncation when needed.
- Fixed compaction summaries resurrecting observations whose drop tombstone carried a coverage watermark past the proposed cut; tombstones now apply at the tip.
- Catch-up now runs whenever the observer is behind the proposed cut, including when the first cut resolution would delegate.
- A moved compaction cut can no longer land before the latest `/clear` (`reset_boundary`), which would have reintroduced cleared turns into model context.
- Fixed duplicate observation/reflection proposals being stored under nonce ids instead of being skipped; duplicates are now detected by content, timestamp, and source/support ids.
- Bounded reflector and dropper prompts to `workerMemoryMaxTokens`; worker tools now accept support/drop ids only from the context that was actually sent.
- Chunking now starts after an already-covered tool-result run instead of re-sending the same covered prefix, so long parallel tool batches make progress; chunks also cap their entry count and truncation no longer re-appends the whole original text when the cap is tiny.
- Trigger accounting now counts every unobserved source token, including a gap before the latest compaction; previously it could report zero while `/ob-memory status` showed a large unobserved tail.
- When a worker hits `agentMaxTurns` mid-chunk, observer coverage now advances only through the source ids the accepted observations actually cite instead of claiming the entire chunk.
- The dropper now runs after a reflection pass that legitimately finds nothing new, so the active-observation pool can still be reduced instead of waiting for a future durable fact.
- A busy consolidation pass is no longer mislabeled `"failed"` because of an unrelated earlier error.
- `ob_recall` now truncates an oversized single source entry to its token cap and exposes budget-omitted resolved source ids separately.
- `/ob-memory view full` now renders the whole branch ledger without a summary budget (the TUI editor can scroll it).
- Renderer omission text no longer calls skipped newest records "older".
- Redaction now catches `AWS_SECRET_ACCESS_KEY`-style assignments and common Stripe/GitLab/PyPI/npm/Hugging Face token prefixes; `/ob-memory status`, automatic notifications, and recall output are redacted when `redactSecrets` is enabled.
- `showNotifications` now gates automatic config warnings; explicit command output is unaffected.
- Worker loops and append paths now honor an abort before executing tools or writing ledger records; tree navigation aborts in-flight workers like branching already did.
- Updated install instructions for the public GitHub repository.

## 0.1.0

Initial implementation.

- Branch-local observation/reflection/drop ledger stored as omp custom session entries.
- Observer, reflector, and dropper workers with local schema validation and deterministic ids.
- Deterministic memory renderer with observation-weighted token budgeting.
- Source-addressed serialization and tool-pair-safe chunking.
- Custom `session_before_compact` result with coverage-aware ownership, bounded catch-up, and unobserved-tail retention.
- `session.compacting` fallback context injection for native summaries.
- `ob_recall` exact-id provenance tool.
- `/ob-memory` view, status, config, passive, and observe-now commands.
- Config files plus `OB_MEMORY_*` overrides, credential redaction, and optional NDJSON diagnostics.
- Extension lifecycle metadata reports the package version.
- Unit/integration tests, extension factory smoke test, and a fold/render benchmark.

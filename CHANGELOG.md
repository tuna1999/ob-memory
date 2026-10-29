# Changelog

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

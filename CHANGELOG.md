# Changelog

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
- Unit/integration tests, extension factory smoke test, and a fold/render benchmark.

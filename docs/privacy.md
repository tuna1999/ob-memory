# Privacy and data flow

ob-memory runs in-process inside omp. It uses the configured model provider for worker calls; it has no server, no telemetry endpoint, and no separate database.

## What leaves the process

Only worker model requests:

- the worker system prompt;
- bounded prior memory (reflections and active observations);
- one bounded source chunk with source entry ids and message/tool output text;
- model/thinking configuration required by the provider.

The active session's main model already receives the conversation. Worker requests are separate calls to the model configured by `model` or the session model.

## Redaction

With `redactSecrets: true` (default), the plugin applies best-effort pattern redaction before:

- observer/reflector/dropper prompts;
- stored observation and reflection content;
- compaction summaries and fallback context;
- `ob_recall` output;
- debug log fields.

Patterns cover common API keys, bearer tokens, private-key blocks, AWS access keys, GitHub tokens, Google keys, Slack tokens, and `password`/`secret`/`token` assignments. Object keys such as `apiKey`, `authorization`, and `credential` are replaced wholesale in debug structures, while numeric fields such as `tokenCount` are preserved.

Redaction is not encryption and cannot guarantee that every credential shape is caught. Treat debug logs and session journals as sensitive. Do not enable `debugLog` in an environment where its metadata is not acceptable.

## Attachments

Images and other non-text blocks are represented as `[image omitted]` by default. `observeAttachments: true` adds only `[image: <mime-type>]`; image bytes are never included in a worker prompt or observation.

## Storage

Ledger entries live in the omp session JSONL alongside the conversation. Debug logs, when enabled, live under:

```text
<agentDir>/ob-memory/debug/<sessionId>.ndjson
```

They contain timestamps, stages, redacted fields, usage counters, and errors. They are not part of the model context.

## Retention and deletion

Dropping an observation appends a tombstone entry. It removes the record from active compacted memory but does not delete the original session entry or source evidence; `ob_recall` can still resolve it. To erase history, use the host's session deletion facilities.

Compaction details store the records that were rendered into the summary so the visible projection can be reconstructed without rescanning the full ledger.

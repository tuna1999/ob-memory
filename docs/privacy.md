# Privacy and data flow

ob-memory runs in-process inside omp. It uses the configured model provider for worker calls; it has no server, no telemetry endpoint, and no separate database.

## What leaves the process

Only worker model requests:

- the worker system prompt;
- bounded prior memory (reflections and active observations);
- one bounded source chunk with source entry ids, message/tool output text, tool-call arguments, thinking blocks (where the host persisted them), and other extensions' `custom_message` content;
- user-run shell commands (`!cmd`), Python (`$ code`) and `@file` mentions, in the same form omp sends them to the main model: the command or code with its output (and exit code), and `<file path=…>` with the file contents. Executions excluded from context (`!!`, `$$`) are never sent;
- model/thinking configuration required by the provider.

The active session's main model already receives the conversation, except that omp's Hide Secrets (`secrets.enabled`) replaces configured secrets with placeholders in omp's own requests (see below). Worker requests are separate calls to the model configured by `model` or the session model.

Source text is untrusted data, not instructions. Content that could pass for a source label (`[Source entry id: …]`) or a role header (`[User @ …]:`) gets a backslash before its bracket before it reaches a worker. This applies to any line whose first visible character is `[` and that looks like a bracketed label (a `]` followed by `:` or the end of the line, or a `:`/`@` inside the brackets), and to `[Source entry id` and header-like `[… @ …]:` sequences anywhere in a line. Matching ignores zero-width, control and other invisible characters, sees through terminal color codes, and folds compatibility forms (fullwidth brackets and colons, NBSP or ideographic-space indentation). The serializer's own placeholders (`[thinking: …]`, `[tool call …]`, `[image: …]`) are checked again as a whole, tool names and MIME types are kept on one line, and the text kept on both sides of every truncation is checked again. The observer, reflector and dropper prompts state that chunk and memory text are data, never instructions, and that only genuine user entries can establish user preferences. The worker only has a constrained record tool and validates all proposed source ids locally.

### omp Hide Secrets

omp applies its secret obfuscation only to requests it sends itself; extensions cannot use that obfuscator. ob-memory worker requests would therefore carry the conversation text filtered only by ob-memory's `redactSecrets` patterns. A bare secret value that matches none of them (for example a literal from `secrets.yml` printed by a tool) could reach the worker model and be copied into stored observations.

So while Hide Secrets is detected, ob-memory pauses its automatic memory passes for the session (`pauseOnHostSecrets`, default `true`) and warns. While paused, ob-memory also stops supplying memory to compaction: it owns no compaction and adds no `session.compacting` context (omp passes that context to its summarizer without obfuscation), so native compactions summarize without the ledger until the pause lifts. Detection runs at session start, at agent, turn and tree events, before every automatic pass, each of its observer, reflector and dropper stages and every worker turn, and at compaction and each catch-up chunk, so Hide Secrets turned on mid-session is caught before the next worker request; a request already sent at that moment still completes. `/ob-memory observe-now` refuses while paused. `/ob-memory passive off` resumes passes for that session after warning that worker requests are not obfuscated, and the session is not paused again. Turning Hide Secrets off lifts the pause.

`/ob-memory status` always shows whether Hide Secrets is on, off or unknown, and the pause state, including with `showNotifications: false`. Without a UI, a pause and its lift are written to the omp log, and to the debug log when `debugLog` is on. The `hostSecrets` field of the session's `ob-memory.lifecycle` `session_bind` entry records the state only at the moment ob-memory bound the session (start, resume, switch, branch); a pause that starts or ends later, or a `/ob-memory passive off` override, adds no session entry. To always run workers with only ob-memory's own redaction, set `pauseOnHostSecrets: false` (a repository's `<cwd>/.omp/ob-memory.json` can set it too; see [Files and precedence](config.md#files-and-precedence)); ob-memory then warns once, when workers first may run with Hide Secrets on (at start, after `/ob-memory passive off`, or before a first `/ob-memory observe-now`). Detection reads omp's system prompt, which documents the placeholder grammar only while obfuscation is active.

## Redaction

With `redactSecrets: true` (default), the plugin applies best-effort pattern redaction before the following. Each source entry is redacted before it is truncated to a per-entry, chunk or recall budget, so truncation cannot split a private-key block into halves the patterns no longer match.

- observer/reflector/dropper prompts;
- stored observation and reflection content;
- compaction summaries and fallback context;
- `ob_recall` output;
- `/ob-memory view` and `/ob-memory status` output;
- automatic notifications;
- debug log fields.

Patterns cover common API keys and vendor token prefixes (Stripe, GitHub, GitLab, PyPI, npm, Hugging Face, Google, Slack), AWS access keys, `Authorization` headers, `Basic`/`Bearer` credentials (only credential-shaped tokens, so prose such as "basic authentication" or "basic GitHub/GitLab support" is kept), URL userinfo passwords, and private-key blocks (PEM, OpenSSH, PGP armor). Private-key coverage includes blocks whose BEGIN or END line was cut off by truncation; keys printed on one line (`echo $KEY`, a list of the key's lines, a key inside a JSON-escaped tool call, a line cut at the host's 512-column limit); lines decorated by `cat -A`, `cat -n`/`nl`, `grep -n` or `> `; and blocks larger than 32 KiB.

Assignments are redacted when the key names a secret.

- **Keys.** Keys are split at `_`, `-`, `.` and camelCase boundaries, so `password`, `DB_PASSWORD`, `clientSecret`, `SecretAccessKey`, `X-Api-Key`, `GITHUB_TOKEN` and `LABEL_STUDIO_API_KEY` match while `tokenCount`, `maxTokens`, `max_token`, `password_file`, `secret_name`, `TOKEN_PREFIX`, `PASSWORD_RE` and `tokenizer` do not. A metadata word such as `count`, `file`, `name`, `url`, `prefix`, `pattern` or `score` exempts a key when it follows the secret word (`token_count`, `password_file`); before the secret word it is part of the name, so `file_password` and `name_token` still match. Separately, a quantity word (`max`, `min`, `num`, `total`, `count`) directly before a secret word marks a number, so `max_token`, `MIN_PASSWORD_LENGTH`, `TOTAL_SECRET` and `COUNT_PASSWORD` are not redacted (`max_api_key` and `TOTAL_DB_PASSWORD` still are). A bare `auth` key counts only when its value is credential-shaped (Docker's `"auth": "<base64>"`), and `_auth` (npm) always counts. A key longer than 64 characters counts only when a secret word is among its last three words, and a key longer than 128 characters is judged by its trailing segments. A path component directly followed by `:` (`~/.aws/credentials:/root/.aws/credentials:ro`) and a Rust path (`use crate::token::{…}`) are not keys. Assignments are also found inside JSON tool-call arguments and URL query strings.
- **Value extent.** A redacted value never extends past the end of its line, so one match cannot erase neighbouring source entries; the only exception is the indented lines of a YAML block scalar. An unquoted value normally ends at whitespace. It runs further when:
  1. `KEY=value` or `export KEY=value` sits at the start of a line: redacted to the end of the line with no word limit, stopping at a ` #` comment. A line start is a line break, the start of a source entry, indentation, a list bullet, a diff `+`, a `cat -n`, `N|` or `N:` line number, a `grep -n` `path:N:` prefix, or the start of a JSON string value such as a written file's content. In a JSON field that holds a shell command (`command`, `cmd`, `script`), `VAR=value cmd` keeps shell semantics and only the value's first word is redacted.
  2. A `KEY=value` opens a quoted string (`echo 'SMTP_PASSWORD=a b c' >> .env`): redacted to the closing quote or the end of the line.
  3. A line-start `key: value` has a compound or upper-case key (`db_password:`, `DB_PASSWORD:`, `clientSecret:`): redacted to the end of the line (or ` #`). A single lowercase word (`password:`) is redacted to the end of the line only for values of up to 6 words. A Title-case label followed by a lowercase phrase (`Token: 15 minute access tokens`, `- Password: bcrypt with cost 12`) keeps the phrase: the label and the value's first word become `[REDACTED CREDENTIAL]`.
  4. In cases 1 and 3, a value that contains an expression operator between spaces (`??`, `||`, `&&`, `==`, `===`, `!=`, `!==`, `=>`, or a ternary `?`) is code, and only its first word is redacted (`PASSWORD=x && ./run` keeps `&& ./run`).
  5. A YAML block scalar (`password: |`, `>-`, `!vault |`) also redacts the following lines that are indented deeper than the key, up to 32 lines. Indentation is measured after any line-number, `grep` or diff prefix on the key's line; a line without that prefix ends the block, and a list bullet before the key counts as indentation.
- **Code and placeholders.** Values that look like code or placeholders are not treated as secrets: `true` and `null`; a type name or keyword followed by code (`string`, `Optional[str]`, `int?`, `new Token()`); `$VAR`, `${VAR}` and `${{ secrets.X }}` when unquoted or double-quoted in shell or YAML (not in JSON string values or single quotes); configuration lookups (`os.environ[...]`, `process.env.X`, `self.token`, `this.#token`, `options.apiKey?.trim()`), also when more code follows (`this.config.token ?? null`); identifier calls with a matching `)` or whose arguments continue on the next line (`get_token()`, `register({`); array literals and spreads (`[a, b]`, `[...keys]`); arrow functions (at a line start only with a parameter list such as `()`, `(a, b)` or `(token: string)`, so `PASSWORD=(Xy9!kq)=>x` is still a secret) and, except at a line start, parenthesized expressions; Rust paths that start at a module root or are followed by punctuation (`std::env::VAR`, `Token::Ident,`), but never in a dotenv line or quoted shell assignment; and structures or templates (`{`, `{{ var }}`, `{name}`). A literal such as `New-Hire-2024!`, `Str.0ng.Pass`, `Hunter::Two`, `(Xy9!kq)` or `[Xy9!kq]` is redacted even though it starts like code, and a multi-word value whose first word is a keyword (`MAIL_PASSWORD=new secret phrase`) is redacted whole unless the rest looks like code.
- **Structures.** Object keys are matched the same way and replaced wholesale in debug structures, while numeric fields such as `tokenCount` are preserved.

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

Compaction details store the records that were rendered into the summary so the visible projection can be reconstructed without rescanning the full ledger. When a chunk the observer skipped has left model context, owned compaction details also store `carriedSummary`, a copy of the earlier compaction summary (redacted when `redactSecrets` is on); the same text appears in the compaction summary shown to the model.

After `/clear`, records distilled from earlier conversation are no longer sent to any model (compaction summaries, native-compaction context, worker prompts, `ob_recall`), but they remain in the session file and in `/ob-memory view full`. Records written by 0.3.2 or earlier that mix pre- and post-clear content (an observation citing any pre-clear source entry, or a reflection supported by any cleared observation) are cleared entirely.

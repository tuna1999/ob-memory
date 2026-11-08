import { MAX_SOURCE_ENTRY_CHARS, estimateTextTokens } from "../constants";
import { redactText } from "../security/redact";
import { formatLocalTimestamp, parseTimestamp } from "../util/time";
import type { TokenEstimator } from "../util/tokens";
import { latestResetBoundaryIndex } from "./fold";
import { isSourceEntry, type LedgerEntry } from "./types";

export interface SerializedEntryOptions {
	observeAttachments?: boolean;
	/**
	 * Redact secrets in each entry body before any truncation. Redacting only
	 * the assembled prompt is not enough: a cut can drop one marker of a
	 * multi-line secret (a PEM block) and leave the rest unmatched.
	 */
	redact?: boolean;
}

interface ContentBlock {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	mimeType?: unknown;
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is ContentBlock => !!block && typeof block === "object");
}

// Entry content is untrusted (tool output, files, pasted text). It must not
// be able to forge a `[Source entry id: …]` block or a `[User @ …]:` header
// that a worker could mistake for a genuine entry. Genuine labels always
// start a line with a bare ASCII `[`, so content that could pass for one gets
// a backslash before its bracket:
//   - a line whose first visible character is `[` and that has a bracketed
//     token closed by `]` followed by `:` or the end of the line, or a `:` or
//     `@` before its first `]` (any label shape, including look-alike
//     letters such as a Cyrillic "Ѕ"); terminal color codes before the label
//     (`ESC[0m`) do not move it off the line start;
//   - anywhere in a line, `[Source entry id` and `[<…@…>]:` or `[<role>]:`.
// Matching runs on a view of the text without invisible characters (format,
// default-ignorable, combining marks, and control characters other than tab
// and line breaks) and with every character NFKC-normalized, so zero-width or
// control characters, NBSP or ideographic-space indentation and fullwidth
// brackets or colons are seen through. Every character a model may read as a
// line break starts a line. Escaping is idempotent. Untrusted strings are
// neutralized where they enter an entry body, and each placeholder this
// module writes around them (`[thinking: …]`) is neutralized again as a
// whole, so its closing `]` takes part in matching while its own opening
// bracket stays bare. Fields that must stay on one line (tool names, MIME
// types) lose their line breaks, and a block type is embedded only when it is
// a plain token. Every truncation re-neutralizes the text around its cut,
// because a cut can turn mid-line text into a line start or drop an escaping
// backslash.

/** Characters that render as nothing; removed from the matching view. */
const HIDDEN_CHAR = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/u;
/** Control characters other than tab and the line breaks; they render as nothing too. */
const HIDDEN_CONTROL = /[\x00-\x08\x0e-\x1f\x7f-\x84\x86-\x9f]/;
/** Line breaks other than `\n` that a model may read as one. */
const OTHER_LINE_BREAK = /[\v\f\r\u0085\u2028\u2029]/;
const ANY_LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;
/**
 * The only characters whose matching view contains `[` (`[` and the
 * characters NFKC maps to it). Every rule needs one, and normalization of
 * assigned characters is stable across Unicode versions.
 */
const BRACKET_LIKE = /[[\uFE47\uFF3B]/;
/**
 * Text without these characters (ASCII without controls other than tab and
 * `\n`) is its own matching view.
 */
const NEEDS_VIEW = /[\x00-\x08\x0b-\x1f\x7f-\uffff]/;
/** First visible character of a line is a bracket (blank-looking indentation allowed). */
const LINE_START_BRACKET = /^(?:[^\S\n]|\u2800)*\[/gm;
/**
 * What a terminal control sequence (`ESC[0m`) leaves in the matching view
 * once its ESC is hidden. It renders as nothing, so it neither moves a label
 * off the start of its line nor separates a `]` from its `:`. Its final
 * character is never a bracket, which keeps every rule below linear.
 */
const CONTROL_SEQUENCE = String.raw`\[[0-?]*[ -/]*[@-Z\\^-~]`;
/** A control sequence and the blank-looking characters after it. Sticky: matches at `lastIndex` only. */
const CONTROL_SEQUENCE_AT = new RegExp(String.raw`${CONTROL_SEQUENCE}(?:[^\S\n]|\u2800)*`, "y");
/** Rest of a line after its leading `[` that makes it label-like. */
const LABEL_REST = new RegExp(String.raw`\](?:\s|${CONTROL_SEQUENCE})*(?::|$)|^[^\]]*[:@]`);
const SOURCE_LABEL = /\[\s*source\s+entry\s+id/gi;
const HEADER_LIKE = new RegExp(String.raw`\[([^[\]\n]{1,200})\](?:\s|${CONTROL_SEQUENCE})*:`, "g");
const ROLE_WORD = /^\s*(?:user|assistant|system|developer|tool result|custom message|branch summary)\b/i;

/**
 * `text` as label matching sees it, with `origin[k]` the index in `text` of
 * the character that produced view character `k` (identity when omitted).
 */
function matchView(text: string): { view: string; origin?: number[] } {
	if (!NEEDS_VIEW.test(text)) return { view: text };
	const mapped = new Map<number, string>();
	const parts: string[] = [];
	const origin: number[] = [];
	for (let i = 0; i < text.length; ) {
		const code = text.codePointAt(i)!;
		const width = code > 0xffff ? 2 : 1;
		let view = mapped.get(code);
		if (view === undefined) {
			const char = text.slice(i, i + width);
			if (OTHER_LINE_BREAK.test(char)) view = "\n";
			else if (HIDDEN_CONTROL.test(char)) view = "";
			else if (code < 0x80) view = char;
			else view = HIDDEN_CHAR.test(char) ? "" : char.normalize("NFKC");
			mapped.set(code, view);
		}
		for (let k = 0; k < view.length; k++) origin.push(i);
		parts.push(view);
		i += width;
	}
	return { view: parts.join(""), origin };
}

/**
 * Escape every bracket in `text` that could pass for a genuine source label
 * or role header (see above). The start of `text` counts as a line start.
 * With `ownOpener`, the bracket at index 0 opens a placeholder this module
 * wrote and fixed text follows it, so it is exempt from the line-start rule;
 * the rules that apply anywhere in a line still escape it.
 */
function escapeLabels(text: string, ownOpener: boolean): string {
	if (!BRACKET_LIKE.test(text)) return text;
	const { view, origin } = matchView(text);
	const at = (index: number): number => (origin ? origin[index]! : index);
	const escapes = new Set<number>();
	const labelLike = (bracket: number, end: number): boolean => LABEL_REST.test(view.slice(bracket + 1, end));
	for (const match of view.matchAll(LINE_START_BRACKET)) {
		const first = (match.index ?? 0) + match[0].length - 1;
		const lineEnd = view.indexOf("\n", first);
		const end = lineEnd < 0 ? view.length : lineEnd;
		if (!(ownOpener && at(first) === 0) && labelLike(first, end)) escapes.add(at(first));
		// A bracket after a chain of terminal control sequences starts the
		// line too (no line break can occur inside the chain).
		let bracket = first;
		CONTROL_SEQUENCE_AT.lastIndex = first;
		while (CONTROL_SEQUENCE_AT.test(view) && view[CONTROL_SEQUENCE_AT.lastIndex] === "[") {
			bracket = CONTROL_SEQUENCE_AT.lastIndex;
		}
		if (bracket !== first && labelLike(bracket, end)) escapes.add(at(bracket));
	}
	for (const match of view.matchAll(SOURCE_LABEL)) escapes.add(at(match.index ?? 0));
	for (const match of view.matchAll(HEADER_LIKE)) {
		const inner = match[1]!;
		if (inner.includes("@") || ROLE_WORD.test(inner)) escapes.add(at(match.index ?? 0));
	}
	if (escapes.size === 0) return text;
	let out = "";
	let last = 0;
	for (const index of Array.from(escapes).sort((a, b) => a - b)) {
		if (text[index - 1] === "\\") continue;
		out += `${text.slice(last, index)}\\`;
		last = index;
	}
	return out + text.slice(last);
}

/**
 * Backslash-escape every bracket in `text` that could pass for a genuine
 * source label or role header (see above). The start of `text` counts as a
 * line start. Idempotent.
 */
export function neutralizeLabels(text: string): string {
	return escapeLabels(text, false);
}

/**
 * A placeholder this module writes around untrusted pieces, such as
 * `[thinking: <piece>]`, with each piece already neutralized on its own.
 * Neutralizing the whole placeholder again lets its closing `]` complete a
 * label on the piece's last line. Its opening bracket stays bare unless
 * untrusted text turns its line into a header (`[thinking: x @ 17:00]: …`).
 */
function placeholder(text: string): string {
	return escapeLabels(text, true);
}

/**
 * Untrusted text for a field that must stay on one line (a tool or role name,
 * a MIME type): control characters and line breaks become spaces, so it cannot
 * start a line of its own, and the result is neutralized.
 */
function inlineField(text: string): string {
	return neutralizeLabels(text.replace(/[\p{Cc}\u2028\u2029]/gu, " "));
}

/**
 * `neutralize: false` is for token estimates only, whose text never reaches a
 * model: escaping adds at most a backslash per bracket, while neutralizing a
 * multi-megabyte body before the per-entry cap costs far more than the cap
 * lets through, on every trigger that measures the unobserved backlog.
 */
interface BuildOptions extends SerializedEntryOptions {
	neutralize?: boolean;
}

function untrusted(text: string, options: BuildOptions): string {
	return options.neutralize === false ? text : neutralizeLabels(text);
}

function wrapped(text: string, options: BuildOptions): string {
	return options.neutralize === false ? text : placeholder(text);
}

/** Block types embedded in `[<type> content omitted]`; any other type could forge a label right after its `[`. */
const BLOCK_TYPE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Index where the last line of `text` starts. */
function lastLineStart(text: string): number {
	for (let i = text.length - 1; i >= 0; i--) {
		if (ANY_LINE_BREAK.test(text[i]!)) return i + 1;
	}
	return 0;
}

/**
 * Re-neutralize both sides of a cut in neutralized text. Only the head's
 * last line and the tail's first line can change: the tail now starts a line
 * after the truncation marker, and the cut may have dropped an escaping
 * backslash or shortened a line.
 */
function neutralizeCut(head: string, tail: string): { head: string; tail: string } {
	const headLine = lastLineStart(head);
	const tailBreak = tail.search(ANY_LINE_BREAK);
	const tailLine = tailBreak < 0 ? tail.length : tailBreak;
	return {
		head: `${head.slice(0, headLine)}${neutralizeLabels(head.slice(headLine))}`,
		tail: `${neutralizeLabels(tail.slice(0, tailLine))}${tail.slice(tailLine)}`,
	};
}

function blockText(block: ContentBlock, options: BuildOptions): string {
	if (block.type === "text" && typeof block.text === "string") return untrusted(block.text, options);
	if (block.type === "thinking" && typeof block.thinking === "string") {
		return wrapped(`[thinking: ${untrusted(block.thinking, options)}]`, options);
	}
	if (block.type === "toolCall" && typeof block.name === "string") {
		const args = untrusted(JSON.stringify(block.arguments ?? {}), options);
		return wrapped(`[tool call ${inlineField(block.name)}(${args})]`, options);
	}
	if (block.type === "image") {
		return options.observeAttachments && typeof block.mimeType === "string"
			? wrapped(`[image: ${inlineField(block.mimeType)}]`, options)
			: "[image omitted]";
	}
	if (block.type === "redactedThinking") return "[redacted thinking omitted]";
	const type = typeof block.type === "string" && BLOCK_TYPE_TOKEN.test(block.type) ? block.type : "non-text";
	return `[${type} content omitted]`;
}

function contentText(content: unknown, options: BuildOptions): string {
	if (typeof content === "string") return untrusted(content, options);
	if (!Array.isArray(content)) return "";
	return contentBlocks(content).map((block) => blockText(block, options)).filter(Boolean).join("\n");
}

function messageField(message: unknown, key: string): unknown {
	if (!message || typeof message !== "object" || !(key in message)) return undefined;
	const record = message as Record<string, unknown>;
	return record[key];
}

function stringField(message: unknown, key: string): string {
	const value = messageField(message, key);
	return typeof value === "string" ? value : "";
}

function messageTime(message: unknown, entry: LedgerEntry): string {
	const raw = messageField(message, "timestamp");
	const parsed = typeof raw === "string" || typeof raw === "number" ? parseTimestamp(raw) : undefined;
	return formatLocalTimestamp(parsed ?? parseTimestamp(entry.timestamp) ?? Date.now());
}

function messageRole(message: unknown): string | undefined {
	const role = messageField(message, "role");
	return typeof role === "string" ? role : undefined;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Head and tail of `text` keeping at most `keep` UTF-16 units in total
 * (`keep < text.length`). The halves never overlap and never split a
 * surrogate pair.
 */
function headTail(text: string, keep: number): { head: string; tail: string } {
	let headEnd = Math.ceil(keep / 2);
	let tailStart = text.length - (keep - headEnd);
	if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
	if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
	return { head: text.slice(0, headEnd), tail: text.slice(tailStart) };
}

/**
 * Character cap: a sanity bound per entry, independent of token budgets.
 * `text` must already be neutralized; the kept halves are re-neutralized
 * around the cut, which can add one escape to each (reserved here).
 */
function truncateChars(text: string, maxChars = MAX_SOURCE_ENTRY_CHARS): string {
	if (text.length <= maxChars) return text;
	const marker = `\n[… ${text.length - maxChars} chars truncated; original remains in the session ledger …]\n`;
	const cut = headTail(text, Math.max(1, maxChars - marker.length - 2));
	const { head, tail } = neutralizeCut(cut.head, cut.tail);
	return `${head}${marker}${tail}`;
}

const budgetMarker = (omitted: number): string =>
	`\n[… ${omitted} chars truncated to fit the input budget; original remains in the session ledger …]\n`;

/**
 * Truncate `body` so that `prefix + body` fits `maxTokens` as measured by the
 * estimator, not by an assumed chars-per-token ratio (non-ASCII text and
 * native tokenizers diverge from 4 chars/token by several times). The prefix
 * is never cut. When even the prefix plus a marker exceeds the budget, that
 * minimum is returned. `body` must already be neutralized; each candidate is
 * re-neutralized around its cut before it is measured.
 */
function truncateToTokens(
	prefix: string,
	body: string,
	maxTokens: number,
	estimate: TokenEstimator,
): { text: string; truncated: boolean } {
	const full = `${prefix}${body}`;
	if (body.length === 0 || estimate(full) <= maxTokens) return { text: full, truncated: false };
	const build = (keep: number): string => {
		const cut = headTail(body, keep);
		const { head, tail } = neutralizeCut(cut.head, cut.tail);
		return `${prefix}${head}${budgetMarker(body.length - cut.head.length - cut.tail.length)}${tail}`;
	};
	let best = build(0);
	let low = 1;
	let high = body.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = build(middle);
		if (estimate(candidate) <= maxTokens) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return { text: best, truncated: true };
}

function bashExecutionBody(message: unknown, options: BuildOptions): string {
	// Mirrors the host's bashExecutionToText (user `!cmd`).
	const output = untrusted(stringField(message, "output"), options);
	let text = `Ran \`${untrusted(stringField(message, "command"), options)}\`\n${output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)"}`;
	const exitCode = messageField(message, "exitCode");
	if (messageField(message, "cancelled") === true) text += "\n\n(command cancelled)";
	else if (typeof exitCode === "number" && exitCode !== 0) text += `\n\nCommand exited with code ${exitCode}`;
	const images = contentText(messageField(message, "images"), options);
	return images ? `${text}\n${images}` : text;
}

function pythonExecutionBody(message: unknown, options: BuildOptions): string {
	// Mirrors the host's pythonExecutionToText (user `$ code`).
	const output = untrusted(stringField(message, "output"), options);
	let text = `Ran Python:\n\`\`\`python\n${untrusted(stringField(message, "code"), options)}\n\`\`\`\n${output ? `Output:\n\`\`\`\n${output}\n\`\`\`` : "(no output)"}`;
	const exitCode = messageField(message, "exitCode");
	if (messageField(message, "cancelled") === true) text += "\n\n(execution cancelled)";
	else if (typeof exitCode === "number" && exitCode !== 0) text += `\n\nExecution failed with code ${exitCode}`;
	return text;
}

function fileMentionBody(message: unknown, options: BuildOptions): string {
	// Mirrors the host's `<file path>` wrapping for `@file` mentions. Image
	// bytes are never serialized; only a placeholder is.
	const files = messageField(message, "files");
	if (!Array.isArray(files)) return "";
	return files
		.filter((file): file is Record<string, unknown> => !!file && typeof file === "object")
		.map((file) => {
			const path = typeof file.path === "string" ? untrusted(file.path, options) : "";
			const content = typeof file.content === "string" && file.content ? `\n${untrusted(file.content, options)}\n` : "\n";
			const image = file.image && typeof file.image === "object" ? `${blockText(file.image as ContentBlock, options)}\n` : "";
			return `<file path="${path}">${content}${image}</file>`;
		})
		.join("\n");
}

interface EntryParts {
	header: string;
	body: string;
}

/**
 * Header and body of one source entry, or undefined when the host keeps it
 * out of model context. Untrusted strings in the body are already
 * neutralized, and those in the header (tool, role and custom type names)
 * are kept on the header's line.
 */
function entryParts(entry: LedgerEntry, options: BuildOptions): EntryParts | undefined {
	const time = formatLocalTimestamp(parseTimestamp(entry.timestamp) ?? Date.now());
	if (entry.type === "custom_message") {
		const customType = typeof entry.customType === "string" ? inlineField(entry.customType) : "";
		const label = customType ? `Custom message (${customType})` : "Custom message";
		return { header: `[${label} @ ${time}]: `, body: contentText(entry.content, options) };
	}
	if (entry.type === "branch_summary") {
		return { header: `[Branch summary @ ${time}]: `, body: typeof entry.summary === "string" ? untrusted(entry.summary, options) : "" };
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	const role = messageRole(message);
	if (!role) return undefined;
	const at = messageTime(message, entry);
	switch (role) {
		case "toolResult": {
			const toolName = inlineField(stringField(message, "toolName")) || "tool";
			return { header: `[Tool result for ${toolName} @ ${at}]: `, body: contentText(messageField(message, "content"), options) };
		}
		case "user":
			return { header: `[User @ ${at}]: `, body: contentText(messageField(message, "content"), options) };
		case "assistant":
			return { header: `[Assistant @ ${at}]: `, body: contentText(messageField(message, "content"), options) };
		case "developer":
		case "system":
			return {
				header: `[${role[0]?.toUpperCase()}${role.slice(1)} @ ${at}]: `,
				body: contentText(messageField(message, "content"), options),
			};
		// User-run commands and `@file` mentions keep their payload outside
		// `content`. The host sends them to the model unless excluded (`!!`).
		case "bashExecution":
			if (messageField(message, "excludeFromContext") === true) return undefined;
			return { header: `[User shell command @ ${at}]: `, body: bashExecutionBody(message, options) };
		case "pythonExecution":
			if (messageField(message, "excludeFromContext") === true) return undefined;
			return { header: `[User Python execution @ ${at}]: `, body: pythonExecutionBody(message, options) };
		case "fileMention":
			return { header: `[User file mention @ ${at}]: `, body: fileMentionBody(message, options) };
		default:
			return { header: `[${inlineField(role)} @ ${at}]: `, body: contentText(messageField(message, "content"), options) };
	}
}

/**
 * Neutralized body, redacted, then capped per entry. Redaction only swaps a
 * secret on one line (or a whole key block) for a marker, so it cannot turn
 * escaped content back into a line-start label; the cap re-neutralizes its cut.
 */
function preparedParts(entry: LedgerEntry, options: BuildOptions): EntryParts | undefined {
	const parts = entryParts(entry, options);
	if (!parts) return undefined;
	const body = options.redact ? redactText(parts.body) : parts.body;
	return { header: parts.header, body: truncateChars(body) };
}

/** Render one source entry as plain text for a worker prompt. */
export function serializeEntry(entry: LedgerEntry, options: SerializedEntryOptions = {}): string {
	const parts = preparedParts(entry, options);
	return parts ? `${parts.header}${parts.body}` : "";
}

export function estimateEntryTokens(
	entry: LedgerEntry,
	estimate: TokenEstimator = estimateTextTokens,
	options: SerializedEntryOptions = {},
): number {
	// Built without neutralization: the estimate never reaches a model.
	const parts = preparedParts(entry, { ...options, neutralize: false });
	return parts ? estimate(`${parts.header}${parts.body}`) : 0;
}

export interface SerializedSource {
	text: string;
	sourceEntryIds: string[];
	truncatedSourceEntryIds: string[];
	tokens: number;
}

interface SerializedBlock {
	entry: LedgerEntry;
	/** Source label and role header; never truncated. */
	prefix: string;
	body: string;
	text: string;
	tokens: number;
	truncated: boolean;
}

function sourceBlock(
	entry: LedgerEntry,
	estimate: TokenEstimator,
	options: SerializedEntryOptions,
	perEntryMaxChars?: number,
): SerializedBlock | undefined {
	const parts = preparedParts(entry, options);
	if (!parts || !`${parts.header}${parts.body}`.trim()) return undefined;
	let body = parts.body;
	if (perEntryMaxChars !== undefined && parts.header.length + body.length > perEntryMaxChars) {
		body = truncateChars(body, Math.max(1, perEntryMaxChars - parts.header.length));
	}
	const prefix = `[Source entry id: ${entry.id}]\n${parts.header}`;
	const text = `${prefix}${body}`;
	return { entry, prefix, body, text, tokens: estimate(text), truncated: body !== parts.body };
}

function fitBlock(block: SerializedBlock, maxTokens: number, estimate: TokenEstimator): SerializedBlock {
	const fitted = truncateToTokens(block.prefix, block.body, maxTokens, estimate);
	if (!fitted.truncated) return block;
	return {
		...block,
		body: fitted.text.slice(block.prefix.length),
		text: fitted.text,
		tokens: estimate(fitted.text),
		truncated: true,
	};
}

function blocksTokens(blocks: readonly SerializedBlock[]): number {
	return blocks.reduce((total, block, index) => total + block.tokens + (index > 0 ? 2 : 0), 0);
}

/**
 * Fit blocks into `maxTokens` by water-filling: blocks below the fair share
 * keep their full text and the budget they leave goes to the larger ones,
 * which share it equally. Only the larger blocks are truncated.
 */
function fitBlocksToBudget(
	blocks: readonly SerializedBlock[],
	maxTokens: number,
	estimate: TokenEstimator,
): SerializedBlock[] {
	let remaining = Math.max(0, maxTokens - 2 * (blocks.length - 1));
	const caps = new Array<number>(blocks.length).fill(0);
	const order = blocks.map((_, index) => index).sort((a, b) => blocks[a]!.tokens - blocks[b]!.tokens);
	order.forEach((index, rank) => {
		const cap = Math.min(blocks[index]!.tokens, Math.floor(remaining / (order.length - rank)));
		caps[index] = cap;
		remaining -= cap;
	});
	return blocks.map((block, index) => (block.tokens <= caps[index]! ? block : fitBlock(block, caps[index]!, estimate)));
}

/** Serialize entries with stable source labels, optionally bounded by tokens. */
export function serializeSourceEntries(
	entries: readonly LedgerEntry[],
	options: {
		maxTokens?: number;
		estimate?: TokenEstimator;
		observeAttachments?: boolean;
		/** Truncate each rendered entry to this many characters instead of dropping entries. */
		perEntryMaxChars?: number;
		/** Redact each entry body before any truncation (see `SerializedEntryOptions.redact`). */
		redact?: boolean;
	} = {},
): SerializedSource {
	const estimate = options.estimate ?? estimateTextTokens;
	const entryOptions: SerializedEntryOptions = { observeAttachments: options.observeAttachments, redact: options.redact };
	const blocks: SerializedBlock[] = [];
	let tokens = 0;
	for (const entry of entries) {
		if (!isSourceEntry(entry)) continue;
		const block = sourceBlock(entry, estimate, entryOptions, options.perEntryMaxChars);
		if (!block) continue;
		const separator = blocks.length > 0 ? 2 : 0;
		if (options.maxTokens !== undefined && tokens + block.tokens + separator > options.maxTokens) {
			if (blocks.length > 0) break;
			// A single oversized first entry is truncated to the budget as
			// measured by the estimator, instead of being dropped.
			const fitted = fitBlock(block, options.maxTokens, estimate);
			blocks.push(fitted);
			tokens = fitted.tokens;
			break;
		}
		blocks.push(block);
		tokens += block.tokens + separator;
	}
	return {
		text: blocks.map((block) => block.text).join("\n\n"),
		sourceEntryIds: blocks.map((block) => block.entry.id),
		truncatedSourceEntryIds: blocks.filter((block) => block.truncated).map((block) => block.entry.id),
		tokens,
	};
}

function isToolResultEntry(entry: LedgerEntry | undefined): boolean {
	return entry?.type === "message" && messageRole(entry.message) === "toolResult";
}

function isAssistantToolCall(entry: LedgerEntry | undefined): boolean {
	if (entry?.type !== "message" || messageRole(entry.message) !== "assistant") return false;
	return contentBlocks(messageField(entry.message, "content")).some((block) => block.type === "toolCall");
}

function safeStartIndex(entries: readonly LedgerEntry[], coverageIndex: number, resetIndex: number): number {
	// Nothing at or before the latest `/clear` is observed: it left model
	// context, even when the watermark lagged behind the boundary.
	if (resetIndex > coverageIndex) return resetIndex + 1;
	const start = Math.max(0, coverageIndex + 1);
	if (!isToolResultEntry(entries[start])) return start;
	// The watermark itself is a tool result: the assistant call and earlier
	// results were already sent, so start after them instead of re-observing
	// the same prefix forever (long parallel tool-result runs).
	if (coverageIndex >= 0 && isToolResultEntry(entries[coverageIndex])) return start;
	let backed = start;
	while (backed > resetIndex + 1 && isToolResultEntry(entries[backed])) backed--;
	return backed;
}

/**
 * True when a tool run fits a chunk of its own: `run` (its call and the
 * results selected so far), then `pending`, then the consecutive results from
 * `entries[next]` on, within `maxTokens` and `maxEntries`. Stops measuring as
 * soon as either limit is exceeded.
 */
function runFitsOwnChunk(
	run: readonly SerializedBlock[],
	pending: SerializedBlock,
	entries: readonly LedgerEntry[],
	next: number,
	maxTokens: number,
	maxEntries: number,
	estimate: TokenEstimator,
	options: SerializedEntryOptions,
): boolean {
	let count = run.length + 1;
	let tokens = blocksTokens(run) + 2 + pending.tokens;
	for (let i = next; i < entries.length && count <= maxEntries && tokens <= maxTokens; i++) {
		const entry = entries[i];
		if (!entry || !isSourceEntry(entry)) continue;
		const block = sourceBlock(entry, estimate, options);
		if (!block) continue;
		if (!isToolResultEntry(entry)) break;
		count++;
		tokens += block.tokens + 2;
	}
	return count <= maxEntries && tokens <= maxTokens;
}

export interface SourceChunk {
	entries: LedgerEntry[];
	text: string;
	sourceEntryIds: string[];
	truncatedSourceEntryIds: string[];
	coversUpToId: string;
	tokens: number;
}

/**
 * Select the oldest unobserved source entries after the watermark and the
 * latest `/clear`, up to a token budget.
 *
 * A tool call is never separated from its first result. When the budget or
 * the entry cap runs out inside a tool run, the chunk ends before the
 * assistant call that opened the run if the whole run (the call through its
 * last consecutive result) fits a chunk of its own, so the next chunk observes
 * it whole. A run too large for any chunk is split in place instead: the
 * chunk keeps the call and the results that fit, and the next chunk resumes
 * mid-run because its watermark is a tool result. (Ending before such a run
 * would only add a chunk holding the entries before it.) The chunk still
 * ends before the call when not even its first result fits. Entries are
 * truncated only when the first entry (or a call plus its first result) alone
 * exceeds the budget, and then by water-filling, so coverage never claims
 * content that was cut to a marker to make room for entries that would have
 * fit.
 */
export function chunkUnobservedEntries(
	entries: readonly LedgerEntry[],
	coverageId: string | undefined,
	maxTokens: number,
	estimate: TokenEstimator = estimateTextTokens,
	options: SerializedEntryOptions = {},
): SourceChunk | undefined {
	const coverageIndex = coverageId ? entries.findIndex((entry) => entry.id === coverageId) : -1;
	const start = safeStartIndex(entries, coverageIndex, latestResetBoundaryIndex(entries));
	const maxEntries = Math.max(8, Math.floor(maxTokens / 32));
	let blocks: SerializedBlock[] = [];
	let tokens = 0;
	// Index in `blocks` of the entry that opened the current run of tool
	// results: an assistant tool call, or a result the chunk starts with.
	let runStart = -1;
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || !isSourceEntry(entry)) continue;
		const block = sourceBlock(entry, estimate, options);
		if (!block) continue;
		const previous = blocks[blocks.length - 1]?.entry;
		const continuesRun =
			isToolResultEntry(entry) &&
			previous !== undefined &&
			(isAssistantToolCall(previous) || isToolResultEntry(previous));
		const separator = blocks.length > 0 ? 2 : 0;
		if (blocks.length > 0 && (blocks.length >= maxEntries || tokens + block.tokens + separator > maxTokens)) {
			if (!continuesRun) break;
			if (runStart > 0 && isAssistantToolCall(blocks[runStart]!.entry)) {
				const callIsLast = runStart === blocks.length - 1;
				if (callIsLast || runFitsOwnChunk(blocks.slice(runStart), block, entries, i + 1, maxTokens, maxEntries, estimate, options)) {
					blocks = blocks.slice(0, runStart);
				}
				break;
			}
			if (blocks.length > 1 || !isAssistantToolCall(blocks[0]!.entry)) break;
			// A tool call is never sent without its first result.
			blocks.push(block);
			break;
		}
		if (!continuesRun) runStart = blocks.length;
		blocks.push(block);
		tokens += block.tokens + separator;
	}
	if (blocks.length === 0) return undefined;
	if (blocksTokens(blocks) > maxTokens) blocks = fitBlocksToBudget(blocks, maxTokens, estimate);
	const last = blocks[blocks.length - 1]!;
	return {
		entries: blocks.map((block) => block.entry),
		text: blocks.map((block) => block.text).join("\n\n"),
		sourceEntryIds: blocks.map((block) => block.entry.id),
		truncatedSourceEntryIds: blocks.filter((block) => block.truncated).map((block) => block.entry.id),
		// Every selected block is sent, so the watermark is the last one.
		coversUpToId: last.entry.id,
		tokens: blocksTokens(blocks),
	};
}

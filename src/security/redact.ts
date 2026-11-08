// Best-effort secret redaction for worker prompts, stored memory, rendered
// output, notifications and logs.
//
// Callers often redact one string that joins many source entries or memory
// lines, so a match that runs past a line break can erase unrelated entries.
// Only private-key blocks may span lines, and only over lines that look like
// key material, plus the YAML block scalar of a sensitive key, and only over
// its more-indented lines. Every pass is linear in the input, and redactText
// is idempotent: callers may redact the same text twice.

const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";
const REDACTED_CREDENTIAL = "[REDACTED CREDENTIAL]";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/\b(?:Authorization|Proxy-Authorization|X-Auth-Token)[ \t]*:[ \t]*(?:Bearer|Basic|Digest|Token)[ \t]+[^\s"',;}]+/gi,
		"[REDACTED AUTHORIZATION HEADER]",
	],
	[/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
	[/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
	[/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED API KEY]"],
	[/\bwhsec_[A-Za-z0-9]{16,}\b/g, "[REDACTED WEBHOOK SECRET]"],
	[/\b(?:gsk|hf|npm)_[A-Za-z0-9]{16,}\b/g, "[REDACTED API KEY]"],
	[/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED GITLAB TOKEN]"],
	[/\bpypi-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED PYPI TOKEN]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"],
	[/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"],
	[/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED GOOGLE KEY]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
	// URL userinfo passwords: `postgres://user:pass@host`. Keeps scheme, user,
	// and host. The lookbehind starts a scheme only at the start of a run of
	// scheme characters and the scheme is bounded, so long dotted or hyphenated
	// runs cannot make this quadratic.
	[/(?<![\w+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]*):[^\s/?#@]+@/gi, "$1:[REDACTED]@"],
];

// ---------------------------------------------------------------------------
// Private-key blocks
// ---------------------------------------------------------------------------

const PEM_BEGIN = /-{4,5} ?BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)? ?-{4,5}/g;
const PEM_END = /-{4,5} ?END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)? ?-{4,5}/g;
/**
 * Longest BEGIN…END span redacted as one block. Inside it, short lines of any
 * shape are tolerated (line-number or diff prefixes, truncation markers).
 * Longer keys are still covered line by line through key-material runs.
 */
const PEM_MAX_BLOCK_CHARS = 32_768;
const PEM_HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]{0,39}:[ \t]/;
/**
 * Decorations before a key line: a `grep -n` file prefix (`key.pem:12:`), a
 * `cat -n`, `nl` or `N|` line number, diff or quote marks (`+`, `> `).
 */
const PEM_LINE_PREFIX =
	/^(?:(?=[^\s:"'`]{0,199}[./])[^\s:"'`]{1,200}[:-](?=\d))?(?:\d{1,7}[ \t]*[|:│-]?[ \t]*)?(?:[>#*+"'`/-][ \t]*){0,3}/;
const PEM_BODY_LINE = /^=?[A-Za-z0-9+/]{4,}={0,3}$/;
const PEM_FILLER_LINE = /^[ \t"'`,;+()\\]{0,8}$/;
const PEM_LINE_SUFFIX_CHARS = new Set([" ", "\t", '"', "'", "`", ",", ";", "+", ")", "]", "}", "\\"]);
/** `cat -A` ends every line with `$` and shows a carriage return as `^M`. */
const CAT_A_LINE_END = /(?:\^M)?\$$/;
/**
 * A key printed on one line (`echo $KEY`, a Python list of its lines) is a
 * run of base64 chunks joined by spaces, tabs, commas or quotes, also written
 * as JSON escapes (`\"`, `\t`) inside a serialized tool call.
 */
const PEM_CHUNK_SEPARATOR = /(?:[\s,'"`]|\\[t"'\\])+/;
const PEM_CHUNK = /^=?[A-Za-z0-9+/]+={0,3}$/;
const PEM_CHUNK_SEPARATOR_CHARS = new Set([" ", "\t", ",", "'", '"', "`"]);
/** Characters after which a JSON escape's second character is a separator. */
const PEM_ESCAPED_SEPARATOR_CHARS = new Set(["t", '"', "'", "\\"]);
/**
 * Text that may follow the last chunk of a one-line key directly: the rest
 * of a JSON escape, a truncation mark (`…`), the end of a shell statement or
 * call. Before the first chunk: an opening parenthesis or a truncation mark.
 */
const PEM_GLUE_AFTER = new Set(["\\", "…", ";", ")"]);
const PEM_GLUE_BEFORE = new Set(["…", "("]);
/**
 * A chunk this long is a key line; prose words and paths are shorter. A line
 * of several chunks is key material only when it holds one, and at most two
 * chunks shorter than PEM_SHORT_CHUNK_CHARS (a final line, a cut-off piece).
 */
const PEM_LONG_CHUNK_CHARS = 32;
const PEM_SHORT_CHUNK_CHARS = 16;

type PemLineKind = "filler" | "body" | "header" | "marker" | "other";

/** Length of the line break starting at `index`, counting JSON `\n`/`\r` escapes. */
function lineBreakLength(text: string, index: number): number {
	const ch = text.charCodeAt(index);
	if (ch === 10) return 1;
	if (ch === 13) return text.charCodeAt(index + 1) === 10 ? 2 : 1;
	if (ch === 92) {
		const next = text.charCodeAt(index + 1);
		if (next === 110 || next === 114) return 2;
	}
	return 0;
}

/** Length of the line break that ends right before `index`. */
function lineBreakLengthBefore(text: string, index: number): number {
	const ch = text.charCodeAt(index - 1);
	if (ch === 10) return text.charCodeAt(index - 2) === 13 ? 2 : 1;
	if (ch === 13) return 1;
	if ((ch === 110 || ch === 114) && text.charCodeAt(index - 2) === 92) return 2;
	return 0;
}

function lineEndFrom(text: string, from: number, limit: number): number {
	for (let i = from; i < limit; i++) if (lineBreakLength(text, i) > 0) return i;
	return limit;
}

function lineStartBefore(text: string, index: number, floor: number): number {
	for (let i = index; i > floor; i--) if (lineBreakLengthBefore(text, i) > 0) return i;
	return floor;
}

function stripPemLineSuffix(line: string): string {
	let end = line.length;
	while (end > 0 && PEM_LINE_SUFFIX_CHARS.has(line[end - 1] ?? "")) end--;
	return line.slice(0, end);
}

/** Whether `text` is base64 chunks joined by spaces, commas or quotes, holding a key-line-sized chunk. */
function isChunkedKeyText(text: string): boolean {
	let sawLong = false;
	let short = 0;
	for (const chunk of text.split(PEM_CHUNK_SEPARATOR)) {
		if (!chunk) continue;
		if (!PEM_CHUNK.test(chunk)) return false;
		if (chunk.length >= PEM_LONG_CHUNK_CHARS) sawLong = true;
		else if (chunk.length < PEM_SHORT_CHUNK_CHARS && ++short > 2) return false;
	}
	return sawLong;
}

function isPemChunkChar(ch: string | undefined): boolean {
	if (ch === undefined) return false;
	return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "+" || ch === "/" || ch === "=";
}

function classifyPemLine(line: string): PemLineKind {
	const trimmed = line.trim().replace(CAT_A_LINE_END, "");
	if (PEM_FILLER_LINE.test(trimmed)) return "filler";
	// Truncation markers from serialize.ts: `[… N chars truncated; …]`.
	if (trimmed.startsWith("[…")) return "marker";
	if (PEM_HEADER_LINE.test(trimmed)) return "header";
	if (PEM_BODY_LINE.test(stripPemLineSuffix(trimmed))) return "body";
	const core = stripPemLineSuffix(trimmed.replace(PEM_LINE_PREFIX, ""));
	return PEM_BODY_LINE.test(core) || isChunkedKeyText(core) ? "body" : "other";
}

/** Length of the chunk separator at `index`: a space, comma or quote, or a JSON `\"`, `\t` or `\\` escape. */
function chunkSeparatorLength(text: string, index: number): number {
	const ch = text[index] ?? "";
	if (PEM_CHUNK_SEPARATOR_CHARS.has(ch)) return 1;
	return ch === "\\" && PEM_ESCAPED_SEPARATOR_CHARS.has(text[index + 1] ?? "") ? 2 : 0;
}

/** Length of the chunk separator that ends right before `index`, not reaching below `floor`. */
function chunkSeparatorLengthBefore(text: string, index: number, floor: number): number {
	const ch = text[index - 1] ?? "";
	if (index - 2 >= floor && text[index - 2] === "\\" && (ch === '"' || ch === "'" || ch === "\\")) return 2;
	return index > floor && PEM_CHUNK_SEPARATOR_CHARS.has(ch) ? 1 : 0;
}

/**
 * End of the base64 chunks that start a line at `from`, when they hold key
 * material: a one-line key cut off before its END marker, followed by other
 * text on the same line. Returns `from` otherwise.
 */
function leadingChunksEnd(text: string, from: number, lineEnd: number): number {
	let end = from;
	let i = from;
	for (;;) {
		for (let step = chunkSeparatorLength(text, i); step > 0 && i < lineEnd; step = chunkSeparatorLength(text, i)) i += step;
		i = Math.min(i, lineEnd);
		const chunkStart = i;
		while (i < lineEnd && isPemChunkChar(text[i])) i++;
		if (i === chunkStart || !PEM_CHUNK.test(text.slice(chunkStart, i))) break;
		if (i < lineEnd && chunkSeparatorLength(text, i) === 0) {
			// A chunk glued to other text is a word of it (`image:latest`), unless
			// it is key-sized or the glue closes a string, statement or truncated line.
			if (i - chunkStart >= PEM_SHORT_CHUNK_CHARS || PEM_GLUE_AFTER.has(text[i] ?? "")) end = i;
			break;
		}
		end = i;
	}
	return end > from && isChunkedKeyText(text.slice(from, end)) ? end : from;
}

/** Start of the base64 chunks that end a line right before `to` (an END marker), or `to`. */
function trailingChunksStart(text: string, lineStart: number, to: number): number {
	let start = to;
	let i = to;
	for (;;) {
		for (let step = chunkSeparatorLengthBefore(text, i, lineStart); step > 0; step = chunkSeparatorLengthBefore(text, i, lineStart)) {
			i -= step;
		}
		const chunkEnd = i;
		while (i > lineStart && isPemChunkChar(text[i - 1])) i--;
		let chunkStart = i;
		// A JSON `\t` escape before the chunk: its `t` is a separator, not key material.
		if (i > lineStart && i < chunkEnd && text[i - 1] === "\\" && text[i] === "t") {
			chunkStart = i + 1;
			i--;
			if (chunkStart === chunkEnd) continue;
		}
		if (chunkStart === chunkEnd || !PEM_CHUNK.test(text.slice(chunkStart, chunkEnd))) break;
		const glued = chunkStart === i && i > lineStart && chunkSeparatorLengthBefore(text, i, lineStart) === 0;
		if (glued) {
			// `foo:K0 K1 -----END…`: a key-sized chunk is key material whatever precedes it.
			if (chunkEnd - chunkStart >= PEM_SHORT_CHUNK_CHARS || PEM_GLUE_BEFORE.has(text[i - 1] ?? "")) start = chunkStart;
			break;
		}
		start = chunkStart;
	}
	return start < to && isChunkedKeyText(text.slice(start, to)) ? start : to;
}

function wordCount(line: string): number {
	let count = 0;
	let inWord = false;
	for (let i = 0; i < line.length; i++) {
		const space = line[i] === " " || line[i] === "\t";
		if (!space && !inWord) count++;
		inWord = !space;
	}
	return count;
}

/**
 * Whether the text between a BEGIN and an END marker is plausibly one key.
 * A line of three or more words (prose, an entry label) means the markers
 * belong to different places, such as `head -1` and `tail -1` outputs in two
 * source entries, and the text between them must survive.
 */
function looksLikeKeyBody(text: string, from: number, to: number): boolean {
	let pos = from;
	let sawBody = false;
	for (;;) {
		const stop = lineEndFrom(text, pos, to);
		const line = text.slice(pos, stop);
		const kind = classifyPemLine(line);
		if (kind === "body") sawBody = true;
		else if ((kind === "other" || (kind === "header" && sawBody)) && wordCount(line) > 2) return false;
		if (stop >= to) return true;
		pos = stop + lineBreakLength(text, stop);
	}
}

/** End of the key material that follows a BEGIN marker with no usable END. */
function forwardKeyRun(text: string, from: number, limit: number): number {
	let end = from;
	let pos = from;
	let sawBody = false;
	while (pos < limit) {
		const stop = lineEndFrom(text, pos, limit);
		const kind = classifyPemLine(text.slice(pos, stop));
		if (kind === "body") {
			end = stop;
			sawBody = true;
		} else if (kind === "header" && !sawBody) {
			end = stop;
		} else if (kind !== "filler") {
			// The rest of the BEGIN line may be a one-line key followed by other text.
			if (pos === from) end = leadingChunksEnd(text, from, stop);
			break;
		}
		if (stop >= limit) break;
		pos = stop + lineBreakLength(text, stop);
	}
	return end;
}

/** Start of the key material that precedes an END marker with no BEGIN. */
function backwardKeyRun(text: string, endMarkerStart: number, floor: number): number {
	let start = endMarkerStart;
	const partialStart = lineStartBefore(text, endMarkerStart, floor);
	const partial = classifyPemLine(text.slice(partialStart, endMarkerStart));
	if (partial === "body") start = partialStart;
	else if (partial !== "filler") return trailingChunksStart(text, partialStart, endMarkerStart);
	let pos = partialStart;
	while (pos > floor) {
		const breakLength = lineBreakLengthBefore(text, pos);
		if (breakLength === 0 || pos - breakLength < floor) break;
		const lineEnd = pos - breakLength;
		const lineStart = lineStartBefore(text, lineEnd, floor);
		const kind = classifyPemLine(text.slice(lineStart, lineEnd));
		if (kind === "body") start = lineStart;
		else if (kind !== "filler") break;
		pos = lineStart;
	}
	return start;
}

function markerSpans(text: string, pattern: RegExp): Array<readonly [number, number]> {
	const spans: Array<readonly [number, number]> = [];
	for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
	return spans;
}

/**
 * Redact private-key blocks. A BEGIN marker pairs with the next END marker
 * when no other BEGIN comes first, the span is bounded, and the lines between
 * look like key material. Otherwise each marker is redacted with the key lines
 * next to it: a BEGIN through the following base64 lines (an END cut off by
 * truncation), an END back through the preceding ones (a BEGIN cut off).
 * Markers are found in one pass and paired in order, so this is linear.
 */
function redactPrivateKeys(text: string): string {
	if (!text.includes("PRIVATE KEY")) return text;
	const begins = markerSpans(text, PEM_BEGIN);
	const ends = markerSpans(text, PEM_END);
	if (begins.length === 0 && ends.length === 0) return text;
	const ranges: Array<readonly [number, number]> = [];
	let cursor = 0;
	let e = 0;
	const flushHeadlessEnds = (before: number): void => {
		for (; e < ends.length; e++) {
			const end = ends[e];
			if (!end || end[0] >= before) return;
			if (end[0] < cursor) continue;
			ranges.push([backwardKeyRun(text, end[0], cursor), end[1]]);
			cursor = end[1];
		}
	};
	for (let b = 0; b < begins.length; b++) {
		const begin = begins[b];
		if (!begin) continue;
		flushHeadlessEnds(begin[0]);
		if (begin[0] < cursor) continue;
		const nextBegin = begins[b + 1]?.[0] ?? text.length;
		const end = ends[e];
		if (
			end &&
			end[0] < nextBegin &&
			end[1] - begin[0] <= PEM_MAX_BLOCK_CHARS &&
			looksLikeKeyBody(text, begin[1], end[0])
		) {
			ranges.push([begin[0], end[1]]);
			cursor = end[1];
			e++;
			continue;
		}
		const limit = Math.min(nextBegin, end?.[0] ?? text.length);
		const runEnd = forwardKeyRun(text, begin[1], limit);
		ranges.push([begin[0], runEnd]);
		cursor = runEnd;
	}
	flushHeadlessEnds(Number.POSITIVE_INFINITY);
	return applyRanges(text, mergeAdjacent(text, ranges), REDACTED_PRIVATE_KEY);
}

/** Merge ranges separated only by whitespace so one key yields one marker. */
function mergeAdjacent(text: string, ranges: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
	const merged: Array<[number, number]> = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && text.slice(last[1], start).trim() === "") last[1] = end;
		else merged.push([start, end]);
	}
	return merged;
}

function applyRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>, replacement: string): string {
	if (ranges.length === 0) return text;
	let result = "";
	let last = 0;
	for (const [start, end] of ranges) {
		result += text.slice(last, start) + replacement;
		last = end;
	}
	return result + text.slice(last);
}

// ---------------------------------------------------------------------------
// Standalone auth-scheme credentials
// ---------------------------------------------------------------------------

const AUTH_SCHEME_CREDENTIAL = /\b(Basic|Digest|Bearer)[ \t]+([A-Za-z0-9._~+/=-]+)/gi;

/**
 * Whether a token after `Basic`/`Digest`/`Bearer` looks like a credential
 * rather than a word: base64 padding, digits in a long or mixed-case token, or
 * the dense case changes of random base64 within one alphanumeric run. Prose
 * such as "basic understanding", "Bearer tokenization" or "basic
 * GitHub/GitLab support" and words such as "JavaScript" do not qualify.
 */
function looksLikeCredential(token: string, minLength: number): boolean {
	if (token.length < minLength) return false;
	if (/^[A-Za-z0-9+/]+={1,2}$/.test(token)) return true;
	let digits = 0;
	let upper = 0;
	let lower = 0;
	// Case changes are counted per run, so `/`-joined product names such as
	// `MySQL/PostgreSQL` (one change in each) do not add up.
	let runLowerToUpper = 0;
	let maxLowerToUpper = 0;
	let previousLower = false;
	for (const ch of token) {
		const isUpper = ch >= "A" && ch <= "Z";
		const isLower = ch >= "a" && ch <= "z";
		const isDigit = ch >= "0" && ch <= "9";
		if (isDigit) digits++;
		if (isUpper) upper++;
		if (isLower) lower++;
		if (!isUpper && !isLower && !isDigit) runLowerToUpper = 0;
		else if (isUpper && previousLower) maxLowerToUpper = Math.max(maxLowerToUpper, ++runLowerToUpper);
		previousLower = isLower;
	}
	if (digits >= 2 && (token.length >= 16 || (upper > 0 && lower > 0))) return true;
	return maxLowerToUpper >= 2 && upper / (upper + lower) >= 0.25;
}

function redactAuthSchemeCredentials(text: string): string {
	return text.replace(AUTH_SCHEME_CREDENTIAL, (match, scheme: string, token: string) => {
		const bearer = scheme.toLowerCase() === "bearer";
		if (!looksLikeCredential(token, bearer ? 12 : 8)) return match;
		return bearer ? `${scheme} [REDACTED]` : "[REDACTED AUTH CREDENTIAL]";
	});
}

// ---------------------------------------------------------------------------
// Sensitive keys
// ---------------------------------------------------------------------------

/** Words that make a key sensitive on their own (`clientSecret`, `GITHUB_TOKEN`). */
const SECRET_WORDS = new Set([
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"secret",
	"token",
	"credential",
	"credentials",
	"cookie",
	"authorization",
	"bearer",
]);
/** Words that make a later `key` word sensitive (`api_key`, `SecretAccessKey`). */
const KEY_QUALIFIERS = new Set([
	"api",
	"access",
	"account",
	"private",
	"secret",
	"signing",
	"encryption",
	"master",
	"auth",
	"app",
	"service",
	"subscription",
	"license",
	"webhook",
	"deploy",
]);
/** Suffixes that mark single-word keys such as `PGPASSWORD` or `authtoken`. */
const SECRET_SUFFIXES = [
	"password",
	"passwd",
	"passphrase",
	"secret",
	"token",
	"credential",
	"credentials",
	"apikey",
	"accesskey",
	"privatekey",
	"secretkey",
];
/**
 * Words that describe metadata about a secret rather than the secret itself
 * when they follow the secret word: `tokenCount`, `token_type`,
 * `password_file`, `secretName`. Before it they are part of the secret's name
 * (`LABEL_STUDIO_API_KEY`, `URL_SIGNING_SECRET`), except QUANTITY_PREFIXES
 * directly before a secret word (`max_token`, `MIN_PASSWORD_LENGTH`).
 */
const NEUTRAL_WORDS = new Set([
	"count",
	"counts",
	"limit",
	"limits",
	"max",
	"min",
	"num",
	"total",
	"budget",
	"usage",
	"estimate",
	"len",
	"length",
	"size",
	"type",
	"kind",
	"name",
	"names",
	"file",
	"path",
	"dir",
	"url",
	"uri",
	"endpoint",
	"arn",
	"field",
	"label",
	"placeholder",
	"prompt",
	"hint",
	"policy",
	"required",
	"enabled",
	"disabled",
	"less",
	"ttl",
	"expiry",
	"expires",
	"expiration",
	"prefix",
	"suffix",
	"re",
	"regex",
	"pattern",
	"score",
	"details",
	"index",
	"offset",
	"pos",
	"start",
	"end",
]);

/** Quantity words that make a directly following secret word a number: `max_token`, `min_password_length`. */
const QUANTITY_PREFIXES = new Set(["max", "min", "num", "total", "count"]);

/**
 * Longest key examined whole. A longer key (a deep Spring or Helm property
 * path) is judged by its trailing dotted, hyphenated or underscored segments.
 */
const MAX_KEY_CHARS = 128;
/**
 * A key longer than this is sensitive only through its suffix: its last secret
 * word must be followed by at most LONG_KEY_TRAILING_WORDS words
 * (`…registration.keycloak.client-secret`, not a message id such as
 * `Unexpected_token_A_constructor_method_accessor_or_property_was_expected_1068`).
 */
const LONG_KEY_CHARS = 64;
const LONG_KEY_TRAILING_WORDS = 2;
/** Every sensitive key contains one of these; most keys can skip word splitting. */
const SENSITIVE_KEY_HINT = /pass|pwd|secret|token|key|cred|cookie|auth|bearer/i;

/** The longest suffix of `key` that fits MAX_KEY_CHARS and starts after a `.`, `-` or `_`. */
function trailingKeySegment(key: string): string {
	if (key.length <= MAX_KEY_CHARS) return key;
	const floor = key.length - MAX_KEY_CHARS;
	for (let i = floor; i < key.length; i++) {
		const before = key[i - 1];
		if (before === "." || before === "-" || before === "_") return key.slice(i);
	}
	return key.slice(floor);
}

function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/**
 * Whether an assignment or object key names a secret. Keys are split into
 * words at `_`, `-`, `.` and camelCase boundaries, so `SecretAccessKey`,
 * `aws_secret_access_key`, `clientSecret`, `X-Api-Key` and
 * `LABEL_STUDIO_API_KEY` are sensitive while `tokenizer`, `maxTokens`,
 * `tokenCount`, `secretary`, `passwordless` and bare `auth` are not.
 */
function isSensitiveKey(key: string): boolean {
	// npm's `.npmrc` credential (`_auth=<base64 user:pass>`).
	if (key === "_auth") return true;
	const tail = trailingKeySegment(key);
	if (!SENSITIVE_KEY_HINT.test(tail)) return false;
	const words = keyWords(tail);
	let lastSecret = -1;
	let qualified = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		const secret =
			SECRET_WORDS.has(word) ||
			((word === "key" || word === "keys") && qualified) ||
			// `pass` alone is too common (`pass: 3`), but `DB_PASS` is a password.
			(word === "pass" && i > 0 && i === words.length - 1) ||
			SECRET_SUFFIXES.some((suffix) => word.endsWith(suffix));
		if (secret && !QUANTITY_PREFIXES.has(words[i - 1] ?? "")) lastSecret = i;
		if (KEY_QUALIFIERS.has(word)) qualified = true;
	}
	if (lastSecret < 0) return false;
	if (key.length > LONG_KEY_CHARS && words.length - 1 - lastSecret > LONG_KEY_TRAILING_WORDS) return false;
	// Metadata after the secret word: `token_count`, `password_file`, `secret_name`.
	for (let i = lastSecret + 1; i < words.length; i++) if (NEUTRAL_WORDS.has(words[i] ?? "")) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * A key and its separator: `KEY=`, `key: `, `"key": `, `--password=`.
 * The key starts at the beginning of a run of key characters, or right after
 * a JSON `\n`/`\r`/`\t` escape, and covers the whole run, so a long dotted run
 * is tried once, not at every dot (isSensitiveKey judges a long key by its
 * tail). Only the key is matched here: the value is examined in code, so a
 * non-sensitive key never consumes a value that holds secrets of its own
 * (`{"command":"export API_KEY=..."}`, `https://host/?access_token=...`).
 * `::` separates a value (`password::abc123`) unless the text after it
 * continues a Rust path: an identifier (`token::Token`), a segment followed
 * by `::` (`secret::v1::Secret`), a `{` group, a `<` or a `*` glob. `:/`
 * separates unless it starts a URL.
 */
const ASSIGNMENT_KEY =
	/(\\?["']|)(?:(?<=\\[nrt])|(?<![A-Za-z0-9_.\\-]))[.-]*([A-Za-z0-9_][A-Za-z0-9_.-]*)(?![A-Za-z0-9_.-])(\\?["']|)[ \t]*(=>|:=|={1,3}|::(?![{<*]|[A-Za-z_]+(?![\w$])|[A-Za-z_]\w*::)|:(?!:|\/\/))[ \t]*/g;
/**
 * What may precede a key on its line: a `cat -n`, `N|`/`N:` or host grep
 * (`*N:`) line number, or a `grep -n` `path:N:` prefix; indentation (also as
 * JSON `\t` escapes); a diff `+`, a list bullet; `export`.
 */
const LINE_PREFIX =
	/^\+?(?:[ \t]*\*?\d{1,7}(?:[|:│]|\t|\\t)|[^\s:"'`|\\]{1,200}:\d{1,7}[:-])?(?:[ \t]|\\t)*(?:[-*+][ \t]+)?(?:export[ \t]+)?$/;
/** How far back a key's line start is looked for. */
const LINE_START_WINDOW = 256;
/**
 * The opening quote of a JSON string value, `"content":"`, also JSON-escaped
 * (`\"content\":\"`). The group is the field name.
 */
const JSON_STRING_OPENING = /\\?"([^"\\]{1,64})\\?"[ \t]*:[ \t]*\\?"$/;
/**
 * JSON fields that hold a shell command line, where `VAR=value cmd` ends the
 * value at whitespace: `{"command":"PGPASSWORD=x psql -h db"}`.
 */
const SHELL_COMMAND_FIELDS = new Set(["command", "cmd", "script"]);
/**
 * A line-start `key: value` with a single lowercase word as its key and more
 * words than this is prose (`password: must be rotated every 90 days`), not a
 * passphrase, so only its first word is taken.
 */
const LINE_VALUE_MAX_WORDS = 6;
/** A YAML block scalar indicator, optionally tagged: `|`, `>-`, `!vault |`. */
const BLOCK_SCALAR_INDICATOR = /^(?:![^\s]*[ \t]+)?[|>][1-9]?[+-]?[1-9]?$/;
/** Most lines of a YAML block scalar redacted after a sensitive key. */
const BLOCK_SCALAR_MAX_LINES = 32;
/** Longest first word examined when deciding whether a value is a placeholder. */
const VALUE_PEEK_CHARS = 256;
const QUERY_PARAM_AHEAD = /[A-Za-z_][\w.[\]-]{0,63}=/y;
/**
 * Values that are code or config placeholders, not secrets. Type names and
 * keywords count only when the token ends there or continues as code
 * (`Optional[str]`, `string|null`, `int?`, `unknown>`, `require(`):
 * `New-Hire-2024!` and `Str.0ng.Pass` are passwords.
 */
const NON_SECRET_VALUE =
	/^(?:true|false|null|none|nil|undefined)$|^&?(?:'static\s+)?(?:str|string|number|boolean|bool|bytes|int|float|any|unknown|object|SecretStr|Option|Optional|Maybe)(?=$|[\s<>[\]|?;,)(])|^(?:await|new|yield|typeof|function|lambda|async|require|import)(?=$|[\s<[|?;,)(])|^lambda:$/i;
/** Shell, template and environment references: `$DB_PASSWORD`, `${{ secrets.X }}`. */
const VARIABLE_REFERENCE = /^(?:\$\{?[A-Za-z_]\w*\}?$|\$\{\{|\$\(|%[A-Za-z_]\w*%$)/;
/** Objects whose members are configuration or environment lookups, not literals. */
const CODE_OBJECT =
	/^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env|this|self|secrets|vars|config|settings|options|opts|args|params|props|ctx|req|request)(?=[.[(])/;
/**
 * An identifier or a `.`/`::` path of identifiers, without digits:
 * `get_token`, `getpass.getpass`, `String::new`.
 */
const CALLEE = /^[A-Za-z_$][A-Za-z_]*(?:(?:\.|::)[A-Za-z_$][A-Za-z_]*)*/;
/**
 * A member chain, with private names, optional chaining and non-null
 * assertions: `.token`, `.#token`, `.apiKey?.trim`, `.config!.token`.
 */
const MEMBER_CHAIN = /^(?:(?:\?\.|!\.|\.)#?[A-Za-z_$][\w$]*)*/;
/** Module roots that make an `a::b` value a Rust or C++ path rather than a literal. */
const PATH_ROOT = /^(?:std|core|alloc|crate|self|super|Self)::/;
/** Most characters scanned for the `)` or `]` that closes a call or subscript. */
const BRACKET_SCAN_CHARS = 256;
/**
 * Signs that a multi-word value whose first word is a keyword is code, not a
 * passphrase (`MAIL_PASSWORD=new secret phrase`): brackets, operators,
 * comments, quotes, member access (`await vault.read`), a list comma, or a
 * Python operator word after it.
 */
const CODE_SIGNAL =
	/[()[\]{}<>|;=$`&"]|\/[/*]|\?[?.]|[ \t]\?[ \t]|::|[\w$]\.[A-Za-z_$#]|^[^\s,]+,|^\S+[ \t]+(?:if|or|and|else|is|in|not)(?:[ \t]|$)/;
/**
 * Operators between spaces that make a line value an expression rather than a
 * passphrase: `??`, `||`, `&&`, comparisons, `=>`, a ternary `?`.
 */
const EXPRESSION_OPERATOR = /[ \t](?:\?\?|\|\||&&|[=!]==?|=>|\?)[ \t]/;
/** A lowercase word of prose, optionally followed by punctuation. */
const PROSE_WORD = /^[a-z]{2,}[,.;:!?]?$/;

type LineMode = "physical" | "escaped";
type SeparatorKind = "assign" | "colon" | "other";

/** Where a sensitive key sits, which decides how far its unquoted value runs. */
interface KeyContext {
	/** The quote that opened the key when the key did not close it. */
	keyQuote: string;
	/** Whether `keyQuote` is a JSON `\"`. */
	keyQuoteEscaped: boolean;
	/** Whether the key is quoted on both sides (a JSON or quoted YAML key). */
	keyQuoted: boolean;
	/**
	 * The string the key opens: a JSON string value (`"content":"KEY=…`), one
	 * holding a shell command (`"command":"KEY=… cmd"`), or another quoted
	 * string (`echo 'KEY=…'`, `["KEY=…"]`).
	 */
	string: "json" | "shell" | "quote" | undefined;
	/** Set when the key starts a line. A JSON string value starts one too. */
	line: LineMode | undefined;
	/** Start of the key's line, when `line` is set. */
	lineStart: number;
	/** Start of the key, or of the quote that opens it. */
	keyStart: number;
	separator: SeparatorKind;
	/**
	 * `label` for a Title-case natural-language word (`Token`, `Password`),
	 * `word` for a single lowercase word (`password`), `compound` otherwise
	 * (`db_password`, `DB_PASSWORD`, `clientSecret`).
	 */
	keyStyle: "label" | "word" | "compound";
}

function separatorKind(separator: string): SeparatorKind {
	if (separator === "=" || separator === ":=") return "assign";
	if (separator === ":" || separator === "::") return "colon";
	return "other";
}

function keyStyle(key: string): KeyContext["keyStyle"] {
	if (/^[A-Z][a-z]+$/.test(key)) return "label";
	if (/^[a-z]+$/.test(key)) return "word";
	return "compound";
}

/** The JSON field whose string value opens with the quote that ends right before `index`. */
function jsonStringField(text: string, index: number): string | undefined {
	return JSON_STRING_OPENING.exec(text.slice(Math.max(0, index - 80), index))?.[1];
}

/**
 * Whether the text from `index` back to its line start is only a line prefix
 * (indentation, line numbers, a bullet, `export`). The start of the text,
 * JSON `\n`/`\r` escapes and the opening quote of a JSON string value count
 * as line starts, so dotenv/YAML values in serialized tool calls and
 * per-entry bodies qualify. A shell command field does not: its assignments
 * are inline (`PGPASSWORD=x psql`).
 */
function lineStartOf(text: string, index: number): { mode: LineMode; start: number } | undefined {
	const floor = Math.max(0, index - LINE_START_WINDOW);
	let start = -1;
	let mode: LineMode = "physical";
	for (let i = index; i > floor; i--) {
		const ch = text.charCodeAt(i - 1);
		if (ch === 10 || ch === 13) {
			start = i;
			break;
		}
		if ((ch === 110 || ch === 114) && text.charCodeAt(i - 2) === 92) {
			start = i;
			mode = "escaped";
			break;
		}
		if (ch === 34) {
			// No line prefix holds a quote: either a JSON string value opens here, or this is no line start.
			const field = jsonStringField(text, i);
			if (field === undefined || SHELL_COMMAND_FIELDS.has(field)) return undefined;
			start = i;
			mode = "escaped";
			break;
		}
	}
	if (start < 0) {
		if (floor > 0) return undefined;
		start = 0;
	}
	return LINE_PREFIX.test(text.slice(start, index)) ? { mode, start } : undefined;
}

/** Index of the bracket that closes the one at `open`, on the same line and nearby, or -1. */
function closingBracket(text: string, open: number): number {
	const opener = text[open];
	const closer = opener === "(" ? ")" : "]";
	let depth = 0;
	const limit = Math.min(text.length, open + BRACKET_SCAN_CHARS);
	for (let i = open; i < limit; i++) {
		const ch = text[i];
		if (ch === "\n" || ch === "\r" || (ch === "\\" && (text[i + 1] === "n" || text[i + 1] === "r"))) return -1;
		if (ch === opener) depth++;
		else if (ch === closer && --depth === 0) return i;
	}
	return -1;
}

/** The text after `index` up to the end of its line, at most BRACKET_SCAN_CHARS long, trimmed. */
function restOfLine(text: string, index: number): string {
	const limit = Math.min(text.length, index + BRACKET_SCAN_CHARS);
	let end = index;
	while (end < limit && lineBreakLength(text, end) === 0) end++;
	return text.slice(index, end).trim();
}

/**
 * Whether the text after an opening bracket that does not close on its line
 * opens code structure: nothing (`get_x(`), an object, list or parameter list
 * (`register({`, `setInterval(() => {`), an arrow function or a continued
 * argument list (`map(block => {`, `pick(a,`). `abc(def` does not.
 */
function opensStructure(rest: string): boolean {
	return rest === "" || /^(?:[{[(]|\.\.\.)/.test(rest) || rest.includes("=>") || /[{([,]$/.test(rest);
}

/**
 * Whether the value at `pos` is code: a member of a configuration object
 * (`os.environ["X"]`, `self.token`, `this.#token`, `options.apiKey?.trim()`),
 * an identifier call with a matching `)` (`get_token()`,
 * `getpass.getpass("Password: ")`) or one whose argument list continues on
 * the next line (`register({`), or, where `inCode` allows code, a Rust or C++
 * path used as code (`Token::Ident,`, `std::env::VAR`).
 */
function isCodeReference(text: string, pos: number, tokenEnd: number, inCode: boolean): boolean {
	const token = text.slice(pos, tokenEnd);
	const object = CODE_OBJECT.exec(token);
	if (object) {
		const chain = MEMBER_CHAIN.exec(token.slice(object[0].length))?.[0] ?? "";
		const after = token.slice(object[0].length + chain.length);
		if (after === "") return chain !== "";
		// TypeScript's non-null assertion: `process.env.API_KEY!`, not `config.Xyz9!`.
		if (after === "!") return chain !== "" && !/\d/.test(chain);
		return /^(?:\?\.)?[[(]|^(?:\+\+|--)$/.test(after);
	}
	const callee = CALLEE.exec(token)?.[0] ?? "";
	if (callee.length === token.length && callee.includes("::")) {
		// `Hunter::Two` alone is a password. A path is code when it is a known
		// module path or punctuation follows it (`Token::Ident,`, `Kind::A)`).
		return inCode && (PATH_ROOT.test(callee) || /^[;,)}\]]/.test(text[tokenEnd] ?? ""));
	}
	if (callee.length < 3 || token[callee.length] !== "(") return false;
	const open = pos + callee.length;
	// `Summer(2024)` is a password; `get_item(0)` style calls are dotted or rare.
	if (!/\.|::/.test(callee) && /\d/.test(text[open + 1] ?? "")) return false;
	return closingBracket(text, open) >= 0 || opensStructure(restOfLine(text, open + 1));
}

/**
 * Whether a value starting with `(` is code: an arrow function
 * (`(model: Model) => …`, `(token: string): void => {`) anywhere, and, inline
 * (`expressions`), a parenthesized expression (`(a >= 1 && b)`,
 * `(await read()).trim()`) or one that continues on the next line. A return
 * type stops at `#`, so a ` # dev=>prod` comment is not one. At a line start
 * (`dotenv` and `line`) only a parameter list makes an arrow: `()`, `(a, b)`,
 * `(token: string)`, or a lone name directly before `=>`. `(Xy9!kq)`,
 * `(Xy9!kq):hunter2=>x` and `(correct horse)` at the start of a YAML line are
 * literals.
 */
function isParenthesizedCode(text: string, pos: number, place: ValuePlace): boolean {
	const expressions = place === "inline";
	const close = closingBracket(text, pos);
	if (close < 0) return expressions && opensStructure(restOfLine(text, pos + 1));
	const arrow = /^[ \t]*(:[^=#\n\r]{1,128})?=>/.exec(text.slice(close + 1, close + 140));
	if (arrow) {
		if (place === "inline") return true;
		const params = text.slice(pos + 1, close).trim();
		return (
			params === "" ||
			/^(?:\.\.\.|[{[]|[A-Za-z_$][\w$]*\??[ \t]*[:,=])/.test(params) ||
			(arrow[1] === undefined && /^[A-Za-z_$][\w$]*$/.test(params))
		);
	}
	return expressions && /,|\s/.test(text.slice(pos + 1, close).trim());
}

/**
 * Whether a value starting with `{` or `[` is a structure or placeholder
 * rather than a literal: an object or list that opens here (`{"a":…}`, `[`,
 * `{}`), a template (`{{ vault_password }}`, `{% … %}`), a format placeholder
 * (`{password}`, `{0}`), a JS object (`{key: …}`), a list of plain items, or
 * an array literal (`[offset - n, offset]`, `[...keys]`). `{Xy9!kq}` and
 * `[Xy9!kq]` are literals.
 */
function isStructuredValue(text: string, pos: number, tokenEnd: number): boolean {
	const token = text.slice(pos, tokenEnd);
	if (/^[{[]+$/.test(token) || token.startsWith("{{") || token.startsWith("{%")) return true;
	const after = text[tokenEnd];
	if (/^\{(?:[A-Za-z_$][\w$.]*|\d*)$/.test(token)) return after === "}";
	if (/^\{[A-Za-z_$][\w$]*:$/.test(token)) return true;
	if (!token.startsWith("[")) return false;
	if (/^\[[\w.$-]+$/.test(token) && (after === "," || after === "]")) return true;
	const close = closingBracket(text, pos);
	if (close < 0) return opensStructure(restOfLine(text, pos + 1));
	const inner = text.slice(pos + 1, close).trim();
	return /,|\.\.\.|\s/.test(inner);
}

/**
 * Where a value sits, which decides what code it may hold: `dotenv` for an
 * `=` assignment at a line start or in a quoted shell string
 * (`DB_PASSWORD=Hunter::Two`, `PASSWORD=(a b c)`), which holds no code but
 * references and calls; `line` for another line-start value (`token: …`);
 * `inline` otherwise.
 */
type ValuePlace = "dotenv" | "line" | "inline";

/**
 * What the first word of a value is: a possible `secret`; a `keyword` or type
 * name (`new`, `str`, `null`) that a passphrase may also start with; or
 * `code` (a reference, call, variable, structure, or an earlier redaction).
 * `expands` says whether the value sits where a shell or YAML loader expands
 * `$VAR` (unquoted or double-quoted, not a JSON string value or single-quoted
 * text).
 */
function classifyFirstToken(
	text: string,
	pos: number,
	tokenEnd: number,
	expands: boolean,
	place: ValuePlace,
): "secret" | "keyword" | "code" {
	const token = text.slice(pos, tokenEnd);
	// Text that already holds a redaction marker stays as it is, so redacting twice changes nothing.
	if (!token || token.includes("[REDACTED")) return "code";
	if (token.startsWith("(")) {
		// `PASSWORD=(a b c)` on a dotenv or shell line is a value (or a bash
		// array); only an arrow function (`refreshToken = () => {`) is code there.
		return isParenthesizedCode(text, pos, place) ? "code" : "secret";
	}
	if (token.startsWith("{") || token.startsWith("[")) return isStructuredValue(text, pos, tokenEnd) ? "code" : "secret";
	if (NON_SECRET_VALUE.test(token)) return "keyword";
	if (expands && VARIABLE_REFERENCE.test(token)) return "code";
	return isCodeReference(text, pos, tokenEnd, place !== "dotenv") ? "code" : "secret";
}

/**
 * End of a quoted value starting at `pos` (`"…"`, `'…'`, or a JSON-escaped
 * `\"…\"`), or -1 when it does not close on the same line.
 */
function quotedValueEnd(text: string, pos: number): number {
	const escaped = text[pos] === "\\";
	const quote = escaped ? text[pos + 1] : text[pos];
	for (let i = pos + (escaped ? 2 : 1); i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" || ch === "\r") return -1;
		if (ch === "\\") {
			const next = text[i + 1];
			if (next === "n" || next === "r") return -1;
			if (escaped && next === quote) return i + 2;
			i++;
			continue;
		}
		if (escaped && ch === '"') return -1;
		if (!escaped && ch === quote) return i + 1;
	}
	return -1;
}

/** Whether `index`, right after a closing quote, ends a value rather than continuing a command. */
function endsQuotedValue(text: string, index: number): boolean {
	const ch = text[index];
	return ch === undefined || /[\s,;})\]\\]/.test(ch);
}

/** Characters that end an unquoted single-token value. */
const TOKEN_VALUE_STOP = new Set([" ", "\t", "\n", "\r", "\f", "\v", '"', "'", ",", ";", "}", ")", "]"]);
const ESCAPE_AFTER_BACKSLASH = new Set(["n", "r", "t", '"', "'", "\\"]);

function tokenValueEnd(text: string, pos: number, limit = text.length): number {
	let i = pos;
	for (; i < limit; i++) {
		const ch = text[i] ?? "";
		if (TOKEN_VALUE_STOP.has(ch)) break;
		// A JSON escape such as `\n` or `\"` ends the value inside a JSON string.
		if (ch === "\\" && ESCAPE_AFTER_BACKSLASH.has(text[i + 1] ?? "")) break;
		// `&` before `name=` starts the next URL query parameter.
		if (ch === "&") {
			QUERY_PARAM_AHEAD.lastIndex = i + 1;
			if (QUERY_PARAM_AHEAD.test(text)) break;
		}
	}
	return i;
}

function trimTrailingBlanks(text: string, from: number, end: number): number {
	let i = end;
	while (i > from && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
	return i;
}

function lineValueEnd(text: string, pos: number, mode: LineMode): number {
	let i = pos;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" || ch === "\r") break;
		// ` #` starts a dotenv/YAML comment.
		if (ch === "#" && i > pos && (text[i - 1] === " " || text[i - 1] === "\t")) break;
		if (mode === "escaped" && (ch === '"' || (ch === "\\" && /[nr"]/.test(text[i + 1] ?? "")))) break;
	}
	return trimTrailingBlanks(text, pos, i);
}

/**
 * End of a value inside a quoted string the key opened (`echo 'KEY=a b c'`):
 * the closing quote or the end of the line, whichever comes first.
 */
function quotedRunEnd(text: string, pos: number, quote: string, escaped: boolean): number {
	let i = pos;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" || ch === "\r") break;
		if (ch === "\\") {
			const next = text[i + 1];
			if (next === "n" || next === "r" || (escaped && next === quote)) break;
			i++;
			continue;
		}
		// An unescaped `"` closes the string, or the JSON string around it.
		if (ch === quote || ch === '"') break;
	}
	return trimTrailingBlanks(text, pos, i);
}

/** The indentation at `index` (spaces, tabs and JSON `\t` escapes): its width and where it ends. */
function indentation(text: string, index: number): { width: number; end: number } {
	let width = 0;
	let i = index;
	for (; i < text.length; i++) {
		if (text[i] === " " || text[i] === "\t") width++;
		else if (text[i] === "\\" && text[i + 1] === "t") {
			width++;
			i++;
		} else break;
	}
	return { width, end: i };
}

/**
 * A line's numbering or diff decoration (see LINE_PREFIX): a diff `+`, then a
 * `cat -n`, `N|`, `N:` or host grep (`*N:`) line number, or a `grep -n` file
 * prefix. The groups are the `+`, the line number's separator and the path.
 */
const LINE_DECORATION = /^(\+?)(?:[ \t]*\*?\d{1,7}([|:│]|\t|\\t)|([^\s:"'`|\\]{1,200}):\d{1,7}[:-])?/;
const DECORATION_NUMBER = /[ \t]*\*?\d{1,7}/y;
/** A `grep` line number after the path: `:12:` on a matching line, `-13-` on a context line. */
const DECORATION_GREP_NUMBER = /[:-]\d{1,7}[:-]/y;

interface LineDecoration {
	plus: boolean;
	separator: string | undefined;
	path: string | undefined;
	length: number;
}

function lineDecoration(text: string, lineStart: number, keyStart: number): LineDecoration {
	const match = LINE_DECORATION.exec(text.slice(lineStart, keyStart));
	return { plus: match?.[1] === "+", separator: match?.[2], path: match?.[3], length: match?.[0].length ?? 0 };
}

/** Length of the decoration `decoration` at the start of the line at `pos`, or -1 when the line lacks it. */
function decorationLength(text: string, pos: number, decoration: LineDecoration): number {
	let i = pos;
	if (decoration.plus) {
		if (text[i] !== "+") return -1;
		i++;
	}
	if (decoration.separator !== undefined) {
		DECORATION_NUMBER.lastIndex = i;
		const number = DECORATION_NUMBER.exec(text);
		if (!number || !text.startsWith(decoration.separator, i + number[0].length)) return -1;
		i += number[0].length + decoration.separator.length;
	} else if (decoration.path !== undefined) {
		if (!text.startsWith(decoration.path, i)) return -1;
		DECORATION_GREP_NUMBER.lastIndex = i + decoration.path.length;
		const number = DECORATION_GREP_NUMBER.exec(text);
		if (!number) return -1;
		i += decoration.path.length + number[0].length;
	}
	return i - pos;
}

/** End of the line at `pos`; in a JSON string also at its closing quote. */
function lineEndIn(text: string, pos: number, mode: LineMode): number {
	for (let i = pos; i < text.length; i++) {
		if (lineBreakLength(text, i) > 0) return i;
		if (mode === "escaped") {
			if (text[i] === '"') return i;
			if (text[i] === "\\") i++;
		}
	}
	return text.length;
}

/** Start of the line after the one containing `from`, or -1 at the end of the text or JSON string. */
function nextLineStart(text: string, from: number, mode: LineMode): number {
	const lineEnd = lineEndIn(text, from, mode);
	const breakLength = lineBreakLength(text, lineEnd);
	return breakLength > 0 ? lineEnd + breakLength : -1;
}

/**
 * End of a YAML block scalar (`password: |` followed by more-indented lines)
 * whose indicator ends at `indicatorEnd`: the last line indented deeper than
 * the key's line, within BLOCK_SCALAR_MAX_LINES lines. When the key's line is
 * numbered or diff-marked (`2:  password: |`, `+  password: |`), indentation
 * is measured after that decoration and the block ends at a line without it.
 */
function blockScalarEnd(text: string, indicatorEnd: number, context: KeyContext, mode: LineMode): number {
	const decoration = lineDecoration(text, context.lineStart, context.keyStart);
	const keyLineIndent = indentation(text, context.lineStart + decoration.length);
	// A list bullet before the key counts as indentation, as in YAML: in
	// `- password: |`, a following `  user: x` is a sibling of the key.
	const keyIndent = keyLineIndent.width + Math.max(0, context.keyStart - keyLineIndent.end);
	let end = indicatorEnd;
	let pos = nextLineStart(text, indicatorEnd, mode);
	for (let lines = 0; pos >= 0 && lines < BLOCK_SCALAR_MAX_LINES; lines++) {
		const prefix = decorationLength(text, pos, decoration);
		if (prefix < 0) break;
		const indent = indentation(text, pos + prefix);
		const blank =
			indent.end >= text.length || lineBreakLength(text, indent.end) > 0 || (mode === "escaped" && text[indent.end] === '"');
		if (!blank) {
			if (indent.width <= keyIndent) break;
			end = trimTrailingBlanks(text, indent.end, lineEndIn(text, indent.end, mode));
		}
		pos = nextLineStart(text, indent.end, mode);
	}
	return end;
}

/** Whether a value reads as a phrase of lowercase words (`15 minute access tokens`). */
function isProse(value: string): boolean {
	let proseWords = 0;
	for (const word of value.split(/[ \t]+/)) if (PROSE_WORD.test(word) && ++proseWords >= 2) return true;
	return false;
}

/**
 * How far a value runs past its first word, or -1 when only the first word is
 * taken. `=` assignments at a line start (including the start of a JSON
 * string value that is not a shell command) or inside a quoted string the key
 * opened run to the end of the line (or the closing quote) with no word
 * limit. Line-start `key: value` lines run to the end of the line unless the
 * key is a Title-case label followed by a lowercase phrase (`Token: 15 minute
 * access tokens`) or a single lowercase word followed by more than
 * LINE_VALUE_MAX_WORDS words. A line value holding an expression operator
 * takes only its first word. A YAML block scalar takes its more-indented
 * lines.
 */
function extendedValueEnd(text: string, pos: number, context: KeyContext): number {
	const { separator, line, string } = context;
	if (separator === "other" || string === "shell") return -1;
	let end: number;
	if (string === "quote") {
		// The value sits in a quoted string the key opened: `echo 'KEY=a b c'`.
		if (separator === "colon" && !line) return -1;
		end = quotedRunEnd(text, pos, context.keyQuote, context.keyQuoteEscaped);
		if (separator === "assign") return end;
	} else {
		if (!line) return -1;
		end = lineValueEnd(text, pos, line);
		if (separator === "colon" && BLOCK_SCALAR_INDICATOR.test(text.slice(pos, end))) {
			return blockScalarEnd(text, end, context, line);
		}
		// An expression (`apiKey: token || fallback ? null : apiKey,`, or a shell
		// `PASSWORD=x && ./run`) is code: only its first word may be a secret.
		if (EXPRESSION_OPERATOR.test(text.slice(pos, end))) return -1;
		if (separator === "assign") return end;
	}
	const value = text.slice(pos, end);
	if (context.keyStyle === "label" && isProse(value)) return -1;
	if (context.keyStyle === "word" && wordCount(value) > LINE_VALUE_MAX_WORDS) return -1;
	return end;
}

function unquotedValueEnd(text: string, pos: number, context: KeyContext, expands: boolean): number {
	// Decide on a bounded first word. A rejected value (`{…}`, `str`, `get_x(`)
	// then costs constant time, so keys nested in it cannot make a scan quadratic;
	// an accepted value is consumed and never scanned again. Only the first key
	// of a line or quoted string has an extended value, so scanning it to the
	// end of the line stays linear too.
	const firstEnd = tokenValueEnd(text, pos, Math.min(text.length, pos + VALUE_PEEK_CHARS));
	const extended = extendedValueEnd(text, pos, context);
	const lineStart = context.line !== undefined || context.string === "quote";
	const place: ValuePlace = !lineStart ? "inline" : context.separator === "assign" ? "dotenv" : "line";
	const first = classifyFirstToken(text, pos, firstEnd, expands, place);
	if (first === "secret") return extended >= firstEnd ? extended : tokenValueEnd(text, pos);
	// `MAIL_PASSWORD=new secret phrase`: a keyword as the first word does not
	// excuse the rest of a multi-word value that is not code. A code reference
	// does (`token: this.config.token ?? null`).
	if (first === "keyword" && extended > firstEnd) {
		const value = text.slice(pos, extended);
		if (wordCount(value) > 1 && !CODE_SIGNAL.test(value)) return extended;
	}
	return -1;
}

/**
 * End of the value of a sensitive key, or -1 when there is nothing to redact.
 */
function sensitiveValueEnd(text: string, pos: number, context: KeyContext): number {
	const ch = text[pos];
	if (ch === undefined || text.startsWith("[REDACTED", pos)) return -1;
	const next = text[pos + 1];
	const escapedQuote = ch === "\\" && (next === '"' || next === "'");
	const { keyQuote, keyQuoteEscaped } = context;
	// `getpass("Password: ")`: a quote at the key's own escape level closes the
	// string the key sits in. It does not open a value.
	if (keyQuote && (keyQuoteEscaped ? escapedQuote && next === keyQuote : ch === keyQuote)) return -1;
	if (ch !== '"' && ch !== "'" && !escapedQuote) return unquotedValueEnd(text, pos, context, keyQuote !== "'");
	const quoteLength = escapedQuote ? 2 : 1;
	// Shell and YAML expand `"$VAR"`; JSON string values and single quotes do not.
	const expands = (escapedQuote ? next : ch) === '"' && !context.keyQuoted;
	const end = quotedValueEnd(text, pos);
	if (end < 0) {
		// An unclosed quote never runs past the line: redact the word (or, at
		// line start, the rest of the line) right after it, if there is one.
		if (/\s/.test(text[pos + quoteLength] ?? " ")) return -1;
		return unquotedValueEnd(text, pos + quoteLength, context, expands);
	}
	const inner = text.slice(pos + quoteLength, end - quoteLength);
	if (!inner || inner.startsWith("[REDACTED") || (expands && VARIABLE_REFERENCE.test(inner))) return -1;
	// `read -p "Enter password: " pw; echo "x"`: text that starts with a space
	// and runs into more command text is the rest of a prompt string, not a
	// quoted secret. `"password": "  spaced"` is a value.
	if (/^\s/.test(inner) && !endsQuotedValue(text, end)) return -1;
	return end;
}

/**
 * A bare `auth` key is usually a word (`auth: required`, `auth: AuthService`),
 * but Docker's `config.json` stores registry credentials as
 * `"auth": "<base64 user:pass>"`, so its value counts when it is
 * credential-shaped.
 */
function isBareAuthKey(key: string): boolean {
	return key.toLowerCase() === "auth";
}

function isBareAuthCredential(value: string): boolean {
	const token = value.replace(/^\\?["']|\\?["']$/g, "");
	return !/\s/.test(token) && looksLikeCredential(token, 8);
}

function redactAssignments(text: string): string {
	const ranges: Array<readonly [number, number]> = [];
	const pattern = new RegExp(ASSIGNMENT_KEY.source, ASSIGNMENT_KEY.flags);
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const [whole, openQuote = "", key = "", closeQuote = "", separator = ""] = match;
		const sensitive = isSensitiveKey(key);
		if (!sensitive && !isBareAuthKey(key)) continue;
		// A path component directly followed by `:` is a `src:dst` mount or a
		// path suffix (`~/.aws/credentials:/root/.aws/credentials:ro`), not a key.
		const colon = separator === ":" || separator === "::";
		if (colon && !openQuote && !closeQuote && text[match.index - 1] === "/" && whole.endsWith(separator)) continue;
		const valueStart = match.index + whole.length;
		const keyQuote = openQuote && !closeQuote ? (openQuote.at(-1) ?? "") : "";
		const keyQuoteEscaped = keyQuote !== "" && (openQuote.length === 2 || text[match.index - 1] === "\\");
		const field = keyQuote === '"' ? jsonStringField(text, match.index + openQuote.length) : undefined;
		const lineStart =
			field === undefined
				? lineStartOf(text, match.index)
				: SHELL_COMMAND_FIELDS.has(field)
					? undefined
					: { mode: "escaped" as const, start: match.index + openQuote.length };
		const context: KeyContext = {
			keyQuote,
			keyQuoteEscaped,
			keyQuoted: openQuote !== "" && closeQuote !== "",
			string: field === undefined ? (keyQuote ? "quote" : undefined) : SHELL_COMMAND_FIELDS.has(field) ? "shell" : "json",
			line: lineStart?.mode,
			lineStart: lineStart?.start ?? 0,
			keyStart: match.index,
			separator: separatorKind(separator),
			keyStyle: keyStyle(key),
		};
		const end = sensitiveValueEnd(text, valueStart, context);
		if (end <= valueStart || (!sensitive && !isBareAuthCredential(text.slice(valueStart, end)))) continue;
		const keyStart = match.index + whole.indexOf(key, openQuote.length);
		ranges.push([openQuote && closeQuote ? match.index : keyStart, end]);
		pattern.lastIndex = end;
	}
	return applyRanges(text, ranges, REDACTED_CREDENTIAL);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function redactText(text: string): string {
	let result = redactPrivateKeys(text);
	// Token/header patterns run before the assignment pass, which would
	// otherwise take only the scheme word of `Authorization: Bearer <secret>`.
	for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
	result = redactAuthSchemeCredentials(result);
	return redactAssignments(result);
}

/**
 * Redact strings in a structured value before it reaches a log. Depth is
 * bounded because worker/tool details can contain arbitrary nested payloads.
 */
export function redactValue(value: unknown, depth = 0): unknown {
	if (depth > 6) return "[depth limit]";
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
		if (isSensitiveKey(key) || (isBareAuthKey(key) && typeof item === "string" && isBareAuthCredential(item))) {
			result[key] = "[REDACTED]";
		} else {
			result[key] = redactValue(item, depth + 1);
		}
	}
	return result;
}

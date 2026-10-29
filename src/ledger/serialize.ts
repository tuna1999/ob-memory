import { MAX_SOURCE_ENTRY_CHARS, estimateTextTokens } from "../constants";
import { formatLocalTimestamp, parseTimestamp } from "../util/time";
import type { TokenEstimator } from "../util/tokens";
import { isSourceEntry, type LedgerEntry } from "./types";

export interface SerializedEntryOptions {
	observeAttachments?: boolean;
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

function blockText(block: ContentBlock, options: SerializedEntryOptions): string {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking: ${block.thinking}]`;
	if (block.type === "toolCall" && typeof block.name === "string") {
		return `[tool call ${block.name}(${JSON.stringify(block.arguments ?? {})})]`;
	}
	if (block.type === "image") {
		return options.observeAttachments && typeof block.mimeType === "string"
			? `[image: ${block.mimeType}]`
			: "[image omitted]";
	}
	if (block.type === "redactedThinking") return "[redacted thinking omitted]";
	return `[${typeof block.type === "string" ? block.type : "non-text"} content omitted]`;
}

function contentText(content: unknown, options: SerializedEntryOptions): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return contentBlocks(content).map((block) => blockText(block, options)).filter(Boolean).join("\n");
}

function messageField(message: unknown, key: "timestamp" | "role" | "content" | "toolName"): unknown {
	if (!message || typeof message !== "object" || !(key in message)) return undefined;
	const record = message as Record<string, unknown>;
	return record[key];
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

function truncateRendered(text: string, maxChars = MAX_SOURCE_ENTRY_CHARS): string {
	if (text.length <= maxChars) return text;
	const marker = `\n[… ${text.length - maxChars} chars truncated; original remains in the session ledger …]\n`;
	const retained = Math.max(1, maxChars - marker.length);
	const head = Math.ceil(retained / 2);
	return `${text.slice(0, head)}${marker}${text.slice(-(retained - head))}`;
}

/** Render one source entry as plain text for a worker prompt. */
export function serializeEntry(entry: LedgerEntry, options: SerializedEntryOptions = {}): string {
	const time = formatLocalTimestamp(parseTimestamp(entry.timestamp) ?? Date.now());
	if (entry.type === "custom_message") {
		const label = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
		return truncateRendered(`[${label} @ ${time}]: ${contentText(entry.content, options)}`);
	}
	if (entry.type === "branch_summary") {
		return truncateRendered(`[Branch summary @ ${time}]: ${typeof entry.summary === "string" ? entry.summary : ""}`);
	}
	if (entry.type !== "message") return "";
	const role = messageRole(entry.message);
	if (!role) return "";
	const body = truncateRendered(contentText(messageField(entry.message, "content"), options));
	if (role === "toolResult") {
		const rawToolName = messageField(entry.message, "toolName");
		const toolName = typeof rawToolName === "string" ? rawToolName : "tool";
		return `[Tool result for ${toolName} @ ${messageTime(entry.message, entry)}]: ${body}`;
	}
	if (role === "user") return `[User @ ${messageTime(entry.message, entry)}]: ${body}`;
	if (role === "assistant") return `[Assistant @ ${messageTime(entry.message, entry)}]: ${body}`;
	if (role === "developer" || role === "system") {
		return `[${role[0]?.toUpperCase()}${role.slice(1)} @ ${messageTime(entry.message, entry)}]: ${body}`;
	}
	return `[${role} @ ${messageTime(entry.message, entry)}]: ${body}`;
}

export function estimateEntryTokens(
	entry: LedgerEntry,
	estimate: TokenEstimator = estimateTextTokens,
	options: SerializedEntryOptions = {},
): number {
	const text = serializeEntry(entry, options);
	return text ? estimate(text) : 0;
}

export interface SerializedSource {
	text: string;
	sourceEntryIds: string[];
	truncatedSourceEntryIds: string[];
	tokens: number;
}

interface SerializedBlock {
	entry: LedgerEntry;
	text: string;
	tokens: number;
}

function sourceBlock(
	entry: LedgerEntry,
	estimate: TokenEstimator,
	options: SerializedEntryOptions,
): SerializedBlock | undefined {
	const rendered = serializeEntry(entry, options);
	if (!rendered.trim()) return undefined;
	const text = `[Source entry id: ${entry.id}]\n${rendered}`;
	return { entry, text, tokens: estimate(text) };
}

/** Serialize entries with stable source labels, optionally bounded by tokens. */
export function serializeSourceEntries(
	entries: readonly LedgerEntry[],
	options: { maxTokens?: number; estimate?: TokenEstimator; observeAttachments?: boolean } = {},
): SerializedSource {
	const estimate = options.estimate ?? estimateTextTokens;
	const entryOptions: SerializedEntryOptions = { observeAttachments: options.observeAttachments };
	const blocks: SerializedBlock[] = [];
	const sourceEntryIds: string[] = [];
	const truncatedSourceEntryIds: string[] = [];
	let tokens = 0;
	for (const entry of entries) {
		if (!isSourceEntry(entry)) continue;
		const block = sourceBlock(entry, estimate, entryOptions);
		if (!block) continue;
		const separator = blocks.length > 0 ? 2 : 0;
		if (options.maxTokens !== undefined && tokens + block.tokens + separator > options.maxTokens) {
			if (blocks.length > 0) break;
			const marker = "\n[… source entry truncated to fit the worker input budget …]\n";
			const budgetChars = Math.max(200, options.maxTokens * 4 - marker.length - 60);
			const head = Math.ceil(budgetChars / 2);
			const rendered = serializeEntry(entry, entryOptions);
			const text = `[Source entry id: ${entry.id}]\n${rendered.slice(0, head)}${marker}${rendered.slice(-(budgetChars - head))}`;
			blocks.push({ entry, text, tokens: estimate(text) });
			sourceEntryIds.push(entry.id);
			truncatedSourceEntryIds.push(entry.id);
			tokens = estimate(text);
			break;
		}
		blocks.push(block);
		sourceEntryIds.push(entry.id);
		tokens += block.tokens + separator;
	}
	return {
		text: blocks.map((block) => block.text).join("\n\n"),
		sourceEntryIds,
		truncatedSourceEntryIds,
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

function safeStartIndex(entries: readonly LedgerEntry[], index: number): number {
	let start = Math.max(0, index);
	while (start > 0 && isToolResultEntry(entries[start])) start--;
	return start;
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
 * Select the oldest unobserved source entries up to a token budget. The cut is
 * never placed immediately before a tool result, so an observation watermark
 * cannot split a tool call from its result across chunks.
 */
export function chunkUnobservedEntries(
	entries: readonly LedgerEntry[],
	coverageId: string | undefined,
	maxTokens: number,
	estimate: TokenEstimator = estimateTextTokens,
	options: SerializedEntryOptions = {},
): SourceChunk | undefined {
	const coverageIndex = coverageId ? entries.findIndex((entry) => entry.id === coverageId) : -1;
	const start = safeStartIndex(entries, coverageIndex + 1);
	const selected: LedgerEntry[] = [];
	let tokens = 0;
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || !isSourceEntry(entry)) continue;
		const block = sourceBlock(entry, estimate, options);
		if (!block) continue;
		const preservesToolPair =
			isToolResultEntry(entry) &&
			selected.length > 0 &&
			(isAssistantToolCall(selected[selected.length - 1]) || isToolResultEntry(selected[selected.length - 1]));
		if (selected.length > 0 && tokens + block.tokens > maxTokens && !preservesToolPair) break;
		selected.push(entry);
		tokens += block.tokens;
	}
	if (selected.length === 0) return undefined;
	const serialized = serializeSourceEntries(selected, {
		maxTokens: Math.max(maxTokens, 256),
		estimate,
		observeAttachments: options.observeAttachments,
	});
	if (!serialized.text) return undefined;
	const last = selected[selected.length - 1]!;
	return {
		entries: selected,
		text: serialized.text,
		sourceEntryIds: serialized.sourceEntryIds,
		truncatedSourceEntryIds: serialized.truncatedSourceEntryIds,
		coversUpToId: last.id,
		tokens: serialized.tokens,
	};
}

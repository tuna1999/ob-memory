import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	latestCoverageIndex,
	latestResetBoundaryIndex,
	rawTokensAfterIndex,
	type UnobservedSourceSpan,
} from "../ledger/fold";
import { OM_OBSERVATIONS_RECORDED, isObservationsRecordedEntry, type LedgerEntry } from "../ledger/types";
import type { SessionRuntime } from "../runtime";
import type { TokenEstimator } from "../util/tokens";

export type CompactionReason = "threshold" | "overflow" | "idle" | "incomplete" | "manual";

export type CutResolution =
	| {
			kind: "cut";
			firstKeptEntryId: string;
			foldThroughEntryId: string;
			gap?: UnobservedSourceSpan;
			retainedTokens?: number;
	  }
	| { kind: "delegate"; reason: string; gap?: UnobservedSourceSpan };

/**
 * Per-image charge used only when the host tokenizer cannot price a message;
 * roughly what the host's catalog image rules bill for a 1280x800 screenshot.
 */
const IMAGE_TOKENS_FALLBACK = 1_600;

export interface ContextTokenCounter {
	/** Context tokens a retained session entry costs once it is kept verbatim. */
	entry(entry: LedgerEntry): number;
	/** Context tokens of one agent message (e.g. from the compaction preparation). */
	message(message: unknown): number;
}

/** The agent message the host replays for a source entry (pi-agent-core `getMessageFromEntry`). */
function contextMessage(entry: LedgerEntry): unknown {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return { role: "custom", customType: entry.customType, content: entry.content, display: true, timestamp: 0 };
	}
	if (entry.type === "branch_summary") {
		return { role: "branchSummary", summary: typeof entry.summary === "string" ? entry.summary : "", fromId: entry.fromId, timestamp: 0 };
	}
	return undefined;
}

function blockTokens(block: unknown, estimate: TokenEstimator): number {
	if (!block || typeof block !== "object") return 0;
	const record = block as Record<string, unknown>;
	if (record.type === "image") return IMAGE_TOKENS_FALLBACK;
	let text = "";
	if (typeof record.text === "string") text = record.text;
	else if (typeof record.thinking === "string") text = record.thinking;
	else if (record.type === "toolCall") text = `${String(record.name ?? "")}${JSON.stringify(record.arguments ?? {})}`;
	return text ? estimate(text) : 0;
}

/** Untruncated local estimate for messages the host tokenizer rejects. */
function localMessageTokens(message: unknown, estimate: TokenEstimator): number {
	if (!message || typeof message !== "object") return 0;
	const record = message as Record<string, unknown>;
	let total = typeof record.summary === "string" ? estimate(record.summary) : 0;
	const content = record.content;
	if (typeof content === "string") total += estimate(content);
	else if (Array.isArray(content)) for (const block of content) total += blockTokens(block, estimate);
	return total;
}

/**
 * Count retained context the way the host measures it after compaction
 * (session-maintenance.ts `#compactionCreatedHeadroom` counts stored messages
 * with `Tokenizer.countMessage`): the whole message, with images priced by the
 * model's image rule. The worker-prompt serialization truncates each entry to
 * 40k characters and renders images as a placeholder, so it undercounts
 * exactly the tails (large tool output, screenshots) that bust the host's
 * recovery band.
 */
export function createContextTokenCounter(runtime: SessionRuntime): ContextTokenCounter {
	let tokenizer: Tokenizer | undefined;
	try {
		tokenizer = new Tokenizer((runtime.ctx.model ?? null) as never);
	} catch {
		tokenizer = undefined;
	}
	const estimate = runtime.estimator;
	const message = (value: unknown): number => {
		if (!value || typeof value !== "object") return 0;
		if (tokenizer) {
			try {
				const tokens = tokenizer.countMessage(value as never);
				if (Number.isFinite(tokens) && tokens >= 0) return tokens;
			} catch {
				// Malformed or foreign message shape: fall back to the local estimate.
			}
		}
		return localMessageTokens(value, estimate);
	};
	return {
		message,
		entry: (entry) => message(contextMessage(entry)),
	};
}

function messageRole(entry: LedgerEntry): string | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	if (!("role" in entry.message)) return undefined;
	return typeof entry.message.role === "string" ? entry.message.role : undefined;
}

export function isCutPointEntry(entry: LedgerEntry): boolean {
	if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
	if (entry.type !== "message") return false;
	const role = messageRole(entry);
	return role !== undefined && role !== "toolResult";
}

export function entryIndexForId(entries: readonly LedgerEntry[], id: string): number {
	return entries.findIndex((entry) => entry.id === id);
}

function lastSourceIndexBefore(entries: readonly LedgerEntry[], cutIndex: number): number {
	for (let i = cutIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry && (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")) {
			return i;
		}
	}
	return -1;
}

function lastResetBoundaryIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "reset_boundary") return i;
	}
	return -1;
}

function safeCutAtOrBefore(entries: readonly LedgerEntry[], index: number, minimum: number): number {
	for (let i = Math.min(index, entries.length - 1); i >= minimum; i--) {
		const entry = entries[i];
		if (entry && isCutPointEntry(entry)) return i;
	}
	return -1;
}

/**
 * A chunk the observer gave up on after repeated unproductive runs: its
 * coverage-only marker (`coverageReason: "retry_limit"`, no observations)
 * moves the observer watermark past the chunk so newer content is still
 * observed, but nothing in the chunk was ever observed.
 */
export interface SkippedSourceSpan {
	/** First branch index the skipped chunk could start at. */
	firstIndex: number;
	/** Branch index of the marker's `coversUpToId`. */
	lastIndex: number;
}

/**
 * Every `retry_limit` span on the branch. A span starts after the watermark
 * the observer chunked from: the previous observation record's
 * `coversUpToId` (any record, including another marker), or the `/clear`
 * boundary in force then when that is later or there was no record. It ends
 * at the marker's own `coversUpToId`.
 */
export function skippedSourceSpans(entries: readonly LedgerEntry[]): SkippedSourceSpan[] {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i]!.id, i);
	const spans: SkippedSourceSpan[] = [];
	let watermark = -1;
	let reset = -1;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type === "reset_boundary") {
			reset = i;
			continue;
		}
		if (!isObservationsRecordedEntry(entry)) continue;
		const covered = indexes.get(entry.data.coversUpToId) ?? -1;
		if (entry.data.coverageReason === "retry_limit" && entry.data.observations.length === 0) {
			const firstIndex = Math.max(watermark, reset) + 1;
			if (covered >= firstIndex) spans.push({ firstIndex, lastIndex: covered });
		}
		// The chunker starts from the latest record's watermark, or from the
		// branch start when that id is not on the branch.
		watermark = covered;
	}
	return spans;
}

function indexBefore(entries: readonly LedgerEntry[], id: unknown, end: number): number {
	if (typeof id !== "string" || !id) return -1;
	for (let i = 0; i < end; i++) {
		if (entries[i]?.id === id) return i;
	}
	return -1;
}

/**
 * First branch index the compaction at `compactionIndex` keeps in context,
 * like host session-context.ts: its first kept entry when that precedes it;
 * otherwise, for a provider-native compaction (remote or server-side)
 * committed in the background, the entries after the provider's replay
 * snapshot (`providerReplayThroughEntryId`), which the host replays and the
 * next preparation summarizes; otherwise only what follows the compaction.
 */
function compactionKeptStartIndex(entries: readonly LedgerEntry[], compactionIndex: number): number {
	const compaction = entries[compactionIndex];
	if (!compaction) return compactionIndex + 1;
	const keptIndex = indexBefore(entries, compaction.firstKeptEntryId, compactionIndex);
	if (keptIndex >= 0) return keptIndex;
	const replayThroughId = (compaction as unknown as Record<string, unknown>).providerReplayThroughEntryId;
	const replayThroughIndex = indexBefore(entries, replayThroughId, compactionIndex);
	return replayThroughIndex >= 0 ? replayThroughIndex + 1 : compactionIndex + 1;
}

/**
 * First branch index still in model context: after the latest `/clear`, and
 * from the latest compaction's kept tail (see `compactionKeptStartIndex`).
 */
export function liveContextStartIndex(entries: readonly LedgerEntry[]): number {
	let start = latestResetBoundaryIndex(entries) + 1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type !== "compaction") continue;
		start = Math.max(start, compactionKeptStartIndex(entries, i));
		break;
	}
	return start;
}

/**
 * Observation coverage compaction may treat as observed. A `retry_limit`
 * span that is still in model context was never observed, so coverage counts
 * only up to the entry before the earliest such span (clamped to the live
 * context start). Spans wholly before the live context already left it and
 * are ignored here; the compaction summary that holds them is carried forward
 * by owned compactions instead (compaction.ts `carriedSummary`). The observer
 * watermark itself is unaffected.
 */
export function observedCoverageIndex(
	entries: readonly LedgerEntry[],
	coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED),
): number {
	if (coverageIndex < 0) return coverageIndex;
	const spans = skippedSourceSpans(entries);
	if (spans.length === 0) return coverageIndex;
	const liveStart = liveContextStartIndex(entries);
	let observed = coverageIndex;
	for (const span of spans) {
		if (span.lastIndex < liveStart) continue;
		observed = Math.min(observed, Math.max(span.firstIndex, liveStart) - 1);
	}
	return observed;
}

/**
 * Resolve the final cut. If the observer has not covered the proposed cut, we
 * either retain the unobserved tail by moving the boundary back to a safe cut,
 * or delegate to native compaction. We never silently discard unobserved
 * source: a chunk the observer skipped (`retry_limit`) that is still in model
 * context counts as unobserved even though the watermark passed it.
 */
export function resolveCompactionCut(
	entries: readonly LedgerEntry[],
	firstKeptEntryId: string,
	coverageIndex: number,
	options: {
		reason: CompactionReason;
		runtime: SessionRuntime;
		rangeStartIndex: number;
	},
): CutResolution {
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	if (cutIndex === -1) return { kind: "delegate", reason: "cut entry is not on the active branch" };
	if (!isCutPointEntry(entries[cutIndex]!)) {
		return { kind: "delegate", reason: "proposed cut is not a valid conversation cut point" };
	}
	if (coverageIndex < 0) return { kind: "delegate", reason: "no observation coverage" };
	// Ownership is decided on observed coverage; the summary still folds
	// through the watermark, because records past a skipped span describe
	// context that is retained verbatim and are redundant with it, never lost.
	const observedIndex = observedCoverageIndex(entries, coverageIndex);
	if (observedIndex < 0) return { kind: "delegate", reason: "skipped source starts the live context" };
	const lastSource = lastSourceIndexBefore(entries, cutIndex);
	if (lastSource === -1 || observedIndex >= lastSource) {
		// Coverage can run past Pi's cut. Fold through the coverage marker, not
		// the cut: observations recorded against entries after the cut still
		// describe real context and must reach the summary. The retained source
		// is redundant with them, never lost.
		const foldThrough = entries[coverageIndex]?.id ?? entries[cutIndex]?.id;
		if (!foldThrough) return { kind: "delegate", reason: "cut entry missing" };
		return { kind: "cut", firstKeptEntryId, foldThroughEntryId: foldThrough };
	}

	const gapStart = observedIndex + 1;
	let gapEnd = cutIndex - 1;
	while (gapEnd >= gapStart) {
		const entry = entries[gapEnd];
		if (entry && (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")) break;
		gapEnd--;
	}
	if (gapEnd < gapStart) {
		return { kind: "cut", firstKeptEntryId, foldThroughEntryId: firstKeptEntryId };
	}
	const gapEntryIds: string[] = [];
	for (let i = gapStart; i <= gapEnd; i++) {
		const entry = entries[i];
		if (entry) gapEntryIds.push(entry.id);
	}
	const gap: UnobservedSourceSpan = {
		firstIndex: gapStart,
		lastIndex: gapEnd,
		entryCount: gapEntryIds.length,
		entryIds: gapEntryIds,
	};

	if (options.reason === "overflow") return { kind: "delegate", reason: "overflow recovery", gap };

	// A `/clear` reset is a lower bound just like the previous compaction:
	// keeping entries from before it would put cleared conversation back into
	// the model context.
	const lowerBound = Math.max(options.rangeStartIndex, lastResetBoundaryIndex(entries));
	const safeCut = safeCutAtOrBefore(entries, gapStart, lowerBound + 1);
	if (safeCut <= lowerBound) {
		return { kind: "delegate", reason: "no safe cut point before unobserved source", gap };
	}
	const counter = createContextTokenCounter(options.runtime);
	const retainedTokens = rawTokensAfterIndex(entries, safeCut - 1, (entry) => counter.entry(entry));
	const maxRetained = options.runtime.config.compactionMaxRetainedTokens;
	if (maxRetained !== undefined && retainedTokens > maxRetained) {
		return {
			kind: "delegate",
			reason: `retaining ~${retainedTokens.toLocaleString()} unobserved tokens exceeds the ${maxRetained.toLocaleString()} token budget`,
			gap,
		};
	}
	const coverageId = entries[coverageIndex]?.id;
	if (!coverageId) return { kind: "delegate", reason: "coverage entry missing", gap };
	return {
		kind: "cut",
		firstKeptEntryId: entries[safeCut]!.id,
		foldThroughEntryId: coverageId,
		gap,
		retainedTokens,
	};
}

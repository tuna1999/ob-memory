import { latestCoverageIndex } from "./fold";
import { OM_OBSERVATIONS_RECORDED, type LedgerEntry } from "./types";

type UsageLike = {
	contextTokens?: unknown;
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
};

function positiveTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Provider-reported context size for one assistant usage record. */
export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as UsageLike;
	const direct = positiveTokenCount(record.contextTokens) ?? positiveTokenCount(record.totalTokens);
	if (direct !== undefined) return direct;
	const parts = [record.input, record.output, record.cacheRead, record.cacheWrite];
	if (!parts.every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
	const sum = parts.reduce<number>((total, part) => total + (part as number), 0);
	return sum > 0 ? sum : undefined;
}

function validAssistantContextTokens(entry: LedgerEntry): number | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as { role?: unknown; stopReason?: unknown; usage?: unknown };
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
		return undefined;
	}
	return contextTokensFromUsage(message.usage);
}

function realContextTokensAfterCompaction(entries: readonly LedgerEntry[], compactionIndex: number): number | undefined {
	for (let i = compactionIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const tokens = validAssistantContextTokens(entry);
		if (tokens !== undefined) return tokens;
	}
	return undefined;
}

function realContextTokensAtCoverage(
	entries: readonly LedgerEntry[],
	coverageIndex: number,
	floorIndex: number,
): number | undefined {
	for (let i = coverageIndex; i >= floorIndex; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const tokens = validAssistantContextTokens(entry);
		if (tokens !== undefined) return tokens;
	}
	return undefined;
}

/**
 * Provider-reported context growth since the observer's latest coverage anchor
 * (or since the latest compaction when coverage is behind it).
 *
 * Returns `undefined` before the first observation coverage and when no
 * compaction exists: provider context at that point includes the system prompt
 * and tools, which are not unobserved conversation. The raw estimate stays
 * authoritative until there is a real anchor.
 *
 * Returns `undefined` when no trustworthy baseline exists or the context shrank
 * (for example, a mid-session accounting-basis change); callers then fall back
 * to the raw token estimate instead of measuring from zero.
 */
export function realTokensSinceObservationCoverage(
	entries: readonly LedgerEntry[],
	currentContextTokens: number | undefined,
): number | undefined {
	if (
		currentContextTokens === undefined
		|| !Number.isFinite(currentContextTokens)
		|| currentContextTokens < 0
	) {
		return undefined;
	}
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	let compactionIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	let baseline: number | undefined;
	if (compactionIndex > coverageIndex) {
		baseline = realContextTokensAfterCompaction(entries, compactionIndex);
	} else if (coverageIndex >= 0) {
		// Never anchor on usage from before a compaction: that usage describes
		// the pre-compaction context, not the post-compaction basis.
		const floorIndex = compactionIndex >= 0 ? compactionIndex + 1 : 0;
		baseline = realContextTokensAtCoverage(entries, coverageIndex, floorIndex);
	} else {
		return undefined;
	}
	if (baseline === undefined) return undefined;
	const delta = currentContextTokens - baseline;
	return delta >= 0 ? delta : undefined;
}

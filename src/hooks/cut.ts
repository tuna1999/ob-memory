import { rawTokensAfterIndex, type UnobservedSourceSpan } from "../ledger/fold";
import { estimateEntryTokens } from "../ledger/serialize";
import type { LedgerEntry } from "../ledger/types";
import type { SessionRuntime } from "../runtime";

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
 * Resolve the final cut. If the observer has not covered the proposed cut, we
 * either retain the unobserved tail by moving the boundary back to a safe cut,
 * or delegate to native compaction. We never silently discard unobserved
 * source.
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
	const lastSource = lastSourceIndexBefore(entries, cutIndex);
	if (lastSource === -1 || coverageIndex >= lastSource) {
		const foldThrough = entries[cutIndex]?.id;
		if (!foldThrough) return { kind: "delegate", reason: "cut entry missing" };
		return { kind: "cut", firstKeptEntryId, foldThroughEntryId: foldThrough };
	}

	const gapStart = coverageIndex + 1;
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
	const retainedTokens = rawTokensAfterIndex(entries, safeCut - 1, (entry) => estimateEntryTokens(entry, options.runtime.estimator));
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

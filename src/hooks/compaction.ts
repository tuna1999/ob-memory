import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import {
	OM_OBSERVATIONS_RECORDED,
	type LedgerEntry,
	type MemoryDetails,
} from "../ledger/types";
import {
	compactionProjection,
	latestCoverageId,
	latestCoverageIndex,
} from "../ledger/fold";
import { renderMemory } from "../ledger/render";
import { chunkUnobservedEntries } from "../ledger/serialize";
import { resolveObserverChunkMaxTokens } from "../config";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { resolveWorkerModel } from "../workers/model";
import { observeChunk, cancelScheduledConsolidation } from "../workers/trigger";
import { resolveCompactionCut, type CompactionReason, type CutResolution } from "./cut";
import {
	compactionRetainedBudget,
	compactionSummaryBudget,
	recordAutoCompactionEnd,
	recordAutoCompactionStart,
	resolveCompactionReason,
	shouldOwnCompaction,
} from "./policy";

/** Upper bound on waiting for an aborted background pass to release the lock. */
const COMPACTION_PREEMPT_WAIT_MS = 5_000;

interface CatchUpOutcome {
	chunks: number;
	entries: LedgerEntry[];
	coverageIndex: number;
}

async function catchUp(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	entries: LedgerEntry[],
	coverageId: string | undefined,
	deadline: number,
	complete?: typeof completeSimple,
): Promise<CatchUpOutcome> {
	let chunks = 0;
	let currentEntries = entries;
	let currentCoverageId = coverageId;
	if (Date.now() >= deadline) {
		return {
			chunks,
			entries: currentEntries,
			coverageIndex: latestCoverageIndex(currentEntries, OM_OBSERVATIONS_RECORDED),
		};
	}
	const ran = await runtime.runExclusive("compaction.catchup", async (signal) => {
		const combined = AbortSignal.any([signal, event.signal]);
		if (Date.now() >= deadline) return;
		const model = await resolveWorkerModel(runtime.ctx, runtime.config, combined);
		if (combined.aborted || Date.now() >= deadline) return;
		if (!model.ok) {
			runtime.noteFailure("compaction.catchup.resolve", model.reason);
			return;
		}
		const chunkMaxTokens = resolveObserverChunkMaxTokens(
			runtime.config,
			model.value.model.contextWindow,
		);
		for (let i = 0; i < runtime.config.compactionCatchUpMaxChunks; i++) {
			const remaining = deadline - Date.now();
			if (remaining <= 0 || combined.aborted) break;
			const chunk = chunkUnobservedEntries(
				currentEntries,
				currentCoverageId,
				chunkMaxTokens,
				runtime.estimator,
				{ observeAttachments: runtime.config.observeAttachments },
			);
			if (!chunk) break;
			// Bound the awaited worker call, not only the gaps between chunks.
			// A timeout is a normal catch-up miss, not a worker failure.
			const chunkSignal = AbortSignal.any([combined, AbortSignal.timeout(remaining)]);
			let records;
			try {
				records = await observeChunk(runtime, currentEntries, model.value, chunk, chunkSignal, complete);
			} catch (error) {
				if (chunkSignal.aborted) break;
				throw error;
			}
			if (!records) break;
			chunks++;
			currentEntries = runtime.ctx.sessionManager.getBranch() as LedgerEntry[];
			currentCoverageId = latestCoverageId(currentEntries, OM_OBSERVATIONS_RECORDED);
		}
	}, { requireIdle: false });
	return {
		chunks: ran ? chunks : 0,
		entries: currentEntries,
		coverageIndex: latestCoverageIndex(currentEntries, OM_OBSERVATIONS_RECORDED),
	};
}

function delegate(
	runtime: SessionRuntime,
	reason: CompactionReason,
	why: string,
	gap?: { gap?: { entryCount: number } },
): undefined {
	runtime.lastCompactionOwned = false;
	runtime.debug.record("compaction", "delegated", {
		reason,
		why,
		gapEntries: gap?.gap?.entryCount,
	});
	return undefined;
}

function buildCompactionResult(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	resolution: Extract<CutResolution, { kind: "cut" }>,
	entries: LedgerEntry[],
): SessionBeforeCompactResult | undefined {
	const projection = compactionProjection(entries, resolution.foldThroughEntryId);
	if (projection.observations.length + projection.reflections.length === 0) return undefined;
	const rendered = renderMemory(projection.reflections, projection.observations, {
		maxTokens: compactionSummaryBudget(runtime),
		estimate: runtime.estimator,
	});
	if (!rendered.text || rendered.observations.length + rendered.reflections.length === 0) return undefined;

	if (resolution.retainedTokens !== undefined) {
		const retainedBudget = compactionRetainedBudget(runtime);
		if (resolution.retainedTokens + rendered.tokens > retainedBudget) {
			runtime.debug.record("compaction", "retained_budget_exceeded", {
				retainedTokens: resolution.retainedTokens,
				summaryTokens: rendered.tokens,
				retainedBudget,
			});
			return undefined;
		}
	}

	const details: MemoryDetails = {
		...projection.details,
		observations: rendered.observations,
		reflections: rendered.reflections,
		foldThroughEntryId: resolution.foldThroughEntryId,
	};
	const summary = runtime.config.redactSecrets ? redactText(rendered.text) : rendered.text;
	const compaction: CompactionResult<MemoryDetails> = {
		summary,
		shortSummary: `Observational memory: ${rendered.observations.length} observations, ${rendered.reflections.length} reflections`,
		firstKeptEntryId: resolution.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	};
	runtime.lastCompactionOwned = true;
	runtime.lastCompactionAt = Date.now();
	runtime.lastCompactionRecords = rendered.observations.length + rendered.reflections.length;
	runtime.debug.record("compaction", "owned", {
		firstKeptEntryId: resolution.firstKeptEntryId,
		foldThroughEntryId: resolution.foldThroughEntryId,
		observations: rendered.observations.length,
		reflections: rendered.reflections.length,
		summaryTokens: rendered.tokens,
		retainedTokens: resolution.retainedTokens,
		gap: resolution.gap?.entryCount,
	});
	return { compaction };
}

/**
 * Take ownership of compaction only when the ledger covers every source entry
 * being summarized, or when the uncovered tail can be retained within budget.
 * Otherwise native compaction runs, preserving the raw context.
 */
export async function handleSessionBeforeCompact(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	options: { complete?: typeof completeSimple } = {},
): Promise<SessionBeforeCompactResult | undefined> {
	cancelScheduledConsolidation(runtime);
	runtime.updateContext(ctx);
	const reason = resolveCompactionReason(runtime);
	if (event.signal.aborted) return undefined;
	try {
		if (event.customInstructions?.trim()) {
			return delegate(runtime, reason, "user focus instructions require native summarization");
		}
		let entries = event.branchEntries as LedgerEntry[];
		let coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
		if (!shouldOwnCompaction(runtime, reason, coverageIndex >= 0)) {
			return delegate(runtime, reason, "policy or no coverage");
		}

		const rangeStart = (() => {
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.type === "compaction") return i;
			}
			return -1;
		})();
		let resolution = resolveCompactionCut(entries, event.preparation.firstKeptEntryId, coverageIndex, {
			reason,
			runtime,
			rangeStartIndex: rangeStart,
		});

		// Catch up whenever the observer is behind the proposed cut, even when
		// the initial resolution would delegate because the uncovered tail does
		// not fit. Catch-up can shrink that tail enough to own the compaction.
		const catchUpBudgetMs = runtime.config.compactionCatchUpBudgetMs;
		if (resolution.gap && runtime.config.compactionCatchUpMaxChunks > 0 && catchUpBudgetMs > 0) {
			// One wall-clock budget covers waiting for a background pass and
			// the catch-up itself.
			const deadline = Date.now() + catchUpBudgetMs;
			const resolveFrom = (next: LedgerEntry[]): void => {
				entries = next;
				coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
				resolution = resolveCompactionCut(entries, event.preparation.firstKeptEntryId, coverageIndex, {
					reason,
					runtime,
					rangeStartIndex: rangeStart,
				});
			};
			// A background consolidation would otherwise make catch-up skip
			// entirely and keep calling the worker model and appending ledger
			// entries while the summary is built. Preempt it; whatever it
			// already appended is picked up by re-reading the branch.
			if (runtime.busy) {
				const settled = await runtime.preempt(
					"compaction",
					Math.min(COMPACTION_PREEMPT_WAIT_MS, catchUpBudgetMs),
				);
				if (settled) resolveFrom(runtime.ctx.sessionManager.getBranch() as LedgerEntry[]);
				else runtime.debug.record("compaction", "catchup_skipped_busy");
			}
			if (resolution.gap && !runtime.busy && !event.signal.aborted) {
				const catchUpResult = await catchUp(
					runtime,
					event,
					entries,
					latestCoverageId(entries, OM_OBSERVATIONS_RECORDED),
					deadline,
					options.complete,
				);
				if (catchUpResult.chunks > 0) resolveFrom(catchUpResult.entries);
			}
		}
		if (event.signal.aborted) return undefined;

		if (resolution.kind === "delegate") {
			return delegate(runtime, reason, resolution.reason, resolution);
		}
		if (resolution.gap) {
			runtime.debug.record("compaction", "retaining_unobserved_tail", {
				gapEntries: resolution.gap.entryCount,
				retainedTokens: resolution.retainedTokens,
				firstKeptEntryId: resolution.firstKeptEntryId,
			});
		}
		const result = buildCompactionResult(runtime, event, resolution, entries);
		if (!result) {
			return delegate(runtime, reason, "no rendered memory fits or no records");
		}
		return result;
	} catch (error) {
		runtime.recordError("compaction.before", error);
		runtime.lastCompactionOwned = false;
		return undefined;
	}
}

export function registerCompactionEvents(pi: ExtensionAPI, getRuntime: () => SessionRuntime | undefined): void {
	pi.on("auto_compaction_start", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		recordAutoCompactionStart(runtime, event);
	});
	pi.on("auto_compaction_end", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		recordAutoCompactionEnd(runtime, event);
	});
	pi.on("session_compact", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		runtime.lastCompactionOwned = event.fromExtension;
		runtime.lastCompactionAt = Date.now();
		runtime.lastAutoCompactionReason = undefined;
		runtime.lastAutoCompactionAction = undefined;
		runtime.autoCompactionStartedAt = 0;
		runtime.debug.record("compaction", "session_compact", {
			fromExtension: event.fromExtension,
			entryId: event.compactionEntry.id,
			details: event.compactionEntry.details ? "present" : undefined,
		});
	});
}

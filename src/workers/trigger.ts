import type { completeSimple } from "@oh-my-pi/pi-ai";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	type LedgerEntry,
	type Observation,
	type Reflection,
} from "../ledger/types";
import {
	foldLedger,
	latestCoverageId,
	latestCoverageIndex,
	observationTokens,
	rawTokensAfterIndex,
} from "../ledger/fold";
import { chunkUnobservedEntries, estimateEntryTokens, type SourceChunk } from "../ledger/serialize";
import { realTokensSinceObservationCoverage } from "../ledger/usage";
import { resolveObserverChunkMaxTokens } from "../config";
import type { SessionRuntime } from "../runtime";
import { runDropper } from "./dropper";
import { resolveWorkerModel, type ResolvedWorkerModel } from "./model";
import { runObserver } from "./observer";
import { runReflector } from "./reflector";

export interface ConsolidationResult {
	observed: number;
	reflected: number;
	dropped: number;
	skipped?: string;
}

function branchEntries(runtime: SessionRuntime): LedgerEntry[] {
	return runtime.ctx.sessionManager.getBranch() as LedgerEntry[];
}

export function rawTokensSinceCoverage(entries: readonly LedgerEntry[], runtime: SessionRuntime): number {
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	return rawTokensAfterIndex(entries, coverageIndex, (entry) => estimateEntryTokens(entry, runtime.estimator));
}

/** Provider-reported context growth since the latest observation anchor, when measurable. */
export function providerTokensSinceCoverage(
	entries: readonly LedgerEntry[],
	runtime: SessionRuntime,
): number | undefined {
	return realTokensSinceObservationCoverage(entries, runtime.contextTokens());
}

/**
 * Observer progress: the larger of the raw uncovered-source estimate and
 * provider-reported context growth. The provider clock catches content the
 * character heuristic undercounts, while the raw backlog keeps progress moving
 * when provider usage is unavailable or coverage lags a compaction.
 */
export function observeProgress(entries: readonly LedgerEntry[], runtime: SessionRuntime): number {
	const raw = rawTokensSinceCoverage(entries, runtime);
	const provider = providerTokensSinceCoverage(entries, runtime);
	return provider !== undefined ? Math.max(raw, provider) : raw;
}

export function shouldObserve(entries: readonly LedgerEntry[], runtime: SessionRuntime): boolean {
	const progress = observeProgress(entries, runtime);
	if (progress < runtime.config.observeAfterTokens) return false;
	const backoff = runtime.emptyBackoff;
	if (!backoff) return true;
	const coverageId = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED);
	const threshold = Math.max(1_000, Math.floor(runtime.config.observeAfterTokens / 2));
	return coverageId !== backoff.coverageId || progress > backoff.tokensAtEmpty + threshold;
}

function farthestSourceEntryId(
	records: readonly Observation[],
	sourceIds: readonly string[],
): string | undefined {
	const order = new Map(sourceIds.map((id, index) => [id, index]));
	let bestIndex = -1;
	let bestId: string | undefined;
	for (const record of records) {
		for (const id of record.sourceEntryIds) {
			const index = order.get(id);
			if (index !== undefined && index > bestIndex) {
				bestIndex = index;
				bestId = id;
			}
		}
	}
	return bestId;
}

export async function observeChunk(
	runtime: SessionRuntime,
	entries: readonly LedgerEntry[],
	resolved: ResolvedWorkerModel,
	chunk: SourceChunk,
	signal: AbortSignal,
	complete?: typeof completeSimple,
): Promise<Observation[] | undefined> {
	const fold = foldLedger(entries);
	let exhausted = false;
	const records = await runObserver({
		runtime,
		resolved,
		reflections: fold.reflections,
		observations: fold.activeObservations,
		chunk: chunk.text,
		allowedSourceEntryIds: chunk.sourceEntryIds,
		existingObservations: fold.observations,
		signal,
		complete,
		onExhausted: () => {
			exhausted = true;
		},
	});
	if (!records) {
		runtime.emptyBackoff = {
			coverageId: latestCoverageId(entries, OM_OBSERVATIONS_RECORDED),
			tokensAtEmpty: observeProgress(entries, runtime),
		};
		return undefined;
	}
	signal.throwIfAborted();
	// If maxTurns or an output-length stop cut the model off mid-chunk, advance
	// only as far as the accepted observations actually cite instead of claiming
	// the whole chunk.
	const coversUpToId = exhausted
		? (farthestSourceEntryId(records, chunk.sourceEntryIds) ?? chunk.coversUpToId)
		: chunk.coversUpToId;
	if (exhausted && coversUpToId !== chunk.coversUpToId) {
		runtime.debug.record("observer", "partial_coverage", {
			chunkCoverage: chunk.coversUpToId,
			coversUpToId,
		});
	}
	const data = buildObservationsRecordedData(records, coversUpToId);
	if (!data) return undefined;
	if (!runtime.append(OM_OBSERVATIONS_RECORDED, data)) throw new Error("failed to append observation record");
	runtime.emptyBackoff = undefined;
	runtime.emptyReflectionBackoff = undefined;
	runtime.lastObserverAt = Date.now();
	return records;
}

async function appendReflections(
	runtime: SessionRuntime,
	reflections: Reflection[],
	coversUpToId: string,
): Promise<number> {
	const data = buildReflectionsRecordedData(reflections, coversUpToId);
	if (!data) return 0;
	if (!runtime.append(OM_REFLECTIONS_RECORDED, data)) throw new Error("failed to append reflection record");
	runtime.lastReflectorAt = Date.now();
	return reflections.length;
}

async function appendDrops(runtime: SessionRuntime, ids: string[], coversUpToId: string): Promise<number> {
	const data = buildObservationsDroppedData(ids, coversUpToId);
	if (!data) return 0;
	if (!runtime.append(OM_OBSERVATIONS_DROPPED, data)) throw new Error("failed to append drop record");
	runtime.lastDropperAt = Date.now();
	return ids.length;
}

/**
 * One consolidation pass: observe the oldest unobserved chunk, reflect when the
 * active pool justifies it, then drop only after a successful reflection pass.
 * All appends happen after validation; a failed model call advances nothing.
 */
export async function consolidate(
	runtime: SessionRuntime,
	reason: string,
	options: { force?: boolean; complete?: typeof completeSimple } = {},
): Promise<ConsolidationResult> {
	const result: ConsolidationResult = { observed: 0, reflected: 0, dropped: 0 };
	if (!runtime.config.enabled || runtime.disposed) {
		return { ...result, skipped: "disabled" };
	}
	if (runtime.config.passive && !options.force) {
		return { ...result, skipped: "passive" };
	}
	if (runtime.config.consolidateWhenIdle && !runtime.isIdle() && reason === "turn_end") {
		runtime.debug.record("consolidation", "skipped_not_idle", { reason });
		return { ...result, skipped: "not_idle" };
	}
	if (runtime.isFailureBackoffActive() && !options.force) {
		return { ...result, skipped: "backoff" };
	}
	let entries = branchEntries(runtime);
	const fold = foldLedger(entries);
	const activeTokens = observationTokens(fold.activeObservations);
	const observeDue = options.force || shouldObserve(entries, runtime);
	const reflectDue = options.force || activeTokens >= runtime.config.reflectAfterTokens;
	const dropDue = options.force || activeTokens > runtime.config.observationsPoolMaxTokens;
	if (!observeDue && !reflectDue && !dropDue) {
		return { ...result, skipped: "below_threshold" };
	}

	const startedAt = Date.now();
	const errorBeforePass = runtime.lastError;
	const ran = await runtime.runExclusive("consolidation", async (signal) => {
		runtime.lastTriggerReason = reason;
		const resolved = await resolveWorkerModel(runtime.ctx, runtime.config, signal);
		if (!resolved.ok) {
			runtime.noteFailure("resolve", resolved.reason);
			runtime.notify(`Observational memory: model unavailable — ${resolved.reason}`, "warning");
			result.skipped = "model_unavailable";
			return;
		}
		if (resolved.value.fallbackUsed) {
			runtime.debug.record("resolve", "fallback", { model: resolved.value.label });
		}

		entries = branchEntries(runtime);
		const coverageId = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED);
		const chunkMaxTokens = resolveObserverChunkMaxTokens(
			runtime.config,
			resolved.value.model.contextWindow,
		);
		const chunk = chunkUnobservedEntries(
			entries,
			coverageId,
			chunkMaxTokens,
			runtime.estimator,
			{ observeAttachments: runtime.config.observeAttachments },
		);
		if (chunk && (options.force || shouldObserve(entries, runtime))) {
			const observations = await observeChunk(runtime, entries, resolved.value, chunk, signal, options.complete);
			if (observations) {
				result.observed = observations.length;
				entries = branchEntries(runtime);
			}
		}

		let currentFold = foldLedger(entries);
		const currentActiveTokens = observationTokens(currentFold.activeObservations);
		const reflectionBackoff = runtime.emptyReflectionBackoff;
		const reflectionBackoffActive =
			!options.force &&
			reflectionBackoff !== undefined &&
			reflectionBackoff.coverageId === latestCoverageId(entries, OM_OBSERVATIONS_RECORDED) &&
			currentActiveTokens <= reflectionBackoff.observationTokens + Math.max(1_000, Math.floor(runtime.config.reflectAfterTokens / 2));
		let reflectionPassRan = false;
		if (
			(options.force || currentActiveTokens >= runtime.config.reflectAfterTokens) &&
			!reflectionBackoffActive &&
			currentFold.activeObservations.length > 0
		) {
			reflectionPassRan = true;
			const reflections = await runReflector({
				runtime,
				resolved: resolved.value,
				reflections: currentFold.reflections,
				observations: currentFold.activeObservations,
				signal,
				complete: options.complete,
			});
			if (reflections) {
				signal.throwIfAborted();
				const covers = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED) ?? entries[entries.length - 1]?.id;
				if (covers) result.reflected = await appendReflections(runtime, reflections, covers);
				runtime.emptyReflectionBackoff = undefined;
				entries = branchEntries(runtime);
				currentFold = foldLedger(entries);
			} else {
				runtime.emptyReflectionBackoff = {
					coverageId: latestCoverageId(entries, OM_OBSERVATIONS_RECORDED),
					observationTokens: currentActiveTokens,
				};
			}
		}

		const afterReflectTokens = observationTokens(currentFold.activeObservations);
		if (
			(result.reflected > 0 || reflectionPassRan) &&
			(options.force || afterReflectTokens > runtime.config.observationsPoolMaxTokens) &&
			currentFold.activeObservations.length > 0
		) {
			const ids = await runDropper({
				runtime,
				resolved: resolved.value,
				reflections: currentFold.reflections,
				observations: currentFold.activeObservations,
				targetTokens: runtime.config.observationsPoolTargetTokens,
				signal,
				complete: options.complete,
			});
			if (ids && ids.length > 0) {
				signal.throwIfAborted();
				const covers = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED) ?? entries[entries.length - 1]?.id;
				if (covers) result.dropped = await appendDrops(runtime, ids, covers);
			}
		}
		runtime.noteSuccess();
	}, { requireIdle: reason === "turn_end" });
	if (!ran) {
		return { ...result, skipped: runtime.lastError !== errorBeforePass ? "failed" : "busy" };
	}
	runtime.debug.record("consolidation", "complete", { ...result, reason, durationMs: Date.now() - startedAt });
	return result;
}

const pendingByRuntime = new WeakMap<SessionRuntime, Timer>();

/** Debounce trigger events so one turn cannot start several passes. */
export function scheduleConsolidation(runtime: SessionRuntime, reason: string, delayMs = 300): void {
	if (!runtime.config.enabled || runtime.config.passive || runtime.disposed) return;
	const existing = pendingByRuntime.get(runtime);
	if (existing) runtime.clearTimer(existing);
	const timer = runtime.schedule(() => {
		pendingByRuntime.delete(runtime);
		void consolidate(runtime, reason);
	}, delayMs);
	pendingByRuntime.set(runtime, timer);
}

export function cancelScheduledConsolidation(runtime: SessionRuntime): void {
	const existing = pendingByRuntime.get(runtime);
	if (existing) {
		runtime.clearTimer(existing);
		pendingByRuntime.delete(runtime);
	}
}

import type { completeSimple } from "@oh-my-pi/pi-ai";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationCoverageData,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	type LedgerEntry,
	type Observation,
	type ObservationCoverageReason,
	type Reflection,
} from "../ledger/types";
import {
	foldLedger,
	latestCoverageId,
	latestCoverageIndex,
	latestResetBoundaryIndex,
	observationTokens,
	rawTokensAfterIndex,
	type FoldedLedger,
} from "../ledger/fold";
import { chunkUnobservedEntries, estimateEntryTokens, type SourceChunk } from "../ledger/serialize";
import { realTokensSinceObservationCoverage } from "../ledger/usage";
import { resolveObserverChunkMaxTokens } from "../config";
import type { BranchFingerprint, SessionRuntime } from "../runtime";
import { runDropper } from "./dropper";
import { resolveWorkerModel, type ResolvedWorkerModel } from "./model";
import { runObserver, type ObserverRunOutcome } from "./observer";
import { runReflector } from "./reflector";

/**
 * Unproductive observer attempts (every proposal rejected, the run was
 * truncated or exhausted without accepting anything, or the model answered in
 * prose instead of calling the tool) on one chunk before
 * coverage skips past it, so a chunk the model cannot handle never blocks the
 * observer from reaching newer content.
 */
export const OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS = 3;
/** Follow-up passes allowed per lifecycle trigger while an observer backlog drains. */
export const MAX_FOLLOWUP_PASSES = 8;
/** Retries for a trigger that found the lock held by another pass. */
export const MAX_BUSY_RETRIES = 3;
/**
 * Failed dropper calls (not aborts) before the retry is given up; the next
 * reflector pass then re-arms the dropper as usual.
 */
export const DROPPER_MAX_FAILURES = 3;
export const FOLLOWUP_REASON = "followup";
const FOLLOWUP_DELAY_MS = 250;
const BUSY_RETRY_DELAY_MS = 1_000;

export interface ConsolidationResult {
	observed: number;
	reflected: number;
	dropped: number;
	skipped?: string;
}

function branchEntries(runtime: SessionRuntime): LedgerEntry[] {
	return runtime.ctx.sessionManager.getBranch() as LedgerEntry[];
}

function branchTipId(entries: readonly LedgerEntry[]): string | undefined {
	return entries[entries.length - 1]?.id;
}

/**
 * Whether runtime state fingerprinted with `tipId` was recorded on this path.
 * Same-session tree navigation keeps the runtime, so state from a path whose
 * tip is no longer on the branch must not gate work on the new path.
 */
function recordedOnBranch(entries: readonly LedgerEntry[], tipId: string | undefined): boolean {
	return tipId === undefined || entries.some((entry) => entry.id === tipId);
}

/** Id of the latest host `/clear` boundary on the branch, or undefined. */
function latestResetId(entries: readonly LedgerEntry[]): string | undefined {
	const index = latestResetBoundaryIndex(entries);
	return index >= 0 ? entries[index]?.id : undefined;
}

function branchFingerprint(entries: readonly LedgerEntry[]): { tipId: string | undefined; resetId: string | undefined } {
	return { tipId: branchTipId(entries), resetId: latestResetId(entries) };
}

/**
 * Whether branch-local runtime state still applies to this branch: it was
 * recorded on this path, and no `/clear` happened since. `/clear` keeps the
 * session and the runtime and only appends a `reset_boundary`, after which the
 * reset-aware fold and source clocks restart, so totals measured before it
 * must not gate work after it.
 */
function appliesToBranch(entries: readonly LedgerEntry[], state: BranchFingerprint): boolean {
	return recordedOnBranch(entries, state.tipId) && state.resetId === latestResetId(entries);
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
	if (!backoff || !appliesToBranch(entries, backoff)) return true;
	const coverageId = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED);
	const threshold = Math.max(1_000, Math.floor(runtime.config.observeAfterTokens / 2));
	return coverageId !== backoff.coverageId || progress > backoff.tokensAtEmpty + threshold;
}

/**
 * True while an automatic reflector pass is not warranted: fewer than
 * `max(1000, reflectAfterTokens / 2)` observation tokens were recorded on this
 * branch since the last reflector pass. Reflections never shrink the active
 * pool, so without this gate every trigger would re-reflect the same pool.
 * A `/clear` since that pass lifts the gate: the fold then leaves out cleared
 * records, so its totals are not comparable with the gate's.
 */
export function isReflectionGated(
	entries: readonly LedgerEntry[],
	fold: FoldedLedger,
	runtime: SessionRuntime,
): boolean {
	const gate = runtime.reflectionGate;
	if (!gate || !appliesToBranch(entries, gate)) return false;
	const threshold = Math.max(1_000, Math.floor(runtime.config.reflectAfterTokens / 2));
	return observationTokens(fold.observations) - gate.recordedTokens < threshold;
}

/** A dropper call that was due on this branch did not complete. */
function isDropPending(entries: readonly LedgerEntry[], runtime: SessionRuntime): boolean {
	const pending = runtime.dropPending;
	return pending !== undefined && appliesToBranch(entries, pending);
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
	let outcome: ObserverRunOutcome | undefined;
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
		onOutcome: (value) => {
			outcome = value;
		},
	});
	if (!records) return recordUnproductiveRun(runtime, entries, chunk, outcome, signal);
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
	noteCoverageAdvanced(runtime);
	return records;
}

function noteCoverageAdvanced(runtime: SessionRuntime): void {
	runtime.emptyBackoff = undefined;
	runtime.observerRetry = undefined;
	runtime.lastObserverAt = Date.now();
}

/**
 * The observer accepted nothing. A clean run (the model stopped on its own,
 * nothing was rejected, truncated, or cut off, and it either used the tool or
 * replied with a bare "nothing new") means the chunk holds nothing new, so a
 * coverage-only record advances the watermark over it. Any other
 * empty run is retried after the empty-run backoff, but only
 * OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS times for the same chunk; then coverage
 * skips the chunk so newer content is still observed. The marker never claims
 * more than the chunk's own last sent entry. Returns `[]` when coverage
 * advanced and undefined when it did not.
 */
function recordUnproductiveRun(
	runtime: SessionRuntime,
	entries: readonly LedgerEntry[],
	chunk: SourceChunk,
	outcome: ObserverRunOutcome | undefined,
	signal: AbortSignal,
): Observation[] | undefined {
	let reason: ObservationCoverageReason = "empty";
	if (!outcome?.clean) {
		const startId = chunk.sourceEntryIds[0] ?? chunk.coversUpToId;
		const previous = runtime.observerRetry;
		// The chunk's first entry may precede a fork point, so attempts made on
		// another path (or before a `/clear`) do not count here.
		const attempts =
			previous && previous.startId === startId && appliesToBranch(entries, previous) ? previous.attempts + 1 : 1;
		if (attempts < OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS) {
			const fingerprint = branchFingerprint(entries);
			runtime.observerRetry = { startId, attempts, ...fingerprint };
			runtime.emptyBackoff = {
				coverageId: latestCoverageId(entries, OM_OBSERVATIONS_RECORDED),
				tokensAtEmpty: observeProgress(entries, runtime),
				...fingerprint,
			};
			return undefined;
		}
		reason = "retry_limit";
		runtime.debug.record("observer", "coverage_skipped", {
			attempts,
			chunkStartId: startId,
			coversUpToId: chunk.coversUpToId,
			proseReply: outcome?.proseReply,
			rejected: outcome?.rejected,
			toolErrors: outcome?.toolErrors,
			truncated: outcome?.truncated,
			exhausted: outcome?.exhausted,
		});
	}
	signal.throwIfAborted();
	const data = buildObservationCoverageData(chunk.coversUpToId, reason);
	if (!data) return undefined;
	if (!runtime.append(OM_OBSERVATIONS_RECORDED, data)) throw new Error("failed to append observation coverage");
	runtime.debug.record("observer", "coverage_only", { reason, coversUpToId: chunk.coversUpToId });
	noteCoverageAdvanced(runtime);
	return [];
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
 * active pool justifies it, then drop when the pool is still over budget.
 * The dropper runs after any reflection pass that ran without throwing, even
 * one that produced no reflections: otherwise an over-budget pool of
 * low/medium records nothing can be reflected about would grow without bound.
 * Safety comes from the dropper's local guards (critical is never dropped,
 * high needs reflection coverage), and drops stay recallable via `ob_recall`.
 * All appends happen after validation; a model call that fails before any
 * record is accepted advances nothing.
 *
 * After a pass that advanced observer coverage, a short follow-up pass is
 * scheduled while the observer is still due (at most MAX_FOLLOWUP_PASSES per
 * lifecycle trigger), so a backlog larger than one chunk drains without
 * waiting for more lifecycle events. A trigger that finds the lock busy leaves
 * a bounded retry scheduled instead of being dropped.
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
	if (!options.force) runtime.beforePass?.();
	if (runtime.config.passive && !options.force) {
		return { ...result, skipped: "passive" };
	}
	const idleOnly = reason === "turn_end" || reason === FOLLOWUP_REASON;
	if (runtime.config.consolidateWhenIdle && !runtime.isIdle() && idleOnly) {
		runtime.debug.record("consolidation", "skipped_not_idle", { reason });
		return { ...result, skipped: "not_idle" };
	}
	if (runtime.isFailureBackoffActive() && !options.force) {
		return { ...result, skipped: "backoff" };
	}
	let entries = branchEntries(runtime);
	const fold = foldLedger(entries);
	const activeTokens = observationTokens(fold.activeObservations);
	const reflectionGated = !options.force && isReflectionGated(entries, fold, runtime);
	const observeDue = options.force || shouldObserve(entries, runtime);
	const reflectDue = options.force || (!reflectionGated && activeTokens >= runtime.config.reflectAfterTokens);
	// The dropper only runs after a reflector pass, so it is gated the same way,
	// unless a dropper call that was due did not complete.
	const dropDue =
		options.force ||
		(activeTokens > runtime.config.observationsPoolMaxTokens &&
			(!reflectionGated || isDropPending(entries, runtime)));
	if (!observeDue && !reflectDue && !dropDue) {
		return { ...result, skipped: "below_threshold" };
	}

	const startedAt = Date.now();
	const errorBeforePass = runtime.lastError;
	const pass = { started: false, coverageAdvanced: false };
	const ran = await runtime.runExclusive("consolidation", async (signal) => {
		pass.started = true;
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
			{ observeAttachments: runtime.config.observeAttachments, redact: runtime.config.redactSecrets },
		);
		if (chunk && (options.force || shouldObserve(entries, runtime))) {
			// Model resolution above can await an OAuth refresh or a header
			// command: re-check before the only stage that sends raw source.
			if (!options.force) {
				runtime.beforePass?.();
				signal.throwIfAborted();
			}
			const observations = await observeChunk(runtime, entries, resolved.value, chunk, signal, options.complete);
			if (observations) {
				pass.coverageAdvanced = true;
				result.observed = observations.length;
				entries = branchEntries(runtime);
			}
		}

		let currentFold = foldLedger(entries);
		const currentActiveTokens = observationTokens(currentFold.activeObservations);
		let reflectionPassRan = false;
		if (
			(options.force ||
				(currentActiveTokens >= runtime.config.reflectAfterTokens && !isReflectionGated(entries, currentFold, runtime))) &&
			currentFold.activeObservations.length > 0
		) {
			if (!options.force) {
				runtime.beforePass?.();
				signal.throwIfAborted();
			}
			reflectionPassRan = true;
			// The total is paired with the `/clear` boundary it was measured
			// under. The host does not abort extension work on `/clear`, so one
			// that lands during this pass leaves the gate void instead of
			// comparing post-clear totals with a pre-clear one.
			const recordedTokens = observationTokens(currentFold.observations);
			const recordedResetId = latestResetId(entries);
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
				entries = branchEntries(runtime);
				currentFold = foldLedger(entries);
			}
			// Productive or not, the next automatic pass waits for new observations.
			// The tip is read after the append, so a `/tree` path without the
			// reflection entry does not inherit the gate.
			runtime.reflectionGate = { recordedTokens, tipId: branchTipId(entries), resetId: recordedResetId };
		}

		const afterReflectTokens = observationTokens(currentFold.activeObservations);
		// Retry a dropper call that was due but aborted or failed, without
		// re-running the reflector over an unchanged pool.
		const dropRetry = !reflectionPassRan && isDropPending(entries, runtime);
		if (
			(result.reflected > 0 || reflectionPassRan || dropRetry) &&
			(options.force || afterReflectTokens > runtime.config.observationsPoolMaxTokens) &&
			currentFold.activeObservations.length > 0
		) {
			if (dropRetry) runtime.debug.record("dropper", "retry_pending", { activeTokens: afterReflectTokens });
			// Cleared only once the dropper completes; an abort or a failure
			// leaves it set for the next automatic pass, up to
			// DROPPER_MAX_FAILURES failed calls.
			const fingerprint = branchFingerprint(entries);
			const failures = dropRetry ? (runtime.dropPending?.failures ?? 0) : 0;
			runtime.dropPending = { ...fingerprint, failures };
			try {
				if (!options.force) {
					runtime.beforePass?.();
					signal.throwIfAborted();
				}
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
				runtime.dropPending = undefined;
			} catch (error) {
				// An abort is not a failure: the retry and its count are kept.
				if (signal.aborted) throw error;
				const failed = failures + 1;
				runtime.dropPending = failed < DROPPER_MAX_FAILURES ? { ...fingerprint, failures: failed } : undefined;
				// The call right after a reflector pass still fails the pass.
				if (!dropRetry) throw error;
				// A failed retry must not turn this pass's observer work into a
				// failure, which would back off every later pass.
				runtime.recordError("dropper.retry", error);
				runtime.debug.record("dropper", "retry_failed", { failures: failed, givenUp: failed >= DROPPER_MAX_FAILURES });
			}
		} else if (reflectionPassRan || dropRetry) {
			// The pool is within budget: no earlier incomplete drop is left to retry.
			runtime.dropPending = undefined;
		}
		runtime.noteSuccess();
	}, { requireIdle: idleOnly });
	if (!ran) {
		if (runtime.lastError !== errorBeforePass) return { ...result, skipped: "failed" };
		// Our own pass started and was aborted (agent start, tree navigation,
		// compaction preemption): do not retry behind the abort.
		if (pass.started) return { ...result, skipped: "aborted" };
		scheduleBusyRetry(runtime, reason, options.complete);
		return { ...result, skipped: "busy" };
	}
	runtime.busyRetries = 0;
	runtime.debug.record("consolidation", "complete", { ...result, reason, durationMs: Date.now() - startedAt });
	scheduleFollowUp(runtime, reason, pass.coverageAdvanced, options.complete);
	return result;
}

const pendingByRuntime = new WeakMap<SessionRuntime, Timer>();

/**
 * Keep draining an observer backlog: one pass observes one chunk, so schedule
 * another pass while the observer is still due. Only a pass that advanced
 * coverage earns a follow-up (a failing model cannot spin), the chain is
 * capped per lifecycle trigger, and an already queued trigger wins.
 */
function scheduleFollowUp(
	runtime: SessionRuntime,
	reason: string,
	coverageAdvanced: boolean,
	complete: typeof completeSimple | undefined,
): void {
	if (reason !== FOLLOWUP_REASON) runtime.followUpPasses = 0;
	if (!coverageAdvanced || runtime.followUpPasses >= MAX_FOLLOWUP_PASSES) return;
	if (pendingByRuntime.has(runtime)) return;
	try {
		if (!shouldObserve(branchEntries(runtime), runtime)) return;
	} catch (error) {
		runtime.recordError("consolidation.followup", error);
		return;
	}
	runtime.followUpPasses++;
	runtime.debug.record("consolidation", "followup_scheduled", { passes: runtime.followUpPasses });
	scheduleConsolidation(runtime, FOLLOWUP_REASON, FOLLOWUP_DELAY_MS, { complete });
}

/** A trigger that found another pass holding the lock retries a bounded number of times. */
function scheduleBusyRetry(runtime: SessionRuntime, reason: string, complete: typeof completeSimple | undefined): void {
	if (pendingByRuntime.has(runtime) || runtime.busyRetries >= MAX_BUSY_RETRIES) return;
	runtime.busyRetries++;
	runtime.debug.record("consolidation", "busy_retry_scheduled", { reason, retries: runtime.busyRetries });
	scheduleConsolidation(runtime, reason, BUSY_RETRY_DELAY_MS, { complete });
}

/**
 * Debounce trigger events so one turn cannot start several passes. `complete`
 * overrides the worker model call (tests); production passes omit it.
 */
export function scheduleConsolidation(
	runtime: SessionRuntime,
	reason: string,
	delayMs = 300,
	options: { complete?: typeof completeSimple } = {},
): void {
	if (!runtime.config.enabled || runtime.config.passive || runtime.disposed) return;
	const existing = pendingByRuntime.get(runtime);
	if (existing) runtime.clearTimer(existing);
	// Return the pass so `runtime.schedule` records a rejection; a detached
	// promise would surface as an unhandled rejection, which omp treats as fatal.
	const timer = runtime.schedule(async () => {
		pendingByRuntime.delete(runtime);
		await consolidate(runtime, reason, { complete: options.complete });
	}, delayMs);
	pendingByRuntime.set(runtime, timer);
}

/** Whether a consolidation pass is queued for this runtime. */
export function hasScheduledConsolidation(runtime: SessionRuntime): boolean {
	return pendingByRuntime.has(runtime);
}

export function cancelScheduledConsolidation(runtime: SessionRuntime): void {
	const existing = pendingByRuntime.get(runtime);
	if (existing) {
		runtime.clearTimer(existing);
		pendingByRuntime.delete(runtime);
	}
}

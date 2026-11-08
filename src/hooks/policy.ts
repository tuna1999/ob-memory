import type { AutoCompactionEndEvent, AutoCompactionStartEvent } from "@oh-my-pi/pi-coding-agent";
import type { SessionRuntime } from "../runtime";
import type { CompactionReason } from "./cut";

const AUTO_REASON_TTL_MS = 2 * 60_000;

export function recordAutoCompactionStart(runtime: SessionRuntime, event: AutoCompactionStartEvent): void {
	runtime.lastAutoCompactionReason = event.reason;
	runtime.lastAutoCompactionAction = event.action;
	runtime.autoCompactionStartedAt = Date.now();
	runtime.debug.record("compaction", "auto_start", { reason: event.reason, action: event.action });
}

export function recordAutoCompactionEnd(runtime: SessionRuntime, event: AutoCompactionEndEvent): void {
	runtime.debug.record("compaction", "auto_end", {
		action: event.action,
		aborted: event.aborted,
		willRetry: event.willRetry,
		skipped: event.skipped,
		error: event.errorMessage,
	});
	runtime.lastAutoCompactionReason = undefined;
	runtime.lastAutoCompactionAction = undefined;
	runtime.autoCompactionStartedAt = 0;
}

/** The session_before_compact event does not carry a reason; recover it from the auto event. */
export function resolveCompactionReason(runtime: SessionRuntime): CompactionReason {
	if (
		runtime.lastAutoCompactionReason &&
		runtime.autoCompactionStartedAt > 0 &&
		Date.now() - runtime.autoCompactionStartedAt <= AUTO_REASON_TTL_MS
	) {
		return runtime.lastAutoCompactionReason;
	}
	return "manual";
}

export function shouldOwnCompaction(runtime: SessionRuntime, reason: CompactionReason, hasCoverage: boolean): boolean {
	if (!runtime.config.enabled || runtime.config.passive) return false;
	if (!hasCoverage) return false;
	if (reason === "overflow") return false;
	if (reason === "manual") return runtime.config.ownManualCompaction;
	return runtime.config.ownAutoCompaction;
}

export function compactionSummaryBudget(runtime: SessionRuntime): number {
	if (runtime.config.compactionSummaryMaxTokens !== undefined) return runtime.config.compactionSummaryMaxTokens;
	const window = typeof runtime.ctx.model?.contextWindow === "number" ? runtime.ctx.model.contextWindow : 128_000;
	return Math.max(2_000, Math.min(16_000, Math.floor(window / 8)));
}

/**
 * Rendered-memory budget the `session.compacting` fallback hands omp's native
 * summarizer when compaction is delegated: a third of the summary budget,
 * clamped to 1k–3k tokens.
 */
export function compactionFallbackBudget(runtime: SessionRuntime): number {
	return Math.max(1_000, Math.min(3_000, Math.floor(compactionSummaryBudget(runtime) / 3)));
}

/**
 * Smallest summary an owned compaction may shrink to so that it fits the
 * host's residual check, unless that smaller summary still holds every record
 * about the compacted range. Below this, delegating is no worse: the native
 * summarizer receives at least as much rendered memory through the
 * `session.compacting` fallback and also summarizes the compacted range. It
 * never exceeds the configured summary budget.
 */
export function compactionMinimumSummaryTokens(runtime: SessionRuntime): number {
	return Math.min(compactionSummaryBudget(runtime), compactionFallbackBudget(runtime));
}

/**
 * The host compaction policy fields that decide its trigger, read from
 * `session_before_compact`'s `event.preparation.settings` (already resolved by
 * the host for the active model's per-model thresholds and the method).
 */
export interface HostCompactionSettings {
	thresholdPercent?: number;
	thresholdTokens?: number;
	baseWindowTokens?: number;
	reserveTokens?: number;
}

// Mirrors of pi-agent-core 18.13.3 src/compaction/compaction.ts constants
// (COMPACTION_RECOVERY_BAND, DEFAULT_RESERVE_TOKENS). Replicated instead of
// imported so a host that renames them cannot break extension loading.
const HOST_COMPACTION_RECOVERY_BAND = 0.8;
const HOST_DEFAULT_RESERVE_TOKENS = 16_384;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readHostCompactionSettings(settings: unknown): HostCompactionSettings {
	if (!settings || typeof settings !== "object") return {};
	const record = settings as Record<string, unknown>;
	return {
		thresholdPercent: finiteNumber(record.thresholdPercent),
		thresholdTokens: finiteNumber(record.thresholdTokens),
		baseWindowTokens: finiteNumber(record.baseWindowTokens),
		reserveTokens: finiteNumber(record.reserveTokens),
	};
}

/** pi-agent-core `resolveBudgetReserveTokens`. */
function hostBudgetReserveTokens(contextWindow: number, settings: HostCompactionSettings): number {
	const reserveTokens = Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? HOST_DEFAULT_RESERVE_TOKENS);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const defaultIsImpossible =
		settings.reserveTokens === undefined && reserveTokens >= contextWindow - proportionalReserveTokens;
	return defaultIsImpossible || reserveTokens >= contextWindow ? proportionalReserveTokens : reserveTokens;
}

/** pi-agent-core `promptBudgetTokens`. */
function hostPromptBudgetTokens(contextWindow: number, settings: HostCompactionSettings): number {
	return Math.max(0, Math.min(contextWindow - 1, contextWindow - hostBudgetReserveTokens(contextWindow, settings)));
}

/**
 * The host's compaction trigger (pi-agent-core 18.13.3 `resolveThresholdTokens`):
 * a positive `thresholdTokens` wins, otherwise `thresholdPercent` of the
 * (per-model `baseWindowTokens`-capped) window, otherwise the prompt budget.
 */
export function hostCompactionThresholdTokens(contextWindow: number, settings: HostCompactionSettings): number {
	const thresholdTokens = settings.thresholdTokens;
	if (thresholdTokens !== undefined && thresholdTokens > 0) {
		if (thresholdTokens >= contextWindow) return hostPromptBudgetTokens(contextWindow, settings);
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}
	let window = contextWindow;
	const baseWindowTokens = settings.baseWindowTokens;
	if (baseWindowTokens !== undefined && baseWindowTokens > 0) window = Math.min(window, baseWindowTokens);
	const thresholdPercent = settings.thresholdPercent;
	if (thresholdPercent === undefined || thresholdPercent <= 0) return hostPromptBudgetTokens(window, settings);
	const clamped = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(window * (clamped / 100));
}

/**
 * Residual context the host accepts after a committed compaction. Above it,
 * session-maintenance.ts `#compactionCreatedHeadroom` fails and
 * `#rescueCompactionDeadEnd` elides tool output and drops images from the kept
 * history, then blocks automatic continuation if that is still not enough.
 */
export function hostRecoveryBandTokens(contextWindow: number, settings: HostCompactionSettings): number {
	return Math.floor(hostCompactionThresholdTokens(contextWindow, settings) * HOST_COMPACTION_RECOVERY_BAND);
}

/**
 * Residual the host accepts when an overflow or incomplete-turn recovery
 * retries the turn (session-maintenance.ts `contextFitsModel` via
 * `#compactionCreatedRetryFit`): the window less the budget reserve.
 */
export function hostRetryFitTokens(contextWindow: number, settings: HostCompactionSettings): number {
	return Math.max(0, contextWindow - hostBudgetReserveTokens(contextWindow, settings));
}

/** Which residual check the host applies after committing a compaction. */
export type HostResidualCheck = "band" | "fit";

/**
 * The check host 18.13.3 runs on the residual context once a compaction for
 * `reason` is committed (session-maintenance.ts `runAutoCompaction`): a
 * threshold pass has to land inside the recovery band
 * (`#compactionCreatedHeadroom`), an overflow or incomplete-turn retry only
 * has to fit the window (`#compactionCreatedRetryFit`), and idle passes and
 * manual `/compact` are not checked at all. Failing the check sends the host
 * into `#rescueCompactionDeadEnd`.
 */
export function hostResidualCheck(reason: CompactionReason): HostResidualCheck | undefined {
	if (reason === "threshold") return "band";
	if (reason === "overflow" || reason === "incomplete") return "fit";
	return undefined;
}

export interface HostRetainedBudgetInput {
	/** `event.preparation.settings` from `session_before_compact`. */
	settings?: unknown;
	/** Context the host counts outside the message list: system prompt, tool schemas, skills. */
	fixedContextTokens?: number;
}

/**
 * Room the host's residual check (by default the recovery band) leaves for
 * the kept messages plus the summary once the (estimated) fixed context is
 * counted, or undefined when the host cannot evaluate it: without compaction
 * settings, or with an unknown window, where the host skips the check too.
 */
export function hostResidualBudget(
	runtime: SessionRuntime,
	host?: HostRetainedBudgetInput,
	check: HostResidualCheck = "band",
): number | undefined {
	const modelWindow = runtime.ctx.model?.contextWindow;
	if (!host?.settings || typeof modelWindow !== "number" || !(modelWindow > 0)) return undefined;
	const settings = readHostCompactionSettings(host.settings);
	const accepted =
		check === "band" ? hostRecoveryBandTokens(modelWindow, settings) : hostRetryFitTokens(modelWindow, settings);
	const fixed = Math.max(0, host.fixedContextTokens ?? 0);
	return Math.max(0, accepted - fixed);
}

/**
 * Budget for the retained raw tail plus the rendered summary. The configured
 * `compactionMaxRetainedTokens` (or half the window) is an upper bound; with
 * the host's compaction settings the budget also has to fit the host's
 * recovery band after the (estimated) fixed context, so an owned compaction
 * does not knowingly leave more than the host accepts and trigger its
 * dead-end rescue.
 */
export function compactionRetainedBudget(runtime: SessionRuntime, host?: HostRetainedBudgetInput): number {
	const modelWindow = runtime.ctx.model?.contextWindow;
	const window = typeof modelWindow === "number" ? modelWindow : 128_000;
	const configured = runtime.config.compactionMaxRetainedTokens ?? Math.max(4_000, Math.floor(window / 2));
	const residual = hostResidualBudget(runtime, host);
	return residual === undefined ? configured : Math.max(0, Math.min(configured, residual));
}

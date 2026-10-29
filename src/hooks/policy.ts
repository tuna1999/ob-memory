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

export function compactionRetainedBudget(runtime: SessionRuntime): number {
	if (runtime.config.compactionMaxRetainedTokens !== undefined) return runtime.config.compactionMaxRetainedTokens;
	const window = typeof runtime.ctx.model?.contextWindow === "number" ? runtime.ctx.model.contextWindow : 128_000;
	return Math.max(4_000, Math.floor(window / 2));
}

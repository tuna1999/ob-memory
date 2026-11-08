import type { ExtensionContext, SessionCompactingEvent, SessionCompactingResult } from "@oh-my-pi/pi-coding-agent";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	isObservationsRecordedData,
	type LedgerEntry,
} from "../ledger/types";
import { foldLedger, unwrapCompactionDetails } from "../ledger/fold";
import { renderMemory } from "../ledger/render";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { compactionFallbackBudget } from "./policy";

function latestCompactionIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") return i;
	}
	return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isFoldedDetails(details: unknown): boolean {
	return isRecord(details) && details.type === "ob-memory.folded";
}

function ledgerEntriesAfter(entries: readonly LedgerEntry[], index: number): number {
	let count = 0;
	for (let i = index + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom") continue;
		// A coverage-only record (empty observations) adds nothing the previous
		// ob-memory summary lacks.
		if (
			(entry.customType === OM_OBSERVATIONS_RECORDED &&
				isObservationsRecordedData(entry.data) &&
				entry.data.observations.length > 0) ||
			entry.customType === OM_REFLECTIONS_RECORDED
		) {
			count++;
		}
	}
	return count;
}

/**
 * Fallback for native compaction: add the rendered ledger as extra summary
 * context. This handler is skipped by the host when session_before_compact
 * already supplied a custom result, so the two paths cannot duplicate memory.
 */
export function handleSessionCompacting(
	runtime: SessionRuntime,
	_event: SessionCompactingEvent,
	ctx: ExtensionContext,
): SessionCompactingResult | undefined {
	if (!runtime.config.enabled || runtime.config.passive) return undefined;
	try {
		runtime.updateContext(ctx);
		// No time-based dedupe: the host emits session.compacting once per
		// compaction attempt, and a method fallback (a failed snapcompact,
		// remote, …) retries with a fresh preparation whose summarizer has not
		// seen this context yet. Injection has no side effects.
		const entries = ctx.sessionManager.getBranch() as LedgerEntry[];
		const fold = foldLedger(entries);
		if (fold.activeObservations.length + fold.reflections.length === 0) return undefined;

		const latestIndex = latestCompactionIndex(entries);
		const latestEntry = latestIndex >= 0 ? entries[latestIndex] : undefined;
		const latestIsMemoryCompaction =
			latestEntry?.type === "compaction" && isFoldedDetails(unwrapCompactionDetails(latestEntry.details));
		if (latestIsMemoryCompaction && ledgerEntriesAfter(entries, latestIndex) === 0) {
			runtime.debug.record("compacting", "skip_already_injected");
			return undefined;
		}

		const maxTokens = compactionFallbackBudget(runtime);
		const rendered = renderMemory(fold.reflections, fold.activeObservations, {
			maxTokens,
			estimate: runtime.estimator,
		});
		if (!rendered.text || rendered.observations.length + rendered.reflections.length === 0) {
			runtime.debug.record("compacting", "empty_render", { maxTokens });
			return undefined;
		}
		runtime.debug.record("compacting", "injected", {
			observations: rendered.observations.length,
			reflections: rendered.reflections.length,
			tokens: rendered.tokens,
		});
		return {
			context: [runtime.config.redactSecrets ? redactText(rendered.text) : rendered.text],
			preserveData: {
				"ob-memory": {
					version: 1,
					injectedAt: new Date().toISOString(),
					observations: rendered.observations.length,
					reflections: rendered.reflections.length,
					tokens: rendered.tokens,
				},
			},
		};
	} catch (error) {
		runtime.recordError("compacting", error);
		return undefined;
	}
}

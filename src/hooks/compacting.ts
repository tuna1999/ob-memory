import type { ExtensionContext, SessionCompactingEvent, SessionCompactingResult } from "@oh-my-pi/pi-coding-agent";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type LedgerEntry,
} from "../ledger/types";
import { foldLedger } from "../ledger/fold";
import { renderMemory } from "../ledger/render";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { compactionSummaryBudget } from "./policy";

function latestCompactionIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") return i;
	}
	return -1;
}

function ledgerEntriesAfter(entries: readonly LedgerEntry[], index: number): number {
	let count = 0;
	for (let i = index + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom") continue;
		if (
			entry.customType === OM_OBSERVATIONS_RECORDED ||
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
		if (Date.now() - runtime.lastCompactingAt < 750) {
			runtime.debug.record("compacting", "skip_duplicate_pass");
			return undefined;
		}
		const entries = ctx.sessionManager.getBranch() as LedgerEntry[];
		const fold = foldLedger(entries);
		if (fold.activeObservations.length + fold.reflections.length === 0) return undefined;

		const latestIndex = latestCompactionIndex(entries);
		const latestEntry = latestIndex >= 0 ? entries[latestIndex] : undefined;
		const latestIsMemoryCompaction =
			latestEntry?.type === "compaction" &&
			latestEntry.details !== undefined &&
			latestEntry.details !== null &&
			typeof latestEntry.details === "object" &&
			"type" in latestEntry.details &&
			latestEntry.details.type === "ob-memory.folded";
		if (latestIsMemoryCompaction && ledgerEntriesAfter(entries, latestIndex) === 0) {
			runtime.debug.record("compacting", "skip_already_injected");
			return undefined;
		}

		const maxTokens = Math.max(1_000, Math.min(3_000, Math.floor(compactionSummaryBudget(runtime) / 3)));
		const rendered = renderMemory(fold.reflections, fold.activeObservations, {
			maxTokens,
			estimate: runtime.estimator,
		});
		if (!rendered.text || rendered.observations.length + rendered.reflections.length === 0) {
			runtime.debug.record("compacting", "empty_render", { maxTokens });
			return undefined;
		}
		runtime.lastCompactingAt = Date.now();
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

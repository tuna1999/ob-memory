import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	fullProjection,
	latestCompactionDetails,
	latestResetBoundaryIndex,
	visibleProjection,
} from "../ledger/fold";
import { renderMemory } from "../ledger/render";
import type { LedgerEntry } from "../ledger/types";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";

async function present(ctx: ExtensionContext, text: string): Promise<void> {
	if (ctx.hasUI && ctx.mode === "tui") {
		try {
			await ctx.ui.editor("Observational Memory", text);
			return;
		} catch {
			// Fall through to a notification when the editor is unavailable.
		}
	}
	if (ctx.hasUI) {
		const limit = 4_000;
		ctx.ui.notify(text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text, "info");
		return;
	}
	// Print/RPC without UI: the command still succeeds, and the text is logged.
	ctx.ui.notify(text, "info");
}

export async function handleView(runtime: SessionRuntime, ctx: ExtensionContext, args: string): Promise<void> {
	runtime.updateContext(ctx);
	const entries = ctx.sessionManager.getBranch() as LedgerEntry[];
	const full = args.trim().split(/\s+/).includes("full");
	const projection = full ? fullProjection(entries) : visibleProjection(entries);
	const maxTokens = Math.max(2_000, Math.min(24_000, runtime.config.compactionSummaryMaxTokens ?? 12_000) * 2);
	const rendered = full
		? renderMemory(projection.reflections, projection.observations, { estimate: runtime.estimator })
		: renderMemory(projection.reflections, projection.observations, {
				maxTokens,
				estimate: runtime.estimator,
			});
	const scope = full ? "full ledger" : "visible memory";
	const header =
		`${scope}: ${projection.observations.length} active observations, ${projection.reflections.length} reflections` +
		(projection.droppedObservationIds.length > 0 ? `, ${projection.droppedObservationIds.length} dropped ids` : "");
	const text = `${header}\n\n${rendered.text || emptyViewMessage(entries, full)}`;
	await present(ctx, runtime.config.redactSecrets ? redactText(text) : text);
}

function latestCompactionIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") return i;
	}
	return -1;
}

/**
 * The visible projection can be empty while the branch ledger holds records:
 * after a `/clear` newer than the latest compaction (the records were
 * cleared), or after a newer native compaction. Say which instead of claiming
 * there are none.
 */
function emptyViewMessage(entries: readonly LedgerEntry[], full: boolean): string {
	const none = "(no memory records yet)";
	if (full) return none;
	const ledger = fullProjection(entries);
	if (ledger.observations.length + ledger.reflections.length === 0) return none;
	const compactionIndex = latestCompactionIndex(entries);
	// Mirrors visibleProjection: a newer `/clear` decides visibility, whatever
	// kind of compaction preceded it.
	if (latestResetBoundaryIndex(entries) > compactionIndex) {
		return "(the records were cleared by /clear and are not in the visible memory; they are still listed in /ob-memory view full)";
	}
	const nativeCompaction = compactionIndex >= 0 && latestCompactionDetails(entries) === undefined;
	return nativeCompaction
		? "(latest compaction was native; ob-memory records are not in the visible summary — use /ob-memory view full)"
		: "(no records in the visible summary; the full ledger has records — use /ob-memory view full)";
}

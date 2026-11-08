import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	fullProjection,
	latestCompactionDetails,
	latestResetBoundaryIndex,
	visibleProjection,
} from "../ledger/fold";
import { MEMORY_HEADER, renderMemory } from "../ledger/render";
import type { LedgerEntry } from "../ledger/types";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";

/**
 * Most record lines an interactive view hands to the host editor. omp's TUI
 * editor lays out every buffer line on each frame and keeps a 256-line wrap
 * cache, so a large ledger makes cursor movement and scrolling slow: 280 lines
 * measured ~15ms per frame, 1726 lines ~90ms. The newest lines are the ones
 * worth reading, so cap the buffer and count the rest.
 */
const VIEW_LINE_LIMIT = { visible: 120, full: 240 } as const;
/** Header rows kept whole when older lines are dropped (MEMORY_HEADER, its blank row). */
const VIEW_HEADER_LINES = MEMORY_HEADER.split("\n").length + 1;

/**
 * Keep the newest `limit` lines of a rendered memory text, preserving the
 * explanatory header; report how many lines were dropped. A no-op when the
 * text already fits or is empty.
 */
export function limitViewText(text: string, limit: number): { text: string; omitted: number } {
	const lines = text.split("\n");
	if (lines.length <= limit) return { text, omitted: 0 };
	const headerRows = text.startsWith(MEMORY_HEADER) ? Math.min(VIEW_HEADER_LINES, Math.max(0, limit - 2)) : 0;
	const header = lines.slice(0, headerRows);
	const newestCount = Math.max(1, limit - header.length - 1);
	const oldestKept = lines.length - newestCount;
	const omitted = oldestKept - header.length;
	return {
		text: [
			...header,
			...lines.slice(oldestKept),
			`… (${omitted} earlier lines omitted; showing the newest ${newestCount} record lines)`,
		].join("\n"),
		omitted,
	};
}

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
	const limit = full ? VIEW_LINE_LIMIT.full : VIEW_LINE_LIMIT.visible;
	const limited = rendered.text ? limitViewText(rendered.text, limit) : { text: "", omitted: 0 };
	const header =
		`${scope}: ${projection.observations.length} active observations, ${projection.reflections.length} reflections` +
		(projection.droppedObservationIds.length > 0 ? `, ${projection.droppedObservationIds.length} dropped ids` : "") +
		(limited.omitted > 0 ? `; ${limited.omitted} older lines omitted` : "");
	const text = `${header}\n\n${limited.text || emptyViewMessage(entries, full)}`;
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

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fullProjection, visibleProjection } from "../ledger/fold";
import { renderMemory } from "../ledger/render";
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
	const entries = ctx.sessionManager.getBranch();
	const full = args.trim().split(/\s+/).includes("full");
	const projection = full ? fullProjection(entries) : visibleProjection(entries);
	const maxTokens = Math.max(2_000, Math.min(24_000, runtime.config.compactionSummaryMaxTokens ?? 12_000) * 2);
	const rendered = renderMemory(projection.reflections, projection.observations, {
		maxTokens,
		estimate: runtime.estimator,
	});
	const scope = full ? "full ledger" : "visible memory";
	const header =
		`${scope}: ${projection.observations.length} active observations, ${projection.reflections.length} reflections` +
		(projection.droppedObservationIds.length > 0 ? `, ${projection.droppedObservationIds.length} dropped ids` : "");
	await present(ctx, `${header}\n\n${rendered.text || "(no memory records yet)"}`);
}

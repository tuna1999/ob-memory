import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { publicConfig } from "../config";
import type { SessionRuntime } from "../runtime";
import { consolidate, scheduleConsolidation } from "../workers/trigger";
import { handleConfig, handleHelp, handleStatus } from "./status";
import { handleView } from "./view";

export async function handleObserveNow(runtime: SessionRuntime, ctx: ExtensionContext): Promise<void> {
	runtime.updateContext(ctx);
	const result = await consolidate(runtime, "manual", { force: true });
	const summary =
		`observations +${result.observed}, reflections +${result.reflected}, drops +${result.dropped}` +
		(result.skipped ? `; skipped: ${result.skipped}` : "");
	if (ctx.hasUI) ctx.ui.notify(`Observational memory: ${summary}`, result.skipped === "failed" ? "warning" : "info");
}

export function handlePassive(runtime: SessionRuntime, ctx: ExtensionContext, args: string): void {
	const value = args.trim().toLowerCase();
	if (value !== "on" && value !== "off") {
		ctx.ui.notify("Usage: /ob-memory passive on|off", "warning");
		return;
	}
	runtime.config = { ...runtime.config, passive: value === "on" };
	if (value === "off") scheduleConsolidation(runtime, "passive_off", 100);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: passive ${value} (session only). ${value === "on" ? "Automatic workers and compaction ownership are paused." : "Automatic work resumed."}`,
			"info",
		);
	}
}

export async function handleMemoryCommand(
	runtime: SessionRuntime,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	runtime.updateContext(ctx);
	const trimmed = args.trim();
	const [subcommand = "help", ...rest] = trimmed ? trimmed.split(/\s+/) : ["help"];
	const tail = rest.join(" ");
	switch (subcommand.toLowerCase()) {
		case "view":
			await handleView(runtime, ctx, tail);
			return;
		case "status":
			handleStatus(runtime, ctx);
			return;
		case "observe-now":
		case "observe":
			await handleObserveNow(runtime, ctx);
			return;
		case "passive":
			handlePassive(runtime, ctx, tail);
			return;
		case "config":
			handleConfig(runtime, ctx);
			return;
		case "help":
			handleHelp(runtime, ctx);
			return;
		default:
			ctx.ui.notify(
				`Unknown /ob-memory subcommand ${JSON.stringify(subcommand)}. Try /ob-memory help.\n${JSON.stringify(publicConfig(runtime.config))}`,
				"warning",
			);
	}
}

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { publicConfig } from "../config";
import type { SessionRuntime } from "../runtime";
import { isHostSecretObfuscationActive } from "../workers/model";
import { cancelScheduledConsolidation, consolidate, scheduleConsolidation } from "../workers/trigger";
import { handleConfig, handleHelp, handleStatus } from "./status";
import { handleView } from "./view";

const HOST_SECRETS_OVERRIDE_WARNING =
	"Observational memory: Hide Secrets pause overridden for this session. omp Hide Secrets is on, but ob-memory worker requests cannot use its obfuscation: worker prompts are not obfuscated, only ob-memory's own redaction patterns apply.";

const OBSERVE_NOW_PAUSED_MESSAGE =
	"Observational memory: observe-now refused. Memory passes are paused for this session because omp Hide Secrets was detected and ob-memory worker requests cannot use its obfuscation. /ob-memory passive off resumes them (worker requests will not be obfuscated); turning Hide Secrets off resumes them too.";

/** Checks the extension wires into command handling. */
export interface MemoryCommandHooks {
	/**
	 * Runs right before a forced pass (observe-now) may send worker requests,
	 * which bypass `passive`; the omp Hide Secrets guard uses it.
	 */
	beforeForcedPass?: (ctx: ExtensionContext) => void;
}

export async function handleObserveNow(
	runtime: SessionRuntime,
	ctx: ExtensionContext,
	hooks: MemoryCommandHooks = {},
): Promise<void> {
	runtime.updateContext(ctx);
	hooks.beforeForcedPass?.(ctx);
	// The Hide Secrets pause is overridden only by `passive off`, which warns
	// that worker requests are not obfuscated; a forced pass must not bypass it.
	if (runtime.hostSecretsPause === "paused") {
		runtime.debug.record("command", "observe_now_refused", { reason: "host_secrets_pause" });
		if (ctx.hasUI) ctx.ui.notify(OBSERVE_NOW_PAUSED_MESSAGE, "warning");
		return;
	}
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
	let overridden = false;
	if (value === "off" && runtime.hostSecretsPause === "paused") {
		if (isHostSecretObfuscationActive(ctx) === false) {
			// Hide Secrets was turned off since the pause: nothing to override.
			runtime.hostSecretsPause = undefined;
		} else {
			runtime.hostSecretsPause = "overridden";
			overridden = true;
		}
		runtime.debug.record("session", "host_secrets_pause_lifted", { state: runtime.hostSecretsPause ?? "none" });
	}
	if (value === "on") {
		// Pausing must stop work already queued or running, not just future
		// triggers. An aborted pass is not a failure, so no backoff is applied.
		cancelScheduledConsolidation(runtime);
		runtime.abort("passive");
	} else {
		scheduleConsolidation(runtime, "passive_off", 100);
	}
	if (ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: passive ${value} (session only). ${value === "on" ? "Automatic workers and compaction ownership are paused." : "Automatic work resumed."}`,
			"info",
		);
		if (overridden) ctx.ui.notify(HOST_SECRETS_OVERRIDE_WARNING, "warning");
	}
}

export async function handleMemoryCommand(
	runtime: SessionRuntime,
	ctx: ExtensionContext,
	args: string,
	hooks: MemoryCommandHooks = {},
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
			await handleObserveNow(runtime, ctx, hooks);
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

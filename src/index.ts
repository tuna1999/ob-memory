import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { handleMemoryCommand } from "./commands/control";
import { loadConfig, resolveAgentDir } from "./config";
import { handleSessionBeforeCompact, registerCompactionEvents } from "./hooks/compaction";
import { handleSessionCompacting } from "./hooks/compacting";
import { EXTENSION_NAME, EXTENSION_VERSION, OM_LIFECYCLE } from "./constants";
import { SessionRuntime } from "./runtime";
import { registerRecallTool } from "./tools/recall";
import { cancelScheduledConsolidation, scheduleConsolidation } from "./workers/trigger";

/**
 * ob-memory extension entrypoint.
 *
 * Registration happens during load; every session action starts from the
 * lifecycle events. A fresh runtime is built for each main session and for each
 * new session produced by a switch, branch, or fork, so no branch inherits
 * another branch's ledger state.
 */
export default function obMemory(pi: ExtensionAPI): void {
	pi.setLabel("Observational Memory");
	let runtime: SessionRuntime | undefined;

	const getRuntime = (): SessionRuntime | undefined => runtime;
	registerRecallTool(pi, getRuntime);
	registerCompactionEvents(pi, getRuntime);

	const agentDir = (): string => {
		try {
			return getAgentDir();
		} catch {
			return resolveAgentDir(process.env);
		}
	};

	const bindSession = (ctx: ExtensionContext, reason: string): void => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtime.sessionId === sessionId) {
			runtime.updateContext(ctx);
			return;
		}
		if (runtime) {
			cancelScheduledConsolidation(runtime);
			runtime.dispose(reason);
		}
		const directory = agentDir();
		const loaded = loadConfig({
			cwd: ctx.cwd,
			agentDir: directory,
			env: process.env,
		});
		if (ctx.hasUI && loaded.config.showNotifications) {
			for (const warning of loaded.warnings) {
				ctx.ui.notify(`Observational Memory config: ${warning}`, "warning");
			}
		}
		runtime = new SessionRuntime(pi, ctx, loaded.config, directory);
		runtime.debug.record("session", "bind", {
			reason,
			version: EXTENSION_VERSION,
			sessionId,
			configSources: loaded.sources,
			model: runtime.activeModelLabel,
		});
		runtime.append(OM_LIFECYCLE, {
			event: "session_bind",
			reason,
			version: EXTENSION_VERSION,
			sessionId,
			startedAt: new Date().toISOString(),
		});
		scheduleConsolidation(runtime, reason, 1_000);
	};

	pi.registerCommand("ob-memory", {
		description: "Inspect or control observational memory",
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("Observational Memory is not active in this session.", "warning");
				return;
			}
			runtime.updateContext(ctx);
			await handleMemoryCommand(runtime, ctx, args);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		bindSession(ctx, "session_start");
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!runtime) return;
		runtime.updateContext(ctx);
		if (runtime.isIdle()) scheduleConsolidation(runtime, "turn_end", 300);
	});

	pi.on("agent_start", () => {
		if (!runtime) return;
		cancelScheduledConsolidation(runtime);
		runtime.abort("agent_start");
	});

	pi.on("agent_end", (event, ctx) => {
		if (!runtime) return;
		runtime.updateContext(ctx);
		if (event.willContinue === true) return;
		scheduleConsolidation(runtime, "agent_end", 300);
	});

	pi.on("session_before_switch", () => {
		if (!runtime) return;
		cancelScheduledConsolidation(runtime);
		runtime.abort("session_switch");
	});

	pi.on("session_switch", (_event, ctx) => {
		if (!runtime) {
			bindSession(ctx, "session_switch");
			return;
		}
		cancelScheduledConsolidation(runtime);
		runtime.dispose("session_switch");
		runtime = undefined;
		bindSession(ctx, "session_switch");
	});

	pi.on("session_before_branch", () => {
		if (!runtime) return;
		cancelScheduledConsolidation(runtime);
		runtime.abort("branch");
	});

	pi.on("session_before_tree", () => {
		if (!runtime) return;
		cancelScheduledConsolidation(runtime);
		runtime.abort("tree");
	});

	pi.on("session_branch", (_event, ctx) => {
		bindSession(ctx, "session_branch");
		if (runtime) scheduleConsolidation(runtime, "branch", 500);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!runtime) {
			bindSession(ctx, "session_tree");
			return;
		}
		runtime.updateContext(ctx);
		scheduleConsolidation(runtime, "tree", 500);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!runtime) return undefined;
		return handleSessionBeforeCompact(runtime, event, ctx);
	});

	pi.on("session.compacting", (event, ctx) => {
		if (!runtime) return undefined;
		return handleSessionCompacting(runtime, event, ctx);
	});

	pi.on("session_shutdown", () => {
		if (!runtime) return;
		cancelScheduledConsolidation(runtime);
		runtime.dispose("shutdown");
		runtime = undefined;
	});

	pi.logger.info(`${EXTENSION_NAME} extension loaded`);
}

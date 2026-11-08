import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getMemoryCommandCompletions } from "./commands/completions";
import { handleMemoryCommand } from "./commands/control";
import type { ObMemoryConfig } from "./config-types";
import { loadConfig, resolveAgentDir } from "./config";
import { handleSessionBeforeCompact, registerCompactionEvents } from "./hooks/compaction";
import { handleSessionCompacting } from "./hooks/compacting";
import { EXTENSION_NAME, EXTENSION_VERSION, OM_LIFECYCLE } from "./constants";
import { SessionRuntime } from "./runtime";
import { registerRecallTool } from "./tools/recall";
import { isHostSecretObfuscationActive } from "./workers/model";
import { cancelScheduledConsolidation, FOLLOWUP_REASON, scheduleConsolidation } from "./workers/trigger";

export interface ObMemoryOptions {
	/**
	 * Directory holding the global `ob-memory.json` and debug logs. Defaults to
	 * the host agent dir, then `PI_CODING_AGENT_DIR` / `~/.omp/agent`.
	 */
	agentDir?: string;
	/** Environment consulted for `OB_MEMORY_*` overrides. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/** Read-only view of one loaded extension instance. */
export interface ObMemoryInstance {
	/** Runtime bound to the current main session, if any. */
	readonly runtime: SessionRuntime | undefined;
}

/**
 * Schedule reason for a pass started at an async-wait settle (`agent_end` with
 * `awaitingAsyncWork`). The session idles until a background job reports back,
 * so the pass starts while idle and is not aborted by the next `agent_start`.
 */
const ASYNC_SETTLE_REASON = "agent_end_async";

const HOST_SECRETS_PAUSE_WARNING =
	"Observational Memory: omp Hide Secrets is on; ob-memory worker requests cannot use its obfuscation, so automatic memory passes are paused. /ob-memory passive off resumes them for this session; set pauseOnHostSecrets: false to always run.";

const HOST_SECRETS_WARNING =
	"Observational Memory: omp 'Hide Secrets' is on, but ob-memory worker requests cannot use its obfuscation. Only ob-memory's own redaction patterns apply to worker prompts.";

const HOST_SECRETS_RESUMED = "Observational Memory: omp Hide Secrets is off; automatic memory passes resumed.";
const HOST_SECRETS_LIFTED_PASSIVE =
	"Observational Memory: omp Hide Secrets is off; the pause is lifted and the session stays passive.";

/** Marks "no detection recorded yet" for the current runtime. */
const UNRECORDED = Symbol("unrecorded");

/** Per-runtime Hide Secrets bookkeeping, reset at every bind. */
interface HostSecretsState {
	/** Last detection written to the debug log. */
	seen: boolean | undefined | typeof UNRECORDED;
	/** The warn-only notice (pauseOnHostSecrets false) was issued. */
	warned: boolean;
	/** `config.passive` when the pause began; restored when Hide Secrets is turned off. */
	passiveBeforePause: boolean;
	/**
	 * The config object the pause installed. Only `/ob-memory passive` replaces
	 * it, so a different object means the user chose passive explicitly since.
	 */
	pausedConfig: ObMemoryConfig | undefined;
}

function freshHostSecretsState(): HostSecretsState {
	return { seen: UNRECORDED, warned: false, passiveBeforePause: false, pausedConfig: undefined };
}

/**
 * Whether ob-memory may take over compaction under this config. While it
 * cannot, `session_before_compact` stays unregistered: omp disables its async
 * (speculative) compaction whenever any extension handles that event.
 */
function mayOwnCompaction(config: ObMemoryConfig): boolean {
	return config.enabled && !config.passive && (config.ownAutoCompaction || config.ownManualCompaction);
}

/** ob-memory extension entrypoint: host agent dir and `process.env`. */
export default function obMemory(pi: ExtensionAPI): void {
	registerObMemory(pi, {});
}

/** Extension factory with injectable config sources (tests, embedding hosts). */
export function createObMemory(options: ObMemoryOptions = {}): (pi: ExtensionAPI) => ObMemoryInstance {
	return (pi) => registerObMemory(pi, options);
}

/**
 * Registration happens during load; every session action starts from the
 * lifecycle events. A fresh runtime is built for each main session and for each
 * new session produced by a switch, branch, or fork, so no branch inherits
 * another branch's ledger state.
 */
function registerObMemory(pi: ExtensionAPI, options: ObMemoryOptions): ObMemoryInstance {
	pi.setLabel("Observational Memory");
	let runtime: SessionRuntime | undefined;
	let compactionHandlerRegistered = false;
	let hostSecrets = freshHostSecretsState();
	// True while the registered session_before_compact handler runs, so its
	// catch-up pass is never mistaken for an async-settle pass.
	let compactionHookActive = false;
	// True from an async-wait settle until the next agent_start or another
	// lifecycle trigger: follow-ups of that settle's pass drain the same idle window.
	let asyncDrain = false;
	const env = (): Record<string, string | undefined> => options.env ?? process.env;

	const getRuntime = (): SessionRuntime | undefined => runtime;
	registerRecallTool(pi, getRuntime);
	registerCompactionEvents(pi, getRuntime);

	const agentDir = (): string => {
		if (options.agentDir !== undefined) return options.agentDir;
		try {
			return getAgentDir();
		} catch {
			return resolveAgentDir(env());
		}
	};

	/** The host file logger works in every mode, including print and headless RPC. */
	const log = (level: "info" | "warn", message: string): void => {
		try {
			pi.logger[level](message);
		} catch {
			// Logging is best effort.
		}
	};

	/** Schedule a lifecycle-triggered pass; only an async-wait settle starts a drain. */
	const schedulePass = (current: SessionRuntime, reason: string, delayMs: number): void => {
		asyncDrain = reason === ASYNC_SETTLE_REASON;
		scheduleConsolidation(current, reason, delayMs);
	};

	/**
	 * Hide Secrets was turned off while paused: resume. Passive goes back to its
	 * value before the pause, unless `/ob-memory passive on` chose it since.
	 */
	const liftHostSecretsPause = (current: SessionRuntime, trigger: string): void => {
		const passive =
			current.config === hostSecrets.pausedConfig ? hostSecrets.passiveBeforePause : current.config.passive;
		current.hostSecretsPause = undefined;
		hostSecrets.pausedConfig = undefined;
		current.config = { ...current.config, passive };
		current.debug.record("session", "host_secrets_pause_lifted", { state: "none", trigger, passive });
		if (!passive) {
			log("info", HOST_SECRETS_RESUMED);
			current.notify(HOST_SECRETS_RESUMED, "info");
		} else {
			// Headless modes logged the pause; log its end too.
			log("info", HOST_SECRETS_LIFTED_PASSIVE);
		}
		ensureCompactionHandler();
	};

	/**
	 * omp's Hide Secrets obfuscation applies only inside omp's own provider
	 * pipeline; worker requests cannot use it (see docs/privacy.md). Checked at
	 * bind, at lifecycle events, before a forced pass, at compaction, and through
	 * `runtime.beforePass` before every automatic pass, each worker stage and
	 * turn, and each catch-up chunk, so Hide Secrets turned on mid-session is
	 * caught before the next worker request. With pauseOnHostSecrets (default) the session goes
	 * passive until `/ob-memory passive off` overrides it (an overridden runtime
	 * is never paused again) or Hide Secrets is turned off. Otherwise a warning
	 * is issued once, the first time workers may run with Hide Secrets on.
	 * Pause and warning also go to the host log, which headless modes keep.
	 * Returns the detection.
	 */
	const guardHostSecrets = (
		ctx: ExtensionContext,
		trigger: string,
		mode: { forced?: boolean } = {},
	): boolean | undefined => {
		const current = runtime;
		if (!current || current.disposed) return undefined;
		const active = isHostSecretObfuscationActive(ctx);
		if (active !== hostSecrets.seen) {
			hostSecrets.seen = active;
			current.debug.record("session", "host_secret_obfuscation", { active: active ?? "unknown", trigger });
		}
		if (!current.config.enabled) return active;
		if (current.hostSecretsPause === "paused") {
			if (active === false) liftHostSecretsPause(current, trigger);
			return active;
		}
		if (active !== true) return active;
		if (current.config.pauseOnHostSecrets) {
			if (current.hostSecretsPause === "overridden") return active;
			hostSecrets.passiveBeforePause = current.config.passive;
			current.hostSecretsPause = "paused";
			current.config = { ...current.config, passive: true };
			hostSecrets.pausedConfig = current.config;
			// Like `passive on`: stop queued and running work, not just future triggers.
			cancelScheduledConsolidation(current);
			current.abort("host_secrets");
			current.debug.record("session", "host_secrets_pause", { trigger });
			log("warn", HOST_SECRETS_PAUSE_WARNING);
			current.notify(HOST_SECRETS_PAUSE_WARNING, "warning");
			return active;
		}
		if (hostSecrets.warned) return active;
		if (mode.forced) {
			// observe-now runs workers even while passive; its output is explicit.
			hostSecrets.warned = true;
			log("warn", HOST_SECRETS_WARNING);
			if (ctx.hasUI) ctx.ui.notify(HOST_SECRETS_WARNING, "warning");
			return active;
		}
		if (current.config.passive) return active;
		hostSecrets.warned = true;
		log("warn", HOST_SECRETS_WARNING);
		current.notify(HOST_SECRETS_WARNING, "warning");
		return active;
	};

	// Registered on first need and never removed: the host has no way to
	// unregister a handler (ExtensionAPI.on returns void and there is no off()),
	// and once ownership is possible the handler stays.
	const ensureCompactionHandler = (): void => {
		if (compactionHandlerRegistered || !runtime || !mayOwnCompaction(runtime.config)) return;
		compactionHandlerRegistered = true;
		pi.on("session_before_compact", async (event, ctx) => {
			if (!runtime) return undefined;
			// Catch-up sends worker requests; a mid-session Hide Secrets switch pauses first.
			guardHostSecrets(ctx, "compaction");
			compactionHookActive = true;
			try {
				return await handleSessionBeforeCompact(runtime, event, ctx);
			} finally {
				compactionHookActive = false;
			}
		});
	};

	const bindSession = (ctx: ExtensionContext, reason: string): void => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtime.sessionId === sessionId) {
			runtime.updateContext(ctx);
			guardHostSecrets(ctx, reason);
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
			env: env(),
		});
		const next = new SessionRuntime(pi, ctx, loaded.config, directory);
		// omp sends no event when Hide Secrets is switched on, and trigger.ts
		// starts follow-up and busy-retry passes on its own: check before every
		// automatic pass and each of its worker stages.
		next.beforePass = () => {
			if (runtime === next) guardHostSecrets(next.ctx, "pass");
		};
		runtime = next;
		hostSecrets = freshHostSecretsState();
		asyncDrain = false;
		// runtime.notify honors showNotifications and applies redactSecrets:
		// warnings echo raw config values.
		for (const warning of loaded.warnings) {
			next.notify(`Observational Memory config: ${warning}`, "warning");
		}
		next.debug.record("session", "bind", {
			reason,
			version: EXTENSION_VERSION,
			sessionId,
			configSources: loaded.sources,
			model: next.activeModelLabel,
		});
		// Before ensureCompactionHandler: a session paused for Hide Secrets must
		// not register session_before_compact until `passive off`.
		const hostSecretsActive = guardHostSecrets(ctx, reason);
		ensureCompactionHandler();
		next.append(OM_LIFECYCLE, {
			event: "session_bind",
			reason,
			version: EXTENSION_VERSION,
			sessionId,
			startedAt: new Date().toISOString(),
			// Readable in the session file when no UI shows the pause notice.
			hostSecrets: { active: hostSecretsActive ?? "unknown", pause: next.hostSecretsPause ?? "none" },
		});
		schedulePass(next, reason, 1_000);
	};

	pi.registerCommand("ob-memory", {
		description: "Inspect or control observational memory",
		getArgumentCompletions: getMemoryCommandCompletions,
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("Observational Memory is not active in this session.", "warning");
				return;
			}
			runtime.updateContext(ctx);
			// Before: the command sees the current pause state (status shows it,
			// observe-now refuses while paused, passive off overrides it).
			guardHostSecrets(ctx, "command");
			await handleMemoryCommand(runtime, ctx, args, {
				beforeForcedPass: (passCtx) => {
					guardHostSecrets(passCtx, "observe_now", { forced: true });
				},
			});
			// After: `passive off` may have enabled workers with Hide Secrets on.
			guardHostSecrets(ctx, "command");
			// `/ob-memory passive off` can make compaction ownership possible.
			ensureCompactionHandler();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		bindSession(ctx, "session_start");
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!runtime) return;
		runtime.updateContext(ctx);
		guardHostSecrets(ctx, "turn_end");
		// When consolidateWhenIdle is false, consolidation itself decides
		// whether it may run while the host is busy.
		if (!runtime.config.consolidateWhenIdle || runtime.isIdle()) {
			schedulePass(runtime, "turn_end", 300);
		}
	});

	pi.on("agent_start", () => {
		if (!runtime) return;
		const drained = asyncDrain;
		asyncDrain = false;
		// consolidateWhenIdle false lets passes run while the host is busy, so a
		// new agent loop must not discard the in-flight pass's accepted work.
		if (!runtime.config.consolidateWhenIdle) return;
		// A pass that has not started yet is simply rescheduled by a later settle.
		cancelScheduledConsolidation(runtime);
		// A pass started in the async wait this run ends (the settle's own pass
		// or a follow-up draining its backlog) began while the session idled;
		// aborting it would throw away worker output already paid for (the
		// observer appends only once its loop finishes), so let it finish.
		const reason = runtime.lastTriggerReason;
		const startedInAsyncWait = drained && (reason === ASYNC_SETTLE_REASON || reason === FOLLOWUP_REASON);
		if (runtime.busy && !compactionHookActive && startedInAsyncWait) {
			runtime.debug.record("runtime", "agent_start_keeps_pass", { reason });
			return;
		}
		runtime.abort("agent_start");
	});

	pi.on("agent_end", (event, ctx) => {
		if (!runtime) return;
		runtime.updateContext(ctx);
		guardHostSecrets(ctx, "agent_end");
		// awaitingAsyncWork: the run settled and the session idles until a
		// background job reports back, a safe consolidation window. A pass that
		// is already running when work resumes is left to finish.
		const awaitingAsyncWork = event.willContinue === true && event.awaitingAsyncWork === true;
		if (event.willContinue === true && !awaitingAsyncWork) return;
		schedulePass(runtime, awaitingAsyncWork ? ASYNC_SETTLE_REASON : "agent_end", 300);
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
		if (runtime) schedulePass(runtime, "branch", 500);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!runtime) {
			bindSession(ctx, "session_tree");
			return;
		}
		runtime.updateContext(ctx);
		guardHostSecrets(ctx, "session_tree");
		schedulePass(runtime, "tree", 500);
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
	return {
		get runtime() {
			return runtime;
		},
	};
}

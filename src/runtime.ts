import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ObMemoryConfig } from "./config-types";
import { modelLabel } from "./config";
import { DebugLog } from "./debug-log";
import { redactText } from "./security/redact";
import { createTokenEstimator, type TokenEstimator } from "./util/tokens";

export type ManagedTimer = Timer;

export const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;

export interface RuntimeError {
	stage: string;
	message: string;
	at: number;
}

/**
 * Per-session state. The extension factory is re-invoked for a new session or
 * a bound child, so keeping this inside the factory closure isolates sessions
 * while still giving every handler one stable runtime.
 */
export class SessionRuntime {
	config: ObMemoryConfig;
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionId: string;
	readonly debug: DebugLog;
	ctx: ExtensionContext;
	estimator: TokenEstimator;
	busy = false;
	disposed = false;
	abortController: AbortController | undefined;
	lastError: RuntimeError | undefined;
	failureCount = 0;
	failureBackoffUntil = 0;
	lastAutoCompactionReason: "threshold" | "overflow" | "idle" | "incomplete" | undefined;
	lastAutoCompactionAction: string | undefined;
	autoCompactionStartedAt = 0;
	lastCompactionOwned: boolean | undefined;
	lastCompactionAt = 0;
	lastCompactionRecords = 0;
	lastCompactingAt = 0;
	lastObserverAt = 0;
	lastReflectorAt = 0;
	lastDropperAt = 0;
	lastTriggerReason: string | undefined;
	emptyBackoff: { coverageId: string | undefined; tokensAtEmpty: number } | undefined;
	emptyReflectionBackoff: { coverageId: string | undefined; observationTokens: number } | undefined;
	readonly #pi: ExtensionAPI;
	readonly #timers = new Set<ManagedTimer>();
	/** Resolves after the in-flight exclusive pass has released `busy`. */
	#activePass: Promise<void> | undefined;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, config: ObMemoryConfig, agentDir: string) {
		this.#pi = pi;
		this.ctx = ctx;
		this.config = config;
		this.cwd = ctx.cwd;
		this.agentDir = agentDir;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.debug = new DebugLog({
			enabled: config.debugLog,
			agentDir,
			sessionId: this.sessionId,
		});
		this.estimator = createTokenEstimator(ctx.model);
	}

	get modelLabel(): string {
		return modelLabel(
			this.config.model ?? {
				provider: this.ctx.model?.provider ?? "unknown",
				id: this.ctx.model?.id ?? "unknown",
			},
		);
	}

	get activeModelLabel(): string {
		const model = this.ctx.model;
		return model ? `${model.provider}/${model.id}` : "none";
	}

	updateContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.estimator = createTokenEstimator(ctx.model);
	}

	schedule(fn: () => void | Promise<void>, delayMs: number): ManagedTimer {
		const timer = this.ctx.setTimeout(async () => {
			this.#timers.delete(timer);
			if (this.disposed) return;
			try {
				await fn();
			} catch (error) {
				this.recordError("timer", error);
			}
		}, Math.max(0, delayMs));
		this.#timers.add(timer);
		return timer;
	}

	clearTimer(timer: ManagedTimer): void {
		this.#timers.delete(timer);
		try {
			this.ctx.clearTimer(timer);
		} catch {
			// Session teardown may already have cleared it.
		}
	}

	append(customType: string, data: unknown): boolean {
		if (this.disposed) return false;
		try {
			this.#pi.appendEntry(customType, data);
			return true;
		} catch (error) {
			this.recordError(`append:${customType}`, error);
			return false;
		}
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (!this.config.showNotifications || !this.ctx.hasUI) return;
		try {
			const text = this.config.redactSecrets ? redactText(message) : message;
			this.ctx.ui.notify(text, type);
		} catch {
			// Notifications are optional in every mode.
		}
	}

	recordError(stage: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.lastError = { stage, message, at: Date.now() };
		this.debug.record(stage, "error", { message });
	}

	noteFailure(stage: string, error: unknown): void {
		this.failureCount++;
		// 2s, 4s, … doubling up to the 5 minute cap (reached at the 9th failure).
		const delay = Math.min(MAX_FAILURE_BACKOFF_MS, 2 ** Math.min(this.failureCount, 16) * 1_000);
		this.failureBackoffUntil = Date.now() + delay;
		this.recordError(stage, error);
	}

	noteSuccess(): void {
		this.failureCount = 0;
		this.failureBackoffUntil = 0;
	}

	isFailureBackoffActive(): boolean {
		return Date.now() < this.failureBackoffUntil;
	}

	isIdle(): boolean {
		try {
			return this.ctx.isIdle();
		} catch {
			return true;
		}
	}

	/** Provider-reported context size, or undefined when the host cannot measure it. */
	contextTokens(): number | undefined {
		try {
			const usage = typeof this.ctx.getContextUsage === "function" ? this.ctx.getContextUsage() : undefined;
			const tokens = usage?.tokens;
			return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Run one consolidation/compaction pass at a time. Returning false is a
	 * normal scheduling outcome, not an error; the next trigger will retry.
	 */
	async runExclusive(
		label: string,
		fn: (signal: AbortSignal) => Promise<void>,
		options: { requireIdle?: boolean } = {},
	): Promise<boolean> {
		if (this.busy || this.disposed) return false;
		if ((options.requireIdle ?? true) && this.config.consolidateWhenIdle && !this.isIdle()) {
			this.debug.record(label, "skipped_not_idle");
			return false;
		}
		this.busy = true;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		let release!: () => void;
		this.#activePass = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await fn(signal);
			return true;
		} catch (error) {
			if (!signal.aborted) this.noteFailure(label, error);
			return false;
		} finally {
			this.busy = false;
			this.abortController = undefined;
			this.#activePass = undefined;
			release();
		}
	}

	/**
	 * Abort the in-flight exclusive pass and wait, at most `timeoutMs`, for it
	 * to release the lock. Returns true when no pass holds the lock afterwards.
	 * An aborted pass does not count as a failure, so no backoff is applied.
	 */
	async preempt(reason: string, timeoutMs: number): Promise<boolean> {
		const pass = this.#activePass;
		if (!this.busy || !pass) return !this.busy;
		this.abort(reason);
		if (timeoutMs > 0) {
			let timer: ManagedTimer | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = this.ctx.setTimeout(() => resolve(), timeoutMs);
			});
			try {
				await Promise.race([pass, timeout]);
			} finally {
				if (timer) this.clearTimer(timer);
			}
		}
		const settled = !this.busy;
		this.debug.record("runtime", settled ? "preempted" : "preempt_timeout", { reason, timeoutMs });
		return settled;
	}

	abort(reason: string): void {
		if (!this.abortController) return;
		this.debug.record("runtime", "abort", { reason });
		this.abortController.abort(reason);
	}

	dispose(reason = "session_end"): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort(reason);
		for (const timer of this.#timers) {
			try {
				this.ctx.clearTimer(timer);
			} catch {
				// ignore teardown races
			}
		}
		this.#timers.clear();
	}
}

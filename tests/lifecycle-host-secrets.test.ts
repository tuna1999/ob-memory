import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { zod as piZod, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createObMemory } from "../src/index";
import type { SessionRuntime } from "../src/runtime";
import { cancelScheduledConsolidation, consolidate } from "../src/workers/trigger";
import {
	backlogEntries,
	citingObserverComplete,
	makeHarness,
	messageEntry,
	observationEntry,
	observationRecord,
} from "./helpers";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** omp's system-prompt line that is rendered only while Hide Secrets obfuscates. */
const NOTICE = "- `$$HASH$$`, `$$HASH:CASE$$`, `$$NAME_HASH:CASE$$` output tokens: opaque strings.";
const PAUSED = "automatic memory passes are paused";
const WARN_ONLY = "'Hide Secrets' is on";
const OVERRIDE = "worker prompts are not obfuscated";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface FakeTimer {
	delay: number;
	cleared: boolean;
}

/**
 * The real extension factory against a fake host whose system prompt can gain
 * or lose omp's Hide Secrets notice between events. Timers are recorded and
 * fire only when a test calls `fire`; worker-model auth is counted and fails
 * unless `authOk`, and a pass that gets past auth only reaches a scripted
 * worker passed to it, never a provider. Host log lines are captured.
 */
function boot(
	options: { env?: Record<string, string>; hideSecrets?: boolean; hasUI?: boolean; authOk?: boolean } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const { ctx, entries } = makeHarness();
	let sequence = 0;
	const logs: { level: string; message: string }[] = [];
	const pi = {
		setLabel() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command.handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", id: `x${++sequence}`, customType, data, timestamp: new Date().toISOString() });
		},
		logger: {
			info: (message: string) => logs.push({ level: "info", message }),
			warn: (message: string) => logs.push({ level: "warn", message }),
			error: (message: string) => logs.push({ level: "error", message }),
		},
		zod: piZod,
	} as unknown as ExtensionAPI;
	const agentDir = tempDir("ob-memory-agent-");
	const instance = createObMemory({ agentDir, env: options.env ?? {} })(pi);

	let hideSecrets = options.hideSecrets ?? false;
	let sessionId = "session-a";
	let authCalls = 0;
	const timers: FakeTimer[] = [];
	const callbacks = new Map<FakeTimer, () => unknown>();
	const notifications: { message: string; type: string }[] = [];
	Object.assign(ctx, {
		cwd: tempDir("ob-memory-cwd-"),
		hasUI: options.hasUI ?? true,
		getSystemPrompt: () => (hideSecrets ? ["You are a coding agent.", NOTICE] : ["You are a coding agent."]),
		setTimeout: (fn: () => unknown, delay: number) => {
			const timer: FakeTimer = { delay, cleared: false };
			callbacks.set(timer, fn);
			timers.push(timer);
			return timer as never;
		},
		clearTimer: (timer: FakeTimer) => {
			timer.cleared = true;
		},
	});
	Object.assign(ctx.sessionManager, { getSessionId: () => sessionId });
	Object.assign(ctx.modelRegistry, {
		getApiKeyAndHeaders: async () => {
			authCalls++;
			return options.authOk ? { ok: true, apiKey: "test-key", headers: {} } : { ok: false, error: "no provider in tests" };
		},
	});
	Object.assign(ctx.ui, {
		notify: (message: string, type = "info") => notifications.push({ message, type }),
	});

	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload } as never, ctx);
	};
	const command = async (args: string) => commands.get("ob-memory")?.(args, ctx);
	const runtime = (): SessionRuntime => {
		if (!instance.runtime) throw new Error("no runtime bound");
		return instance.runtime;
	};
	const messages = (text: string) => notifications.filter((entry) => entry.message.includes(text));
	const live = () => timers.filter((timer) => !timer.cleared);
	return {
		instance,
		ctx,
		entries,
		handlers,
		timers,
		notifications,
		agentDir,
		emit,
		command,
		runtime,
		messages,
		live,
		logs,
		/** Run a recorded timer's callback by hand, as the host would when it fires. */
		fire: async (timer: FakeTimer | undefined) => {
			const fn = timer ? callbacks.get(timer) : undefined;
			if (!timer || !fn) throw new Error("unknown timer");
			await fn();
		},
		authCalls: () => authCalls,
		setHideSecrets: (value: boolean) => {
			hideSecrets = value;
		},
		setSessionId: (id: string) => {
			sessionId = id;
		},
	};
}

function debugEvents(agentDir: string, sessionId: string): Array<Record<string, unknown>> {
	const path = join(agentDir, "ob-memory", "debug", `${sessionId}.ndjson`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("omp Hide Secrets pause (default)", () => {
	test("a session bound with Hide Secrets on is paused before any pass is scheduled", async () => {
		const host = boot({ hideSecrets: true, env: { OB_MEMORY_DEBUG_LOG: "true" } });
		await host.emit("session_start");
		const runtime = host.runtime();
		expect(runtime.config.passive).toBe(true);
		expect(runtime.hostSecretsPause).toBe("paused");
		expect(host.timers).toEqual([]);
		expect(host.handlers.get("session_before_compact")).toBeUndefined();
		const warnings = host.messages(PAUSED);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.type).toBe("warning");
		expect(warnings[0]?.message).toContain("/ob-memory passive off resumes them for this session");
		expect(warnings[0]?.message).toContain("pauseOnHostSecrets: false");
		const events = debugEvents(host.agentDir, "session-a");
		expect(events.some((event) => event.event === "host_secret_obfuscation" && event.active === true)).toBe(true);
		expect(events.some((event) => event.event === "host_secrets_pause")).toBe(true);

		// Repeated checks do not warn again.
		await host.emit("turn_end");
		await host.emit("agent_end", { messages: [] });
		expect(host.messages(PAUSED)).toHaveLength(1);
		expect(host.timers).toEqual([]);
	});

	test("headless sessions (no UI, no notification) are paused all the same", async () => {
		const host = boot({ hideSecrets: true, hasUI: false });
		await host.emit("session_start");
		const runtime = host.runtime();
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
		expect(host.notifications).toEqual([]);
		expect(runtime.hostSecretsPause).toBe("paused");
		expect((await consolidate(runtime, "agent_end")).skipped).toBe("passive");
		expect(host.authCalls()).toBe(0);
	});

	test("headless sessions get a readable record of the pause: host log and session_bind entry", async () => {
		const host = boot({ hideSecrets: true, hasUI: false });
		await host.emit("session_start");
		expect(host.notifications).toEqual([]);
		const warnings = host.logs.filter((line) => line.level === "warn" && line.message.includes(PAUSED));
		expect(warnings).toHaveLength(1);
		const binds = host.entries.filter((entry) => entry.customType === "ob-memory.lifecycle");
		expect(binds).toHaveLength(1);
		expect((binds[0]?.data as { hostSecrets?: unknown }).hostSecrets).toEqual({ active: true, pause: "paused" });

		// Repeated checks log nothing more; a session without Hide Secrets records "off".
		await host.emit("turn_end");
		expect(host.logs.filter((line) => line.level === "warn")).toHaveLength(1);
		const off = boot({ hasUI: false });
		await off.emit("session_start");
		const offBind = off.entries.find((entry) => entry.customType === "ob-memory.lifecycle");
		expect((offBind?.data as { hostSecrets?: unknown }).hostSecrets).toEqual({ active: false, pause: "none" });
		expect(off.logs.filter((line) => line.level === "warn")).toEqual([]);
	});

	for (const trigger of [
		{ event: "turn_end", payload: {} },
		{ event: "agent_end", payload: { messages: [] } },
		{ event: "agent_end", payload: { messages: [], willContinue: true, awaitingAsyncWork: true } },
		{ event: "session_tree", payload: {} },
		{ event: "session_branch", payload: {} },
		{ event: "session_start", payload: {} },
	]) {
		test(`Hide Secrets turned on mid-session is caught at ${trigger.event} before scheduling`, async () => {
			const host = boot();
			await host.emit("session_start");
			const runtime = host.runtime();
			expect(runtime.config.passive).toBe(false);
			expect(host.live()).toEqual([{ delay: 1_000, cleared: false }]);

			host.setHideSecrets(true);
			await host.emit(trigger.event, trigger.payload);
			expect(host.instance.runtime).toBe(runtime);
			expect(runtime.config.passive).toBe(true);
			expect(runtime.hostSecretsPause).toBe("paused");
			// The pass queued at bind is cancelled and nothing new is scheduled.
			expect(host.live()).toEqual([]);
			expect(host.messages(PAUSED)).toHaveLength(1);
		});
	}

	test("compaction catch-up is paused when Hide Secrets was turned on since the last event", async () => {
		const host = boot();
		await host.emit("session_start");
		const [handler] = host.handlers.get("session_before_compact") ?? [];
		if (!handler) throw new Error("session_before_compact was not registered");
		host.setHideSecrets(true);
		const result = await handler(
			{
				type: "session_before_compact",
				branchEntries: [messageEntry("e1", "user", "hello")],
				preparation: { firstKeptEntryId: "e1", settings: {} },
				signal: new AbortController().signal,
			} as never,
			host.ctx,
		);
		expect(result).toBeUndefined();
		expect(host.runtime().hostSecretsPause).toBe("paused");
		expect(host.authCalls()).toBe(0);
	});

	for (const switched of [false, true]) {
		test(`a compaction whose catch-up ${switched ? "sees Hide Secrets switched on is left to the host" : "runs with Hide Secrets off is owned"}`, async () => {
			const host = boot({ authOk: true, env: { OB_MEMORY_COMPACTION_MAX_RETAINED_TOKENS: "100000" } });
			await host.emit("session_start");
			const [handler] = host.handlers.get("session_before_compact") ?? [];
			if (!handler) throw new Error("session_before_compact was not registered");
			host.entries.push(
				messageEntry("m1", "user", "We use Postgres."),
				observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
				messageEntry("m2", "user", "Deploy only to eu-west-1."),
				messageEntry("m3", "user", "Keep this tail."),
			);
			// Hide Secrets flips while catch-up resolves its worker model, after
			// the hook's own entry check; the per-chunk check stops the request.
			// Without the switch, auth fails so no provider is ever reached.
			Object.assign(host.ctx.modelRegistry, {
				getApiKeyAndHeaders: async () => {
					if (!switched) return { ok: false, error: "no provider in tests" };
					host.setHideSecrets(true);
					return { ok: true, apiKey: "test-key", headers: {} };
				},
			});
			const result = await handler(
				{
					type: "session_before_compact",
					branchEntries: [...host.entries],
					preparation: { firstKeptEntryId: "m3", tokensBefore: 50_000, settings: {} },
					signal: new AbortController().signal,
				} as never,
				host.ctx,
			);
			expect(host.runtime().hostSecretsPause).toBe(switched ? "paused" : undefined);
			if (switched) expect(result).toBeUndefined();
			else expect(result).toBeDefined();
		});
	}

	test("passive off overrides the pause for this runtime only, with a warning", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		const runtime = host.runtime();

		await host.command("passive off");
		expect(runtime.hostSecretsPause).toBe("overridden");
		expect(runtime.config.passive).toBe(false);
		const override = host.messages(OVERRIDE);
		expect(override).toHaveLength(1);
		expect(override[0]?.type).toBe("warning");
		expect(host.live().map((timer) => timer.delay)).toEqual([100]);
		expect(host.handlers.get("session_before_compact")).toHaveLength(1);

		// Never re-paused in this runtime.
		await host.emit("turn_end");
		await host.emit("agent_end", { messages: [] });
		await host.command("passive on");
		await host.command("passive off");
		expect(runtime.hostSecretsPause).toBe("overridden");
		expect(runtime.config.passive).toBe(false);
		expect(host.messages(PAUSED)).toHaveLength(1);
		expect(host.messages(OVERRIDE)).toHaveLength(1);

		// A new session is a new runtime: paused again.
		host.setSessionId("session-b");
		await host.emit("session_switch");
		expect(host.runtime()).not.toBe(runtime);
		expect(host.runtime().hostSecretsPause).toBe("paused");
		expect(host.messages(PAUSED)).toHaveLength(2);
	});

	test("passive off after Hide Secrets was turned off just lifts the pause", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		host.setHideSecrets(false);
		await host.command("passive off");
		expect(host.runtime().hostSecretsPause).toBeUndefined();
		expect(host.runtime().config.passive).toBe(false);
		expect(host.messages(OVERRIDE)).toEqual([]);
	});

	test("observe-now refuses while paused and runs once the pause is overridden", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));

		await host.command("observe-now");
		const refused = host.messages("observe-now refused");
		expect(refused).toHaveLength(1);
		expect(refused[0]?.type).toBe("warning");
		expect(refused[0]?.message).toContain("/ob-memory passive off");
		expect(host.authCalls()).toBe(0);

		await host.command("passive off");
		await host.command("observe-now");
		// The pass reached worker-model resolution (whose auth fails in tests).
		expect(host.authCalls()).toBe(1);
	});

	test("enabled false is never paused", async () => {
		const host = boot({ hideSecrets: true, env: { OB_MEMORY_ENABLED: "false" } });
		await host.emit("session_start");
		expect(host.runtime().hostSecretsPause).toBeUndefined();
		expect(host.runtime().config.passive).toBe(false);
		expect(host.notifications).toEqual([]);
	});
});

describe("omp Hide Secrets switched on before a timer-driven pass", () => {
	// omp sends extensions no event when the setting changes, so the check
	// runs again right before every pass a timer starts.
	for (const switched of [false, true]) {
		test(`a pass queued at bind ${switched ? "is paused when Hide Secrets was switched on" : "runs when Hide Secrets stays off"}`, async () => {
			const host = boot({ env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1" } });
			await host.emit("session_start");
			const runtime = host.runtime();
			host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
			const queued = host.live();
			expect(queued.map((timer) => timer.delay)).toEqual([1_000]);

			if (switched) host.setHideSecrets(true);
			await host.fire(queued[0]);
			// Worker-model auth is the first step of a pass that would send requests.
			expect(host.authCalls()).toBe(switched ? 0 : 1);
			expect(runtime.hostSecretsPause).toBe(switched ? "paused" : undefined);
			expect(runtime.config.passive).toBe(switched);
			expect(host.messages(PAUSED)).toHaveLength(switched ? 1 : 0);
		});
	}

	test("a follow-up draining a backlog stops once Hide Secrets is on", async () => {
		const host = boot({
			authOk: true,
			env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1", OB_MEMORY_OBSERVER_CHUNK_MAX_TOKENS: "256" },
		});
		await host.emit("session_start");
		const runtime = host.runtime();
		cancelScheduledConsolidation(runtime);
		host.entries.push(...backlogEntries(12));
		const worker = citingObserverComplete();

		// A settle's pass observes one chunk and queues a follow-up for the rest.
		const first = await consolidate(runtime, "agent_end", { complete: worker.complete });
		expect(first.observed).toBe(1);
		const followUp = host.live();
		expect(followUp.map((timer) => timer.delay)).toEqual([250]);
		const callsBefore = worker.calls();

		host.setHideSecrets(true);
		await host.fire(followUp[0]);
		expect(worker.calls()).toBe(callsBefore);
		expect(runtime.hostSecretsPause).toBe("paused");
		expect(runtime.config.passive).toBe(true);
		// No further follow-up was queued (fired timers stay in the fake list).
		expect(host.live().filter((timer) => timer !== followUp[0])).toEqual([]);
		expect(host.messages(PAUSED)).toHaveLength(1);
	});

	for (const switched of [false, true]) {
		test(`a running pass ${switched ? "stops before the reflector when Hide Secrets is switched on during the observer" : "reaches the reflector when Hide Secrets stays off"}`, async () => {
			const host = boot({
				authOk: true,
				env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1", OB_MEMORY_REFLECT_AFTER_TOKENS: "1" },
			});
			await host.emit("session_start");
			const runtime = host.runtime();
			cancelScheduledConsolidation(runtime);
			host.entries.push(...backlogEntries(2));
			// The observer's second turn (after its tool result) is the last call
			// before the reflector stage.
			const worker = citingObserverComplete(async (call) => {
				if (switched && call === 2) host.setHideSecrets(true);
			});

			const result = await consolidate(runtime, "agent_end", { complete: worker.complete });
			expect(result.observed).toBe(1);
			const reflections = host.entries.filter(
				(entry) => entry.type === "custom" && entry.customType === "ob-memory.reflections.recorded",
			);
			if (switched) {
				expect(worker.calls()).toBe(2);
				expect(runtime.hostSecretsPause).toBe("paused");
				expect(runtime.config.passive).toBe(true);
				expect(reflections).toEqual([]);
			} else {
				expect(worker.calls()).toBeGreaterThan(2);
				expect(runtime.hostSecretsPause).toBeUndefined();
			}
		});
	}

	test("a switch while the pass resolves its worker model stops it before the observer request", async () => {
		const host = boot({ authOk: true, env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1" } });
		await host.emit("session_start");
		const runtime = host.runtime();
		cancelScheduledConsolidation(runtime);
		host.entries.push(...backlogEntries(2));
		// Auth can await an OAuth refresh; the user flips Hide Secrets meanwhile.
		Object.assign(host.ctx.modelRegistry, {
			getApiKeyAndHeaders: async () => {
				host.setHideSecrets(true);
				return { ok: true, apiKey: "test-key", headers: {} };
			},
		});
		const worker = citingObserverComplete();
		const result = await consolidate(runtime, "agent_end", { complete: worker.complete });
		expect(worker.calls()).toBe(0);
		expect(result.skipped).toBe("aborted");
		expect(runtime.hostSecretsPause).toBe("paused");
		expect(runtime.failureCount).toBe(0);
	});

	test("a switch during a worker turn stops the next turn, which would resend the chunk", async () => {
		const host = boot({ authOk: true, env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1" } });
		await host.emit("session_start");
		const runtime = host.runtime();
		cancelScheduledConsolidation(runtime);
		host.entries.push(...backlogEntries(2));
		const worker = citingObserverComplete(async (call) => {
			if (call === 1) host.setHideSecrets(true);
		});
		const result = await consolidate(runtime, "agent_end", { complete: worker.complete });
		expect(worker.calls()).toBe(1);
		expect(result.skipped).toBe("aborted");
		expect(runtime.hostSecretsPause).toBe("paused");
	});

	test("a busy retry that fires after the switch pauses and stops the pass holding the lock", async () => {
		const host = boot({ env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "1" } });
		await host.emit("session_start");
		const runtime = host.runtime();
		cancelScheduledConsolidation(runtime);
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const holder = runtime.runExclusive("test", async (passSignal) => {
			signal = passSignal;
			await gate;
			passSignal.throwIfAborted();
		});
		expect((await consolidate(runtime, "agent_end")).skipped).toBe("busy");
		const retry = host.live();
		expect(retry.map((timer) => timer.delay)).toEqual([1_000]);

		host.setHideSecrets(true);
		await host.fire(retry[0]);
		expect(signal?.aborted).toBe(true);
		expect(runtime.hostSecretsPause).toBe("paused");
		release();
		expect(await holder).toBe(false);
		expect(host.authCalls()).toBe(0);
	});
});

describe("omp Hide Secrets turned off while paused", () => {
	const RESUMED = "automatic memory passes resumed";

	test("the pause lifts at the next check and memory resumes", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		const runtime = host.runtime();
		expect(runtime.hostSecretsPause).toBe("paused");
		expect(host.handlers.get("session_before_compact")).toBeUndefined();

		host.setHideSecrets(false);
		await host.emit("turn_end");
		expect(runtime.hostSecretsPause).toBeUndefined();
		expect(runtime.config.passive).toBe(false);
		expect(host.messages(RESUMED)).toEqual([{ message: expect.stringContaining("Hide Secrets is off"), type: "info" }]);
		expect(host.live().map((timer) => timer.delay)).toEqual([300]);
		expect(host.handlers.get("session_before_compact")).toHaveLength(1);

		host.notifications.length = 0;
		await host.command("status");
		expect(host.notifications.map((entry) => entry.message).join("\n")).toContain("host Hide Secrets: off; not paused");
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
		await host.command("observe-now");
		expect(host.messages("observe-now refused")).toEqual([]);
		expect(host.authCalls()).toBe(1);
	});

	test("a command after Hide Secrets was turned off sees the lifted pause", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		host.setHideSecrets(false);
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
		await host.command("observe-now");
		expect(host.messages("observe-now refused")).toEqual([]);
		expect(host.runtime().hostSecretsPause).toBeUndefined();
		expect(host.authCalls()).toBe(1);
	});

	test("a session configured passive stays passive", async () => {
		const host = boot({ hideSecrets: true, env: { OB_MEMORY_PASSIVE: "true" } });
		await host.emit("session_start");
		const runtime = host.runtime();
		expect(runtime.hostSecretsPause).toBe("paused");

		host.setHideSecrets(false);
		await host.emit("agent_end", { messages: [] });
		expect(runtime.hostSecretsPause).toBeUndefined();
		expect(runtime.config.passive).toBe(true);
		expect(host.messages(RESUMED)).toEqual([]);
		expect(host.live()).toEqual([]);
		// Headless operators saw the pause in the omp log; they see its end too.
		expect(host.logs.some((line) => line.message.includes("the pause is lifted and the session stays passive"))).toBe(true);
	});

	test("passive on during the pause survives the lift", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		const runtime = host.runtime();
		await host.command("passive on");
		expect(runtime.hostSecretsPause).toBe("paused");

		host.setHideSecrets(false);
		await host.emit("agent_end", { messages: [] });
		expect(runtime.hostSecretsPause).toBeUndefined();
		expect(runtime.config.passive).toBe(true);
		expect(host.live()).toEqual([]);
	});

	test("Hide Secrets switched on again pauses again", async () => {
		const host = boot({ hideSecrets: true });
		await host.emit("session_start");
		const runtime = host.runtime();
		host.setHideSecrets(false);
		await host.emit("turn_end");
		expect(runtime.hostSecretsPause).toBeUndefined();

		host.setHideSecrets(true);
		await host.emit("turn_end");
		expect(runtime.hostSecretsPause).toBe("paused");
		expect(runtime.config.passive).toBe(true);
		expect(host.messages(PAUSED)).toHaveLength(2);
		expect(host.live()).toEqual([]);
	});
});

describe("omp Hide Secrets with pauseOnHostSecrets false", () => {
	const env = { OB_MEMORY_PAUSE_ON_HOST_SECRETS: "false" };

	test("warns once at bind and keeps workers running", async () => {
		const host = boot({ hideSecrets: true, env });
		await host.emit("session_start");
		expect(host.runtime().config.passive).toBe(false);
		expect(host.runtime().hostSecretsPause).toBeUndefined();
		expect(host.live().map((timer) => timer.delay)).toEqual([1_000]);
		await host.emit("turn_end");
		await host.emit("agent_end", { messages: [] });
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
		expect(host.messages(PAUSED)).toEqual([]);
	});

	test("a session bound passive warns when passive off enables workers, once", async () => {
		const host = boot({ hideSecrets: true, env: { ...env, OB_MEMORY_PASSIVE: "true" } });
		await host.emit("session_start");
		expect(host.messages(WARN_ONLY)).toEqual([]);

		await host.command("passive off");
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
		await host.command("passive on");
		await host.command("passive off");
		await host.emit("turn_end");
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
	});

	test("Hide Secrets turned on mid-session warns once at the next trigger", async () => {
		const host = boot({ env });
		await host.emit("session_start");
		expect(host.messages(WARN_ONLY)).toEqual([]);
		host.setHideSecrets(true);
		await host.emit("turn_end");
		await host.emit("agent_end", { messages: [] });
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
		expect(host.runtime().config.passive).toBe(false);
	});

	test("observe-now in a session bound passive warns before its forced pass, once", async () => {
		const host = boot({ hideSecrets: true, env: { ...env, OB_MEMORY_PASSIVE: "true" } });
		await host.emit("session_start");
		host.entries.push(messageEntry("m1", "user", "The database password is hunter2hunter2, keep it handy."));
		expect(host.messages(WARN_ONLY)).toEqual([]);

		await host.command("observe-now");
		// The forced pass reached worker-model resolution, after the warning.
		expect(host.authCalls()).toBe(1);
		const warnings = host.messages(WARN_ONLY);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.type).toBe("warning");
		const summary = host.notifications.findIndex((entry) => entry.message.includes("observations +0"));
		expect(host.notifications.indexOf(warnings[0] as { message: string; type: string })).toBeLessThan(summary);
		expect(host.logs.filter((line) => line.level === "warn" && line.message.includes(WARN_ONLY))).toHaveLength(1);

		await host.command("observe-now");
		await host.command("passive off");
		expect(host.authCalls()).toBe(2);
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
	});

	test("observe-now warns even with notifications off, since its output is explicit", async () => {
		const host = boot({
			hideSecrets: true,
			env: { ...env, OB_MEMORY_PASSIVE: "true", OB_MEMORY_SHOW_NOTIFICATIONS: "false" },
		});
		await host.emit("session_start");
		await host.command("observe-now");
		expect(host.messages(WARN_ONLY)).toHaveLength(1);
	});
});

describe("/ob-memory status Hide Secrets line", () => {
	const statusText = async (host: ReturnType<typeof boot>) => {
		host.notifications.length = 0;
		await host.command("status");
		return host.notifications.map((entry) => entry.message).join("\n");
	};

	test("reports detection and pause state, even with notifications off", async () => {
		const host = boot({ hideSecrets: true, env: { OB_MEMORY_SHOW_NOTIFICATIONS: "false", OB_MEMORY_DEBUG_LOG: "true" } });
		await host.emit("session_start");
		// The automatic warning is suppressed; status still shows the pause.
		expect(host.messages(PAUSED)).toEqual([]);
		expect(await statusText(host)).toContain("host Hide Secrets: on; automatic memory passes paused");
		expect(
			debugEvents(host.agentDir, "session-a").some(
				(event) => event.stage === "status" && event.event === "host_secret_obfuscation" && event.pause === "paused",
			),
		).toBe(true);

		await host.command("passive off");
		expect(await statusText(host)).toContain("host Hide Secrets: on; pause overridden by /ob-memory passive off");
	});

	test("reports off, unknown, and the warn-only configuration", async () => {
		const off = boot();
		await off.emit("session_start");
		expect(await statusText(off)).toContain("host Hide Secrets: off; not paused");

		const unknown = boot();
		Object.assign(unknown.ctx, { getSystemPrompt: undefined });
		await unknown.emit("session_start");
		expect(await statusText(unknown)).toContain("host Hide Secrets: unknown; not paused");

		const warnOnly = boot({ hideSecrets: true, env: { OB_MEMORY_PAUSE_ON_HOST_SECRETS: "false" } });
		await warnOnly.emit("session_start");
		expect(await statusText(warnOnly)).toContain(
			"host Hide Secrets: on; not paused (pauseOnHostSecrets: false); worker requests are not obfuscated",
		);
	});
});

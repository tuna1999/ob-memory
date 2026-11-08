import { mkdtempSync, rmSync } from "node:fs";
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

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface FakeTimer {
	delay: number;
	cleared: boolean;
}

/**
 * Drive the real extension factory against a fake host. Appends land in the
 * harness branch, the session id can change between events, and timers are
 * recorded and fire only when a test calls `fire`, so every assertion is
 * about lifecycle wiring.
 */
function boot(env: Record<string, string | undefined> = {}) {
	const handlers = new Map<string, Handler[]>();
	const { ctx, entries } = makeHarness();
	let sequence = 0;
	const pi = {
		setLabel() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", id: `x${++sequence}`, customType, data, timestamp: new Date().toISOString() });
		},
		logger: { info() {}, warn() {}, error() {} },
		zod: piZod,
	} as unknown as ExtensionAPI;
	const instance = createObMemory({ agentDir: tempDir("ob-memory-agent-"), env })(pi);

	let sessionId = "session-a";
	const timers: FakeTimer[] = [];
	const callbacks = new Map<FakeTimer, () => unknown>();
	Object.assign(ctx, {
		cwd: tempDir("ob-memory-cwd-"),
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

	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload } as never, ctx);
	};
	return {
		instance,
		ctx,
		entries,
		handlers,
		timers,
		emit,
		/** Run a recorded timer's callback by hand. */
		fire: async (timer: FakeTimer) => {
			const fn = callbacks.get(timer);
			if (!fn) throw new Error("unknown timer");
			await fn();
		},
		setSessionId: (id: string) => {
			sessionId = id;
		},
	};
}

/** Hold an exclusive pass open until released; like a worker, it checks abort before finishing. */
function holdPass(runtime: SessionRuntime) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let signal: AbortSignal | undefined;
	const done = runtime.runExclusive("test", async (passSignal) => {
		signal = passSignal;
		await gate;
		passSignal.throwIfAborted();
	});
	if (!signal) throw new Error("exclusive pass did not start");
	return {
		signal,
		finish: async () => {
			release();
			return done;
		},
	};
}

function bound(runtime: SessionRuntime | undefined): SessionRuntime {
	if (!runtime) throw new Error("no runtime bound");
	return runtime;
}

describe("session lifecycle", () => {
	for (const event of ["session_branch", "session_switch"]) {
		test(`${event} to a new session id disposes the old runtime and binds a new one`, async () => {
			const host = boot();
			await host.emit("session_start");
			const old = bound(host.instance.runtime);
			expect(old.sessionId).toBe("session-a");
			const pass = holdPass(old);

			host.setSessionId("session-b");
			await host.emit(event);

			expect(pass.signal.aborted).toBe(true);
			expect(old.disposed).toBe(true);
			expect(old.append("ob-memory.lifecycle", { event: "late" })).toBe(false);
			const next = bound(host.instance.runtime);
			expect(next).not.toBe(old);
			expect(next.sessionId).toBe("session-b");
			expect(next.disposed).toBe(false);
			expect(host.entries.filter((entry) => entry.customType === "ob-memory.lifecycle")).toHaveLength(2);
			expect(await pass.finish()).toBe(false);
			expect(old.failureCount).toBe(0);
		});
	}

	test("same-id session_tree keeps the runtime and only aborts at session_before_tree", async () => {
		const host = boot();
		await host.emit("session_start");
		const runtime = bound(host.instance.runtime);
		const pass = holdPass(runtime);

		await host.emit("session_before_tree");
		expect(pass.signal.aborted).toBe(true);
		await pass.finish();

		await host.emit("session_tree");
		expect(host.instance.runtime).toBe(runtime);
		expect(runtime.disposed).toBe(false);
		expect(runtime.append("ob-memory.lifecycle", { event: "still-live" })).toBe(true);
		expect(host.timers.at(-1)).toEqual({ delay: 500, cleared: false });
		expect(host.entries.filter((entry) => entry.customType === "ob-memory.lifecycle")).toHaveLength(2);
	});

	test("non-main agents bind nothing", async () => {
		const host = boot();
		Object.assign(host.ctx, { agent: { kind: "sub", id: "sub-1", name: "sub", depth: 1 } });
		await host.emit("session_start");
		await host.emit("turn_end");
		await host.emit("agent_end");
		expect(host.instance.runtime).toBeUndefined();
		expect(host.entries).toHaveLength(0);
		expect(host.timers).toHaveLength(0);
	});

	test("session_shutdown disposes the runtime", async () => {
		const host = boot();
		await host.emit("session_start");
		const runtime = bound(host.instance.runtime);
		await host.emit("session_shutdown");
		expect(host.instance.runtime).toBeUndefined();
		expect(runtime.disposed).toBe(true);
		expect(host.timers[0]?.cleared).toBe(true);
	});
});

describe("agent loop events", () => {
	test("agent_start aborts the in-flight pass and cancels scheduled work by default", async () => {
		const host = boot();
		await host.emit("session_start");
		const runtime = bound(host.instance.runtime);
		expect(host.timers).toEqual([{ delay: 1_000, cleared: false }]);
		const pass = holdPass(runtime);

		await host.emit("agent_start");
		expect(pass.signal.aborted).toBe(true);
		expect(host.timers[0]?.cleared).toBe(true);
		expect(await pass.finish()).toBe(false);
		expect(runtime.failureCount).toBe(0);
	});

	test("agent_start leaves work running when consolidateWhenIdle is false", async () => {
		const host = boot({ OB_MEMORY_CONSOLIDATE_WHEN_IDLE: "false" });
		await host.emit("session_start");
		const runtime = bound(host.instance.runtime);
		expect(runtime.config.consolidateWhenIdle).toBe(false);
		const pass = holdPass(runtime);

		await host.emit("agent_start");
		expect(pass.signal.aborted).toBe(false);
		expect(host.timers[0]?.cleared).toBe(false);
		expect(await pass.finish()).toBe(true);
	});

	test("agent_start cancels an async-settle pass that is only scheduled", async () => {
		const host = boot();
		await host.emit("session_start");
		await host.emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
		const pending = host.timers.at(-1);
		expect(pending).toEqual({ delay: 300, cleared: false });

		await host.emit("agent_start");
		expect(pending?.cleared).toBe(true);
	});

	for (const settle of [
		{ name: "lets a running async-settle pass finish", payload: { willContinue: true, awaitingAsyncWork: true }, aborted: false },
		{ name: "still aborts a running pass from a terminal settle", payload: {}, aborted: true },
	]) {
		test(`agent_start ${settle.name}`, async () => {
			const host = boot({ OB_MEMORY_OBSERVE_AFTER_TOKENS: "1" });
			await host.emit("session_start");
			const runtime = bound(host.instance.runtime);
			host.entries.push(
				messageEntry("m1", "user", "We decided to use Postgres 16 for the billing service."),
				messageEntry("m2", "assistant", "Noted. Starting the background job."),
			);
			// Hold the pass at worker-model auth; it never reaches a provider.
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let authCalls = 0;
			Object.assign(host.ctx.modelRegistry, {
				getApiKeyAndHeaders: async () => {
					authCalls++;
					await gate;
					return { ok: false, error: "auth held by test" };
				},
			});

			await host.emit("agent_end", { messages: [], ...settle.payload });
			const timer = host.timers.at(-1);
			if (!timer || timer.delay !== 300) throw new Error("agent_end scheduled no pass");
			const pass = host.fire(timer);
			for (let i = 0; i < 20 && authCalls === 0; i++) await Promise.resolve();
			expect(authCalls).toBe(1);
			expect(runtime.busy).toBe(true);
			const signal = runtime.abortController?.signal;
			if (!signal) throw new Error("no pass in flight");

			// The background job reports back and the host starts a new run.
			await host.emit("agent_start");
			expect(signal.aborted).toBe(settle.aborted);

			release();
			await pass;
			expect(runtime.busy).toBe(false);
			// A pass that was left running reached its own outcome (the held auth failed).
			if (!settle.aborted) expect(runtime.lastError?.stage).toBe("resolve");
		});
	}

	for (const settle of [
		{
			name: "lets a follow-up draining an async-settle backlog finish",
			payload: { willContinue: true, awaitingAsyncWork: true },
			reason: "agent_end_async",
			aborted: false,
		},
		{ name: "still aborts a follow-up of a terminal settle", payload: {}, reason: "agent_end", aborted: true },
	]) {
		test(`agent_start ${settle.name}`, async () => {
			const host = boot({ OB_MEMORY_OBSERVE_AFTER_TOKENS: "1", OB_MEMORY_OBSERVER_CHUNK_MAX_TOKENS: "256" });
			await host.emit("session_start");
			const runtime = bound(host.instance.runtime);
			host.entries.push(...backlogEntries(12));
			const recorded = () => host.entries.filter((entry) => entry.customType === "ob-memory.observations.recorded");
			// Hold the follow-up's first worker call (call 3: the settle's pass made two).
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let held = false;
			const worker = citingObserverComplete(async (call) => {
				if (call !== 3) return;
				held = true;
				await gate;
			});

			await host.emit("agent_end", { messages: [], ...settle.payload });
			// Run the settle's pass the way its timer would, with the scripted worker.
			cancelScheduledConsolidation(runtime);
			expect((await consolidate(runtime, settle.reason, { complete: worker.complete })).observed).toBe(1);
			expect(recorded()).toHaveLength(1);
			const followUp = host.timers.at(-1);
			if (!followUp || followUp.delay !== 250 || followUp.cleared) throw new Error("no follow-up queued");
			const pass = host.fire(followUp);
			for (let i = 0; i < 500 && !held; i++) await Promise.resolve();
			expect(held).toBe(true);
			expect(runtime.lastTriggerReason).toBe("followup");
			const signal = runtime.abortController?.signal;
			if (!signal) throw new Error("no pass in flight");

			// The background job reports back and the host starts a new run.
			await host.emit("agent_start");
			expect(signal.aborted).toBe(settle.aborted);

			release();
			await pass;
			expect(runtime.busy).toBe(false);
			// A follow-up left running records its chunk; an aborted one records nothing.
			expect(recorded()).toHaveLength(settle.aborted ? 1 : 2);
			expect(worker.calls()).toBe(settle.aborted ? 3 : 4);
		});
	}

	test("agent_start still aborts a compaction catch-up that runs during an async wait", async () => {
		const host = boot();
		await host.emit("session_start");
		const runtime = bound(host.instance.runtime);
		const [handler] = host.handlers.get("session_before_compact") ?? [];
		if (!handler) throw new Error("session_before_compact was not registered");
		host.entries.push(
			messageEntry("m1", "user", "Please use Postgres for this project."),
			messageEntry("m2", "assistant", "Understood, Postgres it is."),
			observationEntry("o1", [observationRecord("aaaaaaaaaaaa", ["m1"], "m1", "User chose Postgres for the project database.")], "m1"),
			messageEntry("m3", "user", "Also use pgbouncer with pool size 40."),
			messageEntry("m4", "assistant", "Configured pgbouncer."),
			messageEntry("m5", "user", "Keep this tail."),
		);
		// An async-wait settle whose own pass already ran.
		await host.emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
		cancelScheduledConsolidation(runtime);
		runtime.lastTriggerReason = "agent_end_async";
		// Hold the catch-up at worker-model auth.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		Object.assign(host.ctx.modelRegistry, {
			getApiKeyAndHeaders: async () => {
				held = true;
				await gate;
				return { ok: false, error: "auth held by test" };
			},
		});
		const compaction = handler(
			{
				type: "session_before_compact",
				branchEntries: host.entries,
				preparation: { firstKeptEntryId: "m5", settings: {} },
				signal: new AbortController().signal,
			} as never,
			host.ctx,
		) as Promise<unknown>;
		for (let i = 0; i < 500 && !held; i++) await Promise.resolve();
		expect(held).toBe(true);
		expect(runtime.busy).toBe(true);
		const signal = runtime.abortController?.signal;
		if (!signal) throw new Error("no catch-up in flight");

		await host.emit("agent_start");
		expect(signal.aborted).toBe(true);
		release();
		await compaction;
		expect(runtime.busy).toBe(false);
	});

	test("agent_end schedules consolidation for terminal and async-wait settles only", async () => {
		const host = boot();
		await host.emit("session_start");
		const delays = () => host.timers.map((timer) => timer.delay);
		expect(delays()).toEqual([1_000]);

		await host.emit("agent_end", { messages: [], willContinue: true });
		expect(delays()).toEqual([1_000]);

		await host.emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
		expect(delays()).toEqual([1_000, 300]);

		await host.emit("agent_end", { messages: [] });
		expect(delays()).toEqual([1_000, 300, 300]);
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
	zod as piZod,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent";
import obMemory, { createObMemory, type ObMemoryOptions } from "../src/index";
import type { LedgerEntry } from "../src/ledger/types";
import { makeHarness, messageEntry, observationEntry, observationRecord } from "./helpers";

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

/** Fake host: records registrations and keeps every handler per event. */
function makeHost() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const tools: Array<{ name: string; approval?: unknown }> = [];
	const appended: { customType: string; data: unknown }[] = [];
	const pi = {
		setLabel() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: { name: string; approval?: unknown }) {
			tools.push(tool);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, options.handler);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		logger: { info() {}, warn() {}, error() {} },
		zod: piZod,
	} as unknown as ExtensionAPI;
	const emit = async (event: string, ctx: ExtensionContext, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload } as never, ctx);
	};
	const command = async (args: string, ctx: ExtensionContext) => commands.get("ob-memory")?.(args, ctx);
	return { pi, handlers, commands, tools, appended, emit, command };
}

/** Harness ctx with a private cwd, captured notifications, and timers that never fire. */
function makeCtx(cwd: string) {
	const { ctx } = makeHarness();
	const notifications: string[] = [];
	const timers: number[] = [];
	Object.assign(ctx, {
		cwd,
		hasUI: true,
		setTimeout: (_fn: () => void, delay: number) => {
			timers.push(delay);
			return timers.length as never;
		},
		clearTimer: () => {},
	});
	Object.assign(ctx.ui, { notify: (message: string) => notifications.push(message) });
	return { ctx, notifications, timers };
}

function load(options: ObMemoryOptions = {}) {
	const host = makeHost();
	const agentDir = options.agentDir ?? tempDir("ob-memory-agent-");
	const instance = createObMemory({ agentDir, env: {}, ...options })(host.pi);
	const { ctx, notifications, timers } = makeCtx(tempDir("ob-memory-cwd-"));
	return { ...host, instance, ctx, notifications, timers, agentDir };
}

describe("extension factory", () => {
	test("the default export registers tools and commands without binding", () => {
		const host = makeHost();
		obMemory(host.pi);
		expect(host.tools.map((tool) => tool.name)).toContain("ob_recall");
		expect([...host.commands.keys()]).toContain("ob-memory");
		expect(host.handlers.has("session_start")).toBe(true);
		expect(host.appended).toHaveLength(0);
	});

	test("schedules turn_end consolidation when consolidateWhenIdle is false", async () => {
		const { instance, ctx, timers, emit } = load();
		mkdirSync(join(ctx.cwd, ".omp"), { recursive: true });
		writeFileSync(join(ctx.cwd, ".omp", "ob-memory.json"), JSON.stringify({ consolidateWhenIdle: false }));
		Object.assign(ctx, { isIdle: () => false });

		await emit("session_start", ctx);
		expect(instance.runtime?.config.consolidateWhenIdle).toBe(false);
		expect(timers).toEqual([1_000]);
		await emit("turn_end", ctx);
		expect(timers).toEqual([1_000, 300]);
		await emit("session_shutdown", ctx);
		expect(instance.runtime).toBeUndefined();
	});

	test("binds a main session with the injected agent dir config", async () => {
		const agentDir = tempDir("ob-memory-agent-");
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ passive: true }));
		const { ctx, notifications, timers, appended, emit, command } = load({ agentDir });

		await emit("session_start", ctx);
		expect(appended.some((entry) => entry.customType === "ob-memory.lifecycle")).toBe(true);
		// The global file is applied: passive schedules nothing.
		expect(timers).toEqual([]);

		await command("status", ctx);
		expect(notifications.some((message) => message.includes("passive: true"))).toBe(true);

		await command("passive off", ctx);
		expect(timers).toEqual([100]);
		await emit("session_shutdown", ctx);
	});

	test("applies OB_MEMORY_* overrides only from the injected env", async () => {
		const { instance, ctx, timers, emit } = load({ env: { OB_MEMORY_PASSIVE: "true" } });
		await emit("session_start", ctx);
		expect(instance.runtime?.config.passive).toBe(true);
		expect(timers).toEqual([]);
	});

	test("redacts config warnings when redactSecrets is on", async () => {
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
		const { ctx, notifications, emit } = load({ env: { OB_MEMORY_MODEL: secret } });
		await emit("session_start", ctx);
		const warnings = notifications.filter((message) => message.startsWith("Observational Memory config:"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[REDACTED API KEY]");
		expect(warnings[0]).not.toContain(secret);
	});

	test("shows raw config warnings when redactSecrets is off", async () => {
		const { ctx, notifications, emit } = load({
			env: { OB_MEMORY_MODEL: "not-a-model", OB_MEMORY_REDACT_SECRETS: "false" },
		});
		await emit("session_start", ctx);
		expect(notifications).toContain('Observational Memory config: OB_MEMORY_MODEL: expected "provider/id", got "not-a-model"');
	});

	test("registers ob_recall with the read approval tier", () => {
		const { tools } = load();
		const recall = tools.find((tool) => tool.name === "ob_recall");
		expect(recall?.approval).toBe("read");
	});
});

describe("session_before_compact registration", () => {
	test("registers once a session binds with a config that can own compaction", async () => {
		const { ctx, handlers, emit } = load();
		expect(handlers.get("session_before_compact")).toBeUndefined();
		await emit("session_start", ctx);
		expect(handlers.get("session_before_compact")).toHaveLength(1);
	});

	test("stays unregistered while ob-memory can never own compaction", async () => {
		for (const env of [
			{ OB_MEMORY_ENABLED: "false" },
			{ OB_MEMORY_PASSIVE: "true" },
			{ OB_MEMORY_OWN_AUTO_COMPACTION: "false", OB_MEMORY_OWN_MANUAL_COMPACTION: "false" },
		]) {
			const { ctx, handlers, emit } = load({ env });
			await emit("session_start", ctx);
			expect(handlers.get("session_before_compact")).toBeUndefined();
			expect(handlers.get("session.compacting")).toHaveLength(1);
		}
	});

	test("passive off registers the handler exactly once", async () => {
		const { ctx, handlers, emit, command } = load({ env: { OB_MEMORY_PASSIVE: "true" } });
		await emit("session_start", ctx);
		expect(handlers.get("session_before_compact")).toBeUndefined();
		await command("passive off", ctx);
		expect(handlers.get("session_before_compact")).toHaveLength(1);
		await command("passive on", ctx);
		await command("passive off", ctx);
		expect(handlers.get("session_before_compact")).toHaveLength(1);
	});

	test("does not register for non-main agents", async () => {
		const { ctx, handlers, emit } = load();
		Object.assign(ctx, { agent: { kind: "sub", id: "sub-1", name: "sub", depth: 1 } });
		await emit("session_start", ctx);
		expect(handlers.get("session_before_compact")).toBeUndefined();
	});

	test("the registered handler owns compaction of a fully covered ledger", async () => {
		const { instance, ctx, handlers, emit } = load();
		await emit("session_start", ctx);
		const [handler] = handlers.get("session_before_compact") ?? [];
		if (!handler) throw new Error("session_before_compact was not registered");
		const branch = [
			messageEntry("e1", "user", "Please use Postgres for this project."),
			messageEntry("e2", "assistant", "Understood."),
			observationEntry("e3", [observationRecord("aaaaaaaaaaaa", ["e1"], "e2", "User chose Postgres for the project database.")], "e2"),
			messageEntry("e4", "user", "Keep this tail."),
		];
		const result = (await handler(compactEvent(branch, "e4") as never, ctx)) as SessionBeforeCompactResult | undefined;
		expect(result?.compaction?.summary).toContain("Postgres");
		expect(result?.compaction?.firstKeptEntryId).toBe("e4");
		expect(instance.runtime?.lastCompactionOwned).toBe(true);
	});

	test("the registered handler delegates focus-instruction compactions", async () => {
		const { instance, ctx, handlers, emit } = load();
		await emit("session_start", ctx);
		const [handler] = handlers.get("session_before_compact") ?? [];
		if (!handler) throw new Error("session_before_compact was not registered");
		const runtime = instance.runtime;
		if (!runtime) throw new Error("no runtime bound");
		expect(runtime.lastCompactionOwned).toBeUndefined();
		const event = { ...compactEvent([messageEntry("e1", "user", "hello")], "e1"), customInstructions: "focus on the API" };
		expect(await handler(event as never, ctx)).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("registers when either ownAutoCompaction or ownManualCompaction is on", async () => {
		for (const env of [{ OB_MEMORY_OWN_AUTO_COMPACTION: "false" }, { OB_MEMORY_OWN_MANUAL_COMPACTION: "false" }]) {
			const { ctx, handlers, emit } = load({ env });
			await emit("session_start", ctx);
			expect(handlers.get("session_before_compact")).toHaveLength(1);
		}
	});

	test("enabled false never registers, even after passive off", async () => {
		const { ctx, handlers, emit, command } = load({ env: { OB_MEMORY_ENABLED: "false", OB_MEMORY_PASSIVE: "true" } });
		await emit("session_start", ctx);
		await command("passive off", ctx);
		expect(handlers.get("session_before_compact")).toBeUndefined();
	});

	test("a session paused for omp Hide Secrets registers only after passive off", async () => {
		const { instance, ctx, handlers, emit, command } = load();
		Object.assign(ctx, { getSystemPrompt: () => [HIDE_SECRETS_NOTICE] });
		await emit("session_start", ctx);
		expect(instance.runtime?.hostSecretsPause).toBe("paused");
		expect(handlers.get("session_before_compact")).toBeUndefined();
		await command("status", ctx);
		expect(handlers.get("session_before_compact")).toBeUndefined();
		await command("passive off", ctx);
		expect(instance.runtime?.hostSecretsPause).toBe("overridden");
		expect(handlers.get("session_before_compact")).toHaveLength(1);
	});
});

const HIDE_SECRETS_NOTICE = "- `$$HASH$$`, `$$HASH:CASE$$`, `$$NAME_HASH:CASE$$` output tokens: opaque strings.";

function compactEvent(branchEntries: LedgerEntry[], firstKeptEntryId: string) {
	return {
		type: "session_before_compact",
		branchEntries,
		preparation: {
			firstKeptEntryId,
			tokensBefore: 12_000,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			fileOps: { read: new Set(), edited: new Set() },
			settings: {},
		},
		signal: new AbortController().signal,
	};
}

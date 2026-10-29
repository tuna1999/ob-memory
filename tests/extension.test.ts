import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { zod as piZod, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import obMemory from "../src/index";
import { makeHarness } from "./helpers";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const dirs: string[] = [];
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension factory", () => {
	test("schedules turn_end consolidation when consolidateWhenIdle is false", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ob-memory-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "ob-memory-cwd-"));
		dirs.push(agentDir, cwd);
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "ob-memory.json"), JSON.stringify({ consolidateWhenIdle: false }));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
		const pi = {
			setLabel() {},
			on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			logger: { info() {}, warn() {}, error() {} },
			zod: piZod,
		} as unknown as ExtensionAPI;
		obMemory(pi);

		const harness = makeHarness();
		harness.ctx.cwd = cwd;
		const ctx = harness.ctx as ExtensionContext & { isIdle: () => boolean };
		const timers: number[] = [];
		Object.assign(ctx, {
			isIdle: () => false,
			setTimeout: (_fn: () => void, delay: number) => {
				timers.push(delay);
				return timers.length as never;
			},
			clearTimer: () => {},
		});
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx);
		expect(timers).toEqual([1_000]);
		handlers.get("turn_end")?.({ type: "turn_end" } as never, ctx);
		expect(timers).toEqual([1_000, 300]);
		handlers.get("session_shutdown")?.({ type: "session_shutdown" } as never, ctx);
	});

	test("registers tools/commands and binds a main session", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ob-memory-agent-"));
		dirs.push(agentDir);
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ passive: true }));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
		const commandHandlers = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
		const tools: string[] = [];
		const commands: string[] = [];
		const entries: { customType?: string; data?: unknown }[] = [];
		const pi = {
			setLabel() {},
			on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
			},
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
				commands.push(name);
				commandHandlers.set(name, options.handler);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			logger: { info() {}, warn() {}, error() {} },
			zod: piZod,
		} as unknown as ExtensionAPI;
		obMemory(pi);
		expect(tools).toContain("ob_recall");
		expect(commands).toContain("ob-memory");

		const harness = makeHarness();
		const ctx = harness.ctx as ExtensionContext & { hasUI: boolean; ui: { notify: (message: string) => void } };
		ctx.hasUI = true;
		const notifications: string[] = [];
		ctx.ui.notify = (message: string) => notifications.push(message);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx);
		expect(entries.some((entry) => entry.customType === "ob-memory.lifecycle")).toBe(true);

		await commandHandlers.get("ob-memory")?.("status", ctx);
		expect(notifications.some((message) => message.includes("Observational Memory status"))).toBe(true);

		await commandHandlers.get("ob-memory")?.("passive on", ctx);
		await commandHandlers.get("ob-memory")?.("status", ctx);
		expect(notifications.some((message) => message.includes("passive: true"))).toBe(true);

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" } as never, ctx);
		expect(notifications.length).toBeGreaterThan(0);
	});
});

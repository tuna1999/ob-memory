import { describe, expect, test } from "bun:test";
import type { completeSimple, Model } from "@oh-my-pi/pi-ai";
import { handleMemoryCommand } from "../src/commands/control";
import { handleConfig } from "../src/commands/status";
import { handleView, limitViewText } from "../src/commands/view";
import { MEMORY_HEADER } from "../src/ledger/render";
import type { LedgerEntry } from "../src/ledger/types";
import { resolveWorkerModel } from "../src/workers/model";
import { consolidate, scheduleConsolidation } from "../src/workers/trigger";
import {
	makeAssistant,
	makeHarness,
	makeModel,
	makeToolCall,
	messageEntry,
	observationEntry,
	observationRecord,
	text,
} from "./helpers";

function capture(runtime: ReturnType<typeof makeHarness>["runtime"]): string[] {
	const notifications: string[] = [];
	Object.assign(runtime.ctx, {
		hasUI: true,
		mode: "rpc",
	});
	Object.assign(runtime.ctx.ui, {
		notify: (message: string) => notifications.push(message),
	});
	return notifications;
}

describe("memory commands", () => {
	test("config reports derived effective budgets", () => {
		const { runtime } = makeHarness();
		const notifications = capture(runtime);
		handleConfig(runtime, runtime.ctx);
		const output = notifications.join("\n");
		expect(output).toContain("observerChunkMaxTokens");
		expect(output).toContain("workerMemoryMaxTokens");
		expect(output).toContain("sessionModel");
		expect(output).toContain("compactionSummaryMaxTokens");
	});

	test("view redacts stored content when redaction is enabled", async () => {
		const { runtime, entries } = makeHarness({ redactSecrets: true });
		const content = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1", content)], "e1"),
		);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).not.toContain("dXNlcjpwYXNzd29yZA==");
		expect(output).toContain("REDACTED AUTHORIZATION HEADER");
	});
});

describe("view line limit", () => {
	function rendered(lines: number): string {
		return [MEMORY_HEADER, "", "## Observations", ...Array.from({ length: lines }, (_, i) => `record ${i}`)].join(
			"\n",
		);
	}

	test("keeps the header and the newest lines within the limit", () => {
		const text = rendered(200);
		const limited = limitViewText(text, 50);
		const lines = limited.text.split("\n");
		expect(lines.length).toBe(50);
		expect(lines[0]).toBe(MEMORY_HEADER.split("\n")[0]);
		expect(limited.text).toContain("record 199");
		expect(limited.text).not.toContain("record 0\n");
		expect(lines.at(-1)).toContain("earlier lines omitted");
		expect(limited.omitted).toBeGreaterThan(0);
	});

	test("builds at most the limit plus its note line, even without a header", () => {
		const limited = limitViewText("a\nb\nc\nd\ne", 3);
		expect(limited.text.split("\n").length).toBeLessThanOrEqual(4);
		expect(limited.text).toContain("e");
	});

	test("leaves a text that already fits untouched", () => {
		expect(limitViewText("a\nb", 5)).toEqual({ text: "a\nb", omitted: 0 });
	});

	test("view reports the omitted lines for a ledger over the cap", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(
			observationEntry(
				"o1",
				Array.from({ length: 130 }, (_, i) =>
					observationRecord(i.toString(16).padStart(12, "0"), ["e1"], "e1", `observation ${i}`),
				),
				"e1",
			),
		);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		expect(notifications.join("\n")).toContain("older lines omitted");
	});
});

function configOutput(notifications: string[]): Record<string, unknown> {
	const output = notifications.join("\n");
	return JSON.parse(output.slice(output.indexOf("{"))) as Record<string, unknown>;
}

function withModels(
	runtime: ReturnType<typeof makeHarness>["runtime"],
	session: Model | undefined,
	catalog: Record<string, Model>,
): void {
	Object.assign(runtime.ctx, {
		model: session,
		models: { current: () => session, resolve: (spec: string) => catalog[spec] },
	});
}

describe("config worker model selection", () => {
	test("reports fallbackModel budgets when the configured model is unavailable", async () => {
		const { runtime } = makeHarness({
			model: { provider: "missing", id: "primary" },
			fallbackModel: { provider: "small", id: "fallback" },
		});
		const session = makeModel({ contextWindow: 400_000 });
		withModels(runtime, session, {
			"small/fallback": makeModel({ provider: "small", id: "fallback", contextWindow: 8_000 }),
		});
		const notifications = capture(runtime);
		handleConfig(runtime, runtime.ctx);
		const config = configOutput(notifications);

		const resolved = await resolveWorkerModel(runtime.ctx, runtime.config, new AbortController().signal);
		expect(resolved.ok && resolved.value.label).toBe("small/fallback");
		expect(config.workerModel).toBe("small/fallback");
		expect(config.workerModelSource).toBe("fallback");
		expect(config.observerChunkMaxTokens).toBe(1_600);
		expect(config.workerMemoryMaxTokens).toBe(2_000);
	});

	test("reports the configured or session model when it resolves", () => {
		const configured = makeHarness({ model: { provider: "big", id: "worker" } });
		withModels(configured.runtime, makeModel(), {
			"big/worker": makeModel({ provider: "big", id: "worker", contextWindow: 200_000 }),
		});
		const configuredOut = capture(configured.runtime);
		handleConfig(configured.runtime, configured.runtime.ctx);
		const configuredConfig = configOutput(configuredOut);
		expect(configuredConfig.workerModel).toBe("big/worker");
		expect(configuredConfig.workerModelSource).toBe("configured");
		expect(configuredConfig.observerChunkMaxTokens).toBe(40_000);

		const session = makeHarness();
		const sessionOut = capture(session.runtime);
		handleConfig(session.runtime, session.runtime.ctx);
		const sessionConfig = configOutput(sessionOut);
		expect(sessionConfig.workerModel).toBe("test/test-model");
		expect(sessionConfig.workerModelSource).toBe("session");
	});

	test("marks the worker model unavailable when nothing resolves", () => {
		const { runtime } = makeHarness({ model: { provider: "missing", id: "primary" } });
		withModels(runtime, makeModel({ contextWindow: 400_000 }), {});
		const notifications = capture(runtime);
		handleConfig(runtime, runtime.ctx);
		const config = configOutput(notifications);
		expect(config.workerModel).toBe("missing/primary (unavailable)");
		expect(config.workerModelSource).toBe("unavailable");
		expect(config.observerChunkMaxTokens).toBe(12_000);
	});
});

describe("view after compaction", () => {
	test("does not claim there are no records after a native compaction", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1")], "e1"));
		entries.push({
			type: "compaction",
			id: "c1",
			timestamp: "2026-10-29T10:05:00.000Z",
			firstKeptEntryId: "e1",
			details: {},
		} as LedgerEntry);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).toContain("visible memory: 0 active observations");
		expect(output).not.toContain("no memory records yet");
		expect(output).toContain("latest compaction was native");
		expect(output).toContain("/ob-memory view full");
	});

	test("blames /clear, not the native compaction before it, for an empty visible view", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1")], "e1"));
		entries.push({
			type: "compaction",
			id: "c1",
			timestamp: "2026-10-29T10:05:00.000Z",
			firstKeptEntryId: "e1",
			details: {},
		} as LedgerEntry);
		entries.push({ type: "reset_boundary", id: "r1", timestamp: "2026-10-29T10:06:00.000Z" } as LedgerEntry);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).toContain("visible memory: 0 active observations");
		expect(output).toContain("cleared by /clear");
		expect(output).toContain("/ob-memory view full");
		expect(output).not.toContain("latest compaction was native");

		// The cleared record is still listed for audit.
		notifications.length = 0;
		await handleView(runtime, runtime.ctx, "full");
		expect(notifications.join("\n")).toContain("full ledger: 1 active observations");
	});

	test("blames /clear for an empty visible view without any compaction", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1")], "e1"));
		entries.push({ type: "reset_boundary", id: "r1", timestamp: "2026-10-29T10:06:00.000Z" } as LedgerEntry);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).toContain("visible memory: 0 active observations");
		expect(output).toContain("cleared by /clear");
	});

	test("a compaction after /clear decides the message again", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1")], "e1"));
		entries.push({ type: "reset_boundary", id: "r1", timestamp: "2026-10-29T10:06:00.000Z" } as LedgerEntry);
		entries.push(messageEntry("e2", "user", "after the clear"));
		entries.push({
			type: "compaction",
			id: "c1",
			timestamp: "2026-10-29T10:07:00.000Z",
			firstKeptEntryId: "e2",
			details: {},
		} as LedgerEntry);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).toContain("latest compaction was native");
		expect(output).not.toContain("cleared by /clear");
	});

	test("still reports an empty ledger as having no records", async () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "source text"));
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		expect(notifications.join("\n")).toContain("(no memory records yet)");
	});
});

describe("passive command", () => {
	test("passive on cancels scheduled consolidation", async () => {
		const { runtime } = makeHarness();
		const timers: { cleared: boolean }[] = [];
		Object.assign(runtime.ctx, {
			setTimeout: () => {
				const timer = { cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (timer: { cleared: boolean }) => {
				timer.cleared = true;
			},
		});
		scheduleConsolidation(runtime, "agent_end", 300);
		expect(timers).toHaveLength(1);
		await handleMemoryCommand(runtime, runtime.ctx, "passive on");
		expect(timers[0]?.cleared).toBe(true);
	});

	test("passive on aborts the in-flight pass without counting a failure", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		const record = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User chose Postgres for the project database.",
							relevance: "critical",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		let calls = 0;
		let started!: () => void;
		const firstCall = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const complete = (async () => {
			calls++;
			if (calls > 1) return makeAssistant([text("done")]);
			started();
			await gate;
			return record;
		}) as typeof completeSimple;

		const pass = consolidate(runtime, "agent_end", { complete });
		await firstCall;
		await handleMemoryCommand(runtime, runtime.ctx, "passive on");
		release();
		const result = await pass;

		expect(runtime.config.passive).toBe(true);
		expect(result.observed).toBe(0);
		expect(calls).toBe(1);
		expect(entries.filter((entry) => entry.type === "custom")).toHaveLength(0);
		expect(runtime.failureCount).toBe(0);
		expect(runtime.isFailureBackoffActive()).toBe(false);
		expect(runtime.lastError).toBeUndefined();
		expect(runtime.busy).toBe(false);
	});
});

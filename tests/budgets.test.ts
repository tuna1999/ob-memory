import { describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { handleStatus } from "../src/commands/status";
import { estimateTextTokens } from "../src/constants";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../src/config";
import { DEFAULT_CONFIG } from "../src/config-types";
import type { LedgerEntry, Observation } from "../src/ledger/types";
import { realTokensSinceObservationCoverage } from "../src/ledger/usage";
import type { SessionRuntime } from "../src/runtime";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { runObserver } from "../src/workers/observer";
import { consolidate, providerTokensSinceCoverage, shouldObserve } from "../src/workers/trigger";
import {
	makeAssistant,
	makeHarness,
	makeModel,
	messageEntry,
	observationEntry,
	observationRecord,
	text,
} from "./helpers";

function assistantUsageEntry(id: string, totalTokens: number): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-10-29T10:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			usage: {
				input: totalTokens - 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
			},
		},
	};
}

function withContextUsage(runtime: SessionRuntime, tokens: number): void {
	Object.assign(runtime.ctx, {
		getContextUsage: () => ({ tokens, contextWindow: 128_000, percent: (tokens / 128_000) * 100 }),
	});
}

describe("derived worker budgets", () => {
	test("scales the observer chunk with the resolved model window", () => {
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, 64_000)).toBe(12_800);
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, 200_000)).toBe(40_000);
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, 32_000)).toBe(6_400);
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, undefined)).toBe(12_000);
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, null)).toBe(12_000);
		expect(resolveObserverChunkMaxTokens(DEFAULT_CONFIG, 1_000)).toBe(256);
	});

	test("explicit chunk budget wins", () => {
		expect(
			resolveObserverChunkMaxTokens({ ...DEFAULT_CONFIG, observerChunkMaxTokens: 777 }, 200_000),
		).toBe(777);
	});

	test("observer prior memory uses the resolved model window", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const smallModel = makeModel({ contextWindow: 1_000 });
		const resolved: ResolvedWorkerModel = {
			model: smallModel,
			auth: { apiKey: "test-key" },
			thinking: "low",
			maxTokens: 4_096,
			label: "test/test-model",
			fallbackUsed: false,
		};
		const observations: Observation[] = Array.from({ length: 120 }, (_, index) => {
			const content = `Observation ${index}: ${"detail ".repeat(40)}`;
			return {
				id: index.toString(16).padStart(12, "0"),
				content,
				timestamp: "2026-10-29 10:00",
				relevance: "medium",
				sourceEntryIds: ["e1"],
				tokenCount: estimateTextTokens(content),
			};
		});
		let prompt = "";
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ content: string }> },
		) => {
			prompt = context.messages[0]?.content ?? "";
			return makeAssistant([text("done")]);
		}) as unknown as typeof completeSimple;

		await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations,
			chunk: "[Source entry id: e1]\n[User @ 2026-10-29 10:00]: hello",
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete,
		});

		expect(prompt).toContain("CURRENT MEMORY:");
		expect(estimateTextTokens(prompt)).toBeLessThan(3_000);
	});

	test("scales worker prior-memory with the resolved model window", () => {
		expect(resolveWorkerMemoryMaxTokens(DEFAULT_CONFIG, 64_000)).toBe(16_000);
		expect(resolveWorkerMemoryMaxTokens(DEFAULT_CONFIG, 200_000)).toBe(50_000);
		expect(resolveWorkerMemoryMaxTokens(DEFAULT_CONFIG, undefined)).toBe(16_000);
		expect(resolveWorkerMemoryMaxTokens(DEFAULT_CONFIG, 1_000)).toBe(256);
		expect(
			resolveWorkerMemoryMaxTokens({ ...DEFAULT_CONFIG, workerMemoryMaxTokens: 123 }, 200_000),
		).toBe(123);
	});
});

describe("provider context clock", () => {
	test("triggers the observer when provider growth reaches the threshold", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(assistantUsageEntry("a1", 4_000));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["a1"], "a1")], "a1"),
		);
		withContextUsage(runtime, 10_000);

		expect(providerTokensSinceCoverage(entries, runtime)).toBe(6_000);
		expect(shouldObserve(entries, runtime)).toBe(true);
	});

	test("does not treat the system prompt as unobserved conversation before coverage", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(messageEntry("u1", "user", "hi"));
		withContextUsage(runtime, 15_108);

		expect(realTokensSinceObservationCoverage(entries, 15_108)).toBeUndefined();
		expect(providerTokensSinceCoverage(entries, runtime)).toBeUndefined();
		expect(shouldObserve(entries, runtime)).toBe(false);
	});

	test("raw backlog still triggers before coverage", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(messageEntry("u1", "user", "x".repeat(30_000)));
		withContextUsage(runtime, 15_108);

		expect(providerTokensSinceCoverage(entries, runtime)).toBeUndefined();
		expect(shouldObserve(entries, runtime)).toBe(true);
	});

	test("ignores provider growth when the covered span has no usable usage baseline", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(messageEntry("u1", "user", "hello"));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
		);
		withContextUsage(runtime, 20_000);

		expect(providerTokensSinceCoverage(entries, runtime)).toBeUndefined();
		expect(shouldObserve(entries, runtime)).toBe(false);
	});

	test("does not anchor on assistant usage from before a compaction", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(assistantUsageEntry("a1", 1_000));
		entries.push({
			type: "compaction",
			id: "c1",
			timestamp: "2026-10-29T10:05:00.000Z",
			firstKeptEntryId: "a1",
			details: {},
		});
		entries.push(messageEntry("u2", "user", "new work"));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["u2"], "u2")], "u2"),
		);
		withContextUsage(runtime, 20_000);

		expect(realTokensSinceObservationCoverage(entries, 20_000)).toBeUndefined();
		expect(shouldObserve(entries, runtime)).toBe(false);
	});

	test("measures from the first assistant response after a compaction", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(messageEntry("u1", "user", "old work"));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
		);
		entries.push({
			type: "compaction",
			id: "c1",
			timestamp: "2026-10-29T10:05:00.000Z",
			firstKeptEntryId: "u1",
			details: {},
		});
		entries.push(assistantUsageEntry("a2", 3_000));
		withContextUsage(runtime, 9_000);

		expect(realTokensSinceObservationCoverage(entries, 9_000)).toBe(6_000);
		expect(shouldObserve(entries, runtime)).toBe(true);
	});

	test("consolidation chunks to the resolved model window", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		const smallModel = makeModel({ contextWindow: 1_000 });
		Object.assign(runtime.ctx, {
			model: smallModel,
			models: { current: () => smallModel, resolve: () => smallModel },
		});
		entries.push(messageEntry("e1", "user", "x".repeat(30_000)));

		const prompts: string[] = [];
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ content: string }> },
		) => {
			prompts.push(context.messages[0]?.content ?? "");
			return makeAssistant([text("done")]);
		}) as unknown as typeof completeSimple;

		await consolidate(runtime, "test", { force: true, complete });
		expect(prompts).toHaveLength(1);
		const chunk = prompts[0]!.split("NEW CONVERSATION CHUNK:").at(-1) ?? "";
		expect(estimateTextTokens(chunk)).toBeLessThan(600);
	});

	test("status reports the provider context delta", () => {
		const { runtime, entries } = makeHarness();
		entries.push(assistantUsageEntry("a1", 4_000));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["a1"], "a1")], "a1"),
		);
		withContextUsage(runtime, 10_000);
		const notices: string[] = [];
		Object.assign(runtime.ctx, { hasUI: true });
		Object.assign(runtime.ctx.ui, { notify: (message: string) => notices.push(message) });

		handleStatus(runtime, runtime.ctx);
		const output = notices.join("\n");
		expect(output).toContain("provider context:");
		expect(output).toContain("since the latest memory anchor");
	});

	test("falls back to raw tokens when the host cannot report context usage", () => {
		const { runtime, entries } = makeHarness({ observeAfterTokens: 6_000 });
		entries.push(assistantUsageEntry("a1", 4_000));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["a1"], "a1")], "a1"),
		);
		entries.push(messageEntry("u2", "user", "x".repeat(30_000)));

		expect(runtime.contextTokens()).toBeUndefined();
		expect(providerTokensSinceCoverage(entries, runtime)).toBeUndefined();
		expect(shouldObserve(entries, runtime)).toBe(true);
	});
});

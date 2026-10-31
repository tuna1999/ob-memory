import { describe, expect, test } from "bun:test";
import type { SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { handleSessionCompacting } from "../src/hooks/compacting";
import type { LedgerEntry } from "../src/ledger/types";
import { estimateTextTokens } from "../src/constants";
import {
	makeAssistant,
	makeHarness,
	makeToolCall,
	messageEntry,
	observationEntry,
	scriptedComplete,
	text,
} from "./helpers";

function sourceEntries(): LedgerEntry[] {
	return [
		messageEntry("e1", "user", "Please use Postgres for this project."),
		messageEntry("e2", "assistant", "Understood."),
		messageEntry("e3", "user", "Add a migrations folder."),
		messageEntry("e4", "assistant", "Done."),
	];
}

function observation(id: string, coversUpToId: string) {
	const content = "User chose Postgres for the project database.";
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "critical" as const,
		sourceEntryIds: ["e1"],
		tokenCount: estimateTextTokens(content),
	};
}

function event(entries: LedgerEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		branchEntries: entries,
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
	} as unknown as SessionBeforeCompactEvent;
}

describe("session_before_compact", () => {
	test("owns compaction and renders the ledger", async () => {
		const { runtime, ctx } = makeHarness();
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4"),
			messageEntry("e6", "user", "Keep this tail."),
		];
		const result = await handleSessionBeforeCompact(runtime, event(entries, "e6"), ctx);
		expect(result?.compaction).toBeDefined();
		expect(result?.compaction?.summary).toContain("Postgres");
		expect(result?.compaction?.firstKeptEntryId).toBe("e6");
		expect(result?.compaction?.details).toBeDefined();
		expect(runtime.lastCompactionOwned).toBe(true);
	});

	test("delegates when there is no observation coverage", async () => {
		const { runtime, ctx } = makeHarness();
		const result = await handleSessionBeforeCompact(runtime, event(sourceEntries(), "e6"), ctx);
		expect(result).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("retains the unobserved tail when it fits the budget", async () => {
		const { runtime, ctx } = makeHarness({ compactionMaxRetainedTokens: 100_000, compactionCatchUpMaxChunks: 0 });
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e2")], "e2"),
			messageEntry("e6", "user", "Keep this tail."),
		];
		const result = await handleSessionBeforeCompact(runtime, event(entries, "e6"), ctx);
		expect(result?.compaction).toBeDefined();
		expect(result?.compaction?.firstKeptEntryId).not.toBe("e6");
		expect(result?.compaction?.summary).toContain("Postgres");
	});

	test("delegates overflow recovery", async () => {
		const { runtime, ctx } = makeHarness();
		runtime.lastAutoCompactionReason = "overflow";
		runtime.autoCompactionStartedAt = Date.now();
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e2")], "e2"),
			messageEntry("e6", "user", "Keep this tail."),
		];
		const result = await handleSessionBeforeCompact(runtime, event(entries, "e6"), ctx);
		expect(result).toBeUndefined();
	});
});

describe("session.compacting fallback", () => {
	test("injects active memory when native compaction is used", () => {
		const { runtime, ctx } = makeHarness();
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4"),
		];
		const result = handleSessionCompacting(
			runtime,
			{ type: "session.compacting", sessionId: "session-test", messages: [] },
			Object.assign(ctx, { sessionManager: { ...ctx.sessionManager, getBranch: () => entries } }),
		);
		expect(result?.context?.[0]).toContain("Postgres");
		expect(result?.preserveData?.["ob-memory"]).toBeDefined();
	});

	test("does not repeat injection after a memory compaction with no new records", () => {
		const { runtime, ctx } = makeHarness();
		const observationRecord = observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4");
		const entries = [
			...sourceEntries(),
			observationRecord,
			{
				type: "compaction",
				id: "e6",
				firstKeptEntryId: "e3",
				details: {
					type: "ob-memory.folded",
					version: 1,
					fullFold: true,
					observations: [observation("aaaaaaaaaaaa", "e4")],
					reflections: [],
					droppedObservationIds: [],
					foldThroughEntryId: "e4",
				},
			},
		];
		const result = handleSessionCompacting(
			runtime,
			{ type: "session.compacting", sessionId: "session-test", messages: [] },
			Object.assign(ctx, { sessionManager: { ...ctx.sessionManager, getBranch: () => entries } }),
		);
		expect(result).toBeUndefined();
	});
});

describe("fallback after mixed compactions", () => {
	test("injects after a native compaction that follows a memory compaction", () => {
		const { runtime, ctx } = makeHarness();
		const obs = observation("aaaaaaaaaaaa", "e4");
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [obs], "e4"),
			{
				type: "compaction",
				id: "e6",
				firstKeptEntryId: "e4",
				details: {
					type: "ob-memory.folded",
					version: 1,
					fullFold: true,
					observations: [obs],
					reflections: [],
					droppedObservationIds: [],
					foldThroughEntryId: "e4",
				},
			},
			{
				type: "compaction",
				id: "e7",
				firstKeptEntryId: "e6",
				method: "soft",
			},
		];
		const result = handleSessionCompacting(
			runtime,
			{ type: "session.compacting", sessionId: "session-test", messages: [] },
			Object.assign(ctx, { sessionManager: { ...ctx.sessionManager, getBranch: () => entries } }),
		);
		expect(result?.context?.[0]).toContain("Postgres");
	});
});

describe("user focus", () => {
	test("delegates when /compact carries custom instructions", async () => {
		const { runtime, ctx } = makeHarness();
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4"),
			messageEntry("e6", "user", "Keep this tail."),
		];
		const base = event(entries, "e6");
		const result = await handleSessionBeforeCompact(
			runtime,
			{ ...base, customInstructions: "focus on auth" } as SessionBeforeCompactEvent,
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

describe("compaction catch-up", () => {
	function gapEntries(): LedgerEntry[] {
		return [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e2")], "e2"),
			messageEntry("e6", "user", "Keep this tail."),
		];
	}

	function catchUpModel() {
		return scriptedComplete([
			makeAssistant(
				[
					makeToolCall("record_observations", {
						observations: [
							{
								timestamp: "2026-10-29 10:00",
								content: "User asked to add a migrations folder.",
								relevance: "high",
								sourceEntryIds: ["e3"],
							},
						],
					}),
				],
				"toolUse",
			),
			makeAssistant([text("done")]),
		]);
	}

	test("observes the gap and then owns the proposed cut", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 0 });
		entries.push(...gapEntries());
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6"), ctx, {
			complete: catchUpModel(),
		});
		expect(result?.compaction?.firstKeptEntryId).toBe("e6");
		expect(result?.compaction?.summary).toContain("migrations folder");
	});

	test("preempts a background pass instead of skipping catch-up", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 0 });
		entries.push(...gapEntries());
		let backgroundAborted = false;
		const background = runtime.runExclusive(
			"consolidation",
			(signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						backgroundAborted = true;
						reject(signal.reason);
					});
				}),
			{ requireIdle: false },
		);
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6"), ctx, {
			complete: catchUpModel(),
		});
		expect(backgroundAborted).toBe(true);
		expect(await background).toBe(false);
		expect(runtime.isFailureBackoffActive()).toBe(false);
		expect(result?.compaction?.firstKeptEntryId).toBe("e6");
		expect(result?.compaction?.summary).toContain("migrations folder");
	});

	test("does not hang when a background pass ignores abort", async () => {
		const { runtime, ctx, entries } = makeHarness({
			compactionMaxRetainedTokens: 100_000,
			compactionCatchUpBudgetMs: 50,
		});
		entries.push(...gapEntries());
		let finish!: () => void;
		const background = runtime.runExclusive(
			"consolidation",
			() => new Promise<void>((resolve) => (finish = resolve)),
			{ requireIdle: false },
		);
		const started = Date.now();
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6"), ctx, {
			complete: catchUpModel(),
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		// No catch-up ran, so the unobserved tail is retained instead of lost.
		expect(result?.compaction?.firstKeptEntryId).not.toBe("e6");
		expect(result?.compaction?.summary).not.toContain("migrations folder");
		finish();
		await background;
	});
});

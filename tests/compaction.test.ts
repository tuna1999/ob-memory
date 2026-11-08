import { describe, expect, test } from "bun:test";
import type { SessionBeforeCompactEvent, SessionCompactingEvent } from "@oh-my-pi/pi-coding-agent";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { handleSessionCompacting } from "../src/hooks/compacting";
import { OM_OBSERVATIONS_RECORDED, type LedgerEntry, type MemoryDetails } from "../src/ledger/types";
import { estimateTextTokens } from "../src/constants";
import {
	makeAssistant,
	makeHarness,
	makeToolCall,
	messageEntry,
	observationEntry,
	observationRecord,
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

function event(
	entries: LedgerEntry[],
	firstKeptEntryId: string,
	settings: Record<string, unknown> = {},
): SessionBeforeCompactEvent {
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
			settings,
		},
		signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

/** A source message long enough that each observer chunk holds exactly one entry. */
function longMessage(id: string, role: "user" | "assistant", repeat = 4): LedgerEntry {
	return messageEntry(id, role, `Step ${id}: ${"the migration keeps the users table on Postgres. ".repeat(repeat)}`.trim());
}

function chunkSourceIds(context: { messages?: Array<{ role?: string; content?: unknown }> }): string[] {
	const first = context.messages?.[0];
	const prompt = typeof first?.content === "string" ? first.content : "";
	const chunk = prompt.slice(prompt.indexOf("NEW CONVERSATION CHUNK:"));
	return [...chunk.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((match) => match[1]!);
}

/**
 * Observer stand-in that records one observation citing every source entry of
 * the chunk it was sent, and logs those ids. `failOnChunk` makes that chunk's
 * provider call end with an error, as a 500/429 would.
 */
function chunkAwareComplete(calls: string[][], options: { failOnChunk?: number } = {}): typeof completeSimple {
	let chunk = 0;
	return (async (_model: unknown, context: { messages?: Array<{ role?: string; content?: unknown }> }) => {
		const messages = context.messages ?? [];
		if (messages[messages.length - 1]?.role === "toolResult") return makeAssistant([text("done")]);
		chunk++;
		const ids = chunkSourceIds(context);
		calls.push(ids);
		if (chunk === options.failOnChunk) return makeAssistant([], "error", "provider returned 500");
		return makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: `User walked through migration ${ids.join(" and ")} for the Postgres schema.`,
							relevance: "high",
							sourceEntryIds: ids,
						},
					],
				}),
			],
			"toolUse",
		);
	}) as unknown as typeof completeSimple;
}

/** A worker call that only settles when its signal aborts. */
const hangingComplete = ((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) =>
	new Promise((_resolve, reject) => {
		const signal = options?.signal;
		if (!signal) return;
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	})) as unknown as typeof completeSimple;

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

	test("folds observations recorded past the proposed cut into the owned summary", async () => {
		const { runtime, ctx } = makeHarness();
		const ahead = observationRecord(
			"bbbbbbbbbbbb",
			["m5"],
			"m5",
			"User confirmed the staging deploy succeeded after the migration.",
		);
		const entries: LedgerEntry[] = [
			messageEntry("m1", "user", "Deploy the migration to staging."),
			messageEntry("m2", "assistant", "Running the deploy."),
			messageEntry("m3", "user", "Watch the logs."),
			messageEntry("m4", "assistant", "Logs are clean."),
			messageEntry("m5", "user", "Staging deploy succeeded."),
			// The observer is ahead of the host's cut (m4): coverage is m5.
			observationEntry("o1", [ahead], "m5"),
		];
		const result = await handleSessionBeforeCompact(runtime, event(entries, "m4"), ctx);
		expect(result?.compaction?.firstKeptEntryId).toBe("m4");
		expect(result?.compaction?.summary).toContain("staging deploy succeeded");
		const details = result?.compaction?.details as MemoryDetails | undefined;
		expect(details?.observations.map((observation) => observation.id)).toContain("bbbbbbbbbbbb");
		expect(details?.foldThroughEntryId).toBe("m5");
		expect(runtime.lastCompactionOwned).toBe(true);
	});
});

describe("session.compacting fallback", () => {
	test("injects again when a method fallback re-runs the hook immediately", () => {
		const { runtime, ctx } = makeHarness();
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4"),
		];
		const branchCtx = Object.assign(ctx, { sessionManager: { ...ctx.sessionManager, getBranch: () => entries } });
		const compacting: SessionCompactingEvent = { type: "session.compacting", sessionId: "session-test", messages: [] };
		// e.g. snapcompact failed locally and the host retried with `soft`.
		const first = handleSessionCompacting(runtime, compacting, branchCtx);
		const second = handleSessionCompacting(runtime, compacting, branchCtx);
		expect(first?.context?.[0]).toContain("Postgres");
		expect(second?.context?.[0]).toContain("Postgres");
	});

	test("treats a rollover-wrapped memory compaction as already injected", () => {
		const { runtime, ctx } = makeHarness();
		const obs = observation("aaaaaaaaaaaa", "e4");
		const entries = [
			...sourceEntries(),
			observationEntry("e5", [obs], "e4"),
			{
				type: "compaction",
				id: "e6",
				firstKeptEntryId: "e3",
				details: {
					kind: "experimental-context-rollover",
					version: 1,
					hookDetails: {
						type: "ob-memory.folded",
						version: 1,
						fullFold: true,
						observations: [obs],
						reflections: [],
						droppedObservationIds: [],
						foldThroughEntryId: "e4",
					},
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

	test("bounds an in-flight worker call by the catch-up budget", async () => {
		const { runtime, ctx, entries } = makeHarness({
			compactionMaxRetainedTokens: 100_000,
			compactionCatchUpBudgetMs: 50,
		});
		entries.push(...gapEntries());
		const started = Date.now();
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6"), ctx, {
			complete: hangingComplete,
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(runtime.busy).toBe(false);
		// A timeout is a catch-up miss, not a worker failure.
		expect(runtime.isFailureBackoffActive()).toBe(false);
		expect(result?.compaction?.firstKeptEntryId).not.toBe("e6");
	});

	test("stops once coverage reaches the proposed cut instead of observing the kept tail", async () => {
		const { runtime, ctx, entries } = makeHarness({
			compactionMaxRetainedTokens: 100_000,
			compactionCatchUpMaxChunks: 4,
			observerChunkMaxTokens: 40,
		});
		entries.push(
			messageEntry("m1", "user", "Please use Postgres for this project."),
			messageEntry("m2", "assistant", "Understood."),
			observationEntry("o1", [observation("aaaaaaaaaaaa", "m2")], "m2"),
			longMessage("m3", "user"),
			longMessage("m4", "assistant"),
			longMessage("m5", "user"),
			longMessage("m6", "assistant"),
		);
		const calls: string[][] = [];
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m5"), ctx, {
			complete: chunkAwareComplete(calls),
		});
		expect(calls).toEqual([["m3"], ["m4"]]);
		expect(result?.compaction?.firstKeptEntryId).toBe("m5");
		expect(result?.compaction?.summary).toContain("migration m4");
	});

	test("keeps chunks already recorded when a later chunk fails", async () => {
		const { runtime, ctx, entries } = makeHarness({
			compactionMaxRetainedTokens: 600,
			compactionCatchUpMaxChunks: 3,
			observerChunkMaxTokens: 40,
		});
		entries.push(
			messageEntry("m1", "user", "Please use Postgres for this project."),
			messageEntry("m2", "assistant", "Understood."),
			observationEntry("o1", [observation("aaaaaaaaaaaa", "m2")], "m2"),
			// Retaining from here would exceed the 600-token tail budget.
			longMessage("m3", "user", 100),
			longMessage("m4", "assistant"),
			longMessage("m5", "user"),
			longMessage("m6", "assistant"),
			longMessage("m7", "user"),
		);
		const calls: string[][] = [];
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m6"), ctx, {
			complete: chunkAwareComplete(calls, { failOnChunk: 2 }),
		});
		expect(calls).toEqual([["m3"], ["m4"]]);
		// Chunk 1 covered m3, so only m4.. stays unobserved and fits the budget.
		expect(result?.compaction?.firstKeptEntryId).toBe("m4");
		expect(result?.compaction?.summary).toContain("migration m3");
		// The provider failure still backs off background passes.
		expect(runtime.isFailureBackoffActive()).toBe(true);
	});
});

describe("host requires a stable branch leaf (experimental context management)", () => {
	const stableLeaf = { experimentalContextManagement: true };

	function gapEntries(): LedgerEntry[] {
		return [
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e2")], "e2"),
			messageEntry("e6", "user", "Keep this tail."),
		];
	}

	function countingComplete(counter: { calls: number }): typeof completeSimple {
		const base = scriptedComplete([
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
		return (async (...args: Parameters<typeof completeSimple>) => {
			counter.calls++;
			return base(...args);
		}) as typeof completeSimple;
	}

	test("retains the unobserved tail without catching up or appending", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 100_000 });
		entries.push(...gapEntries());
		const leaf = entries[entries.length - 1]?.id;
		const count = entries.length;
		const counter = { calls: 0 };
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6", stableLeaf), ctx, {
			complete: countingComplete(counter),
		});
		expect(counter.calls).toBe(0);
		expect(entries.length).toBe(count);
		expect(entries[entries.length - 1]?.id).toBe(leaf);
		expect(result?.compaction?.firstKeptEntryId).not.toBe("e6");
		expect(result?.compaction?.summary).toContain("Postgres");
		expect(result?.compaction?.summary).not.toContain("migrations folder");
	});

	test("delegates without appending when the unobserved tail does not fit", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 0 });
		entries.push(...gapEntries());
		const count = entries.length;
		const counter = { calls: 0 };
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6", stableLeaf), ctx, {
			complete: countingComplete(counter),
		});
		expect(result).toBeUndefined();
		expect(counter.calls).toBe(0);
		expect(entries.length).toBe(count);
	});

	test("aborts a running background pass so it cannot move the leaf", async () => {
		const { runtime, ctx, entries } = makeHarness();
		entries.push(
			...sourceEntries(),
			observationEntry("e5", [observation("aaaaaaaaaaaa", "e4")], "e4"),
			messageEntry("e6", "user", "Keep this tail."),
		);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const background = runtime.runExclusive(
			"consolidation",
			async (signal) => {
				await gate;
				signal.throwIfAborted();
				runtime.append(OM_OBSERVATIONS_RECORDED, {
					observations: [observation("cccccccccccc", "e6")],
					coversUpToId: "e6",
				});
			},
			{ requireIdle: false },
		);
		const count = entries.length;
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "e6", stableLeaf), ctx);
		release();
		expect(await background).toBe(false);
		expect(entries.length).toBe(count);
		expect(runtime.isFailureBackoffActive()).toBe(false);
		expect(result?.compaction?.firstKeptEntryId).toBe("e6");
	});
});

import { describe, expect, test } from "bun:test";
import type { SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { estimateTextTokens } from "../src/constants";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { handleSessionCompacting } from "../src/hooks/compacting";
import {
	compactionProjection,
	foldLedger,
	fullProjection,
	latestResetBoundaryIndex,
	rawTokensAfterIndex,
	visibleProjection,
} from "../src/ledger/fold";
import { recallMemory } from "../src/ledger/recall";
import { chunkUnobservedEntries, estimateEntryTokens } from "../src/ledger/serialize";
import type { LedgerEntry, Observation, Reflection } from "../src/ledger/types";
import { realTokensSinceObservationCoverage } from "../src/ledger/usage";
import { makeHarness, messageEntry } from "./helpers";

// Host `/clear` appends a `reset_boundary` entry and keeps the session id, so
// every pre-clear ledger record stays on the branch (host agent-session.ts
// resetSessionContext, session-context.ts).

function obs(id: string, content: string, sourceEntryIds: string[], relevance: Observation["relevance"] = "critical"): Observation {
	return { id, content, timestamp: "2026-10-29 10:00", relevance, sourceEntryIds, tokenCount: estimateTextTokens(content) };
}

function refl(id: string, content: string, support: string[]): Reflection {
	return { id, content, supportingObservationIds: support, tokenCount: estimateTextTokens(content) };
}

function recorded(id: string, observations: Observation[], coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.observations.recorded",
		timestamp: "2026-10-29T10:00:00.000Z",
		data: { observations, coversUpToId },
	};
}

function reflected(id: string, reflections: Reflection[], coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.reflections.recorded",
		timestamp: "2026-10-29T10:00:00.000Z",
		data: { reflections, coversUpToId },
	};
}

function reset(id: string): LedgerEntry {
	return { type: "reset_boundary", id, timestamp: "2026-10-29T10:30:00.000Z" };
}

function assistantUsage(id: string, totalTokens: number): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-10-29T10:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			usage: { input: totalTokens - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens },
		},
	};
}

const falcon = obs("aaaaaaaaaaaa", "User is working on secret project Falcon with Postgres.", ["p1"]);
const falconReflection = refl("bbbbbbbbbbbb", "Project Falcon is the user's secret Postgres project.", [falcon.id]);
const cleanup = obs("cccccccccccc", "User asked to tidy the README wording.", ["n1"], "medium");

/** Observe, reflect, `/clear`, then observe the unrelated new task. */
function clearedSession(): LedgerEntry[] {
	return [
		messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
		messageEntry("p2", "assistant", "Noted."),
		recorded("o1", [falcon], "p2"),
		reflected("f1", [falconReflection], "p2"),
		reset("clear"),
		messageEntry("n1", "user", "Tidy the README wording."),
		messageEntry("n2", "assistant", "Done."),
		recorded("o2", [cleanup], "n2"),
		messageEntry("n3", "user", "Next task."),
	];
}

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id);

describe("/clear boundary in the ledger", () => {
	test("locates the latest boundary", () => {
		const entries = clearedSession();
		expect(latestResetBoundaryIndex(entries)).toBe(4);
		expect(latestResetBoundaryIndex(entries, 3)).toBe(-1);
		expect(latestResetBoundaryIndex(entries.slice(0, 4))).toBe(-1);
	});

	test("model-facing folds and projections exclude cleared records", () => {
		const entries = clearedSession();
		const fold = foldLedger(entries);
		expect(ids(fold.activeObservations)).toEqual([cleanup.id]);
		expect(ids(fold.reflections)).toEqual([]);
		const compaction = compactionProjection(entries, "n2");
		expect(ids(compaction.observations)).toEqual([cleanup.id]);
		expect(ids(compaction.reflections)).toEqual([]);
		expect(ids(compaction.details.observations)).toEqual([cleanup.id]);
		expect(ids(visibleProjection(entries).observations)).toEqual([cleanup.id]);
	});

	test("the audit projection keeps cleared records", () => {
		const full = fullProjection(clearedSession());
		expect(ids(full.observations)).toEqual([falcon.id, cleanup.id]);
		expect(ids(full.reflections)).toEqual([falconReflection.id]);
	});

	test("a record appended after the boundary but covering only cleared source is excluded", () => {
		// The observer lagged: its first post-clear pass still covered p2.
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			messageEntry("p2", "assistant", "Noted."),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
			recorded("o1", [falcon], "p2"),
			reflected("f1", [falconReflection], "p2"),
		];
		expect(foldLedger(entries).observations).toEqual([]);
		expect(foldLedger(entries).reflections).toEqual([]);
		expect(compactionProjection(entries, "n1").observations).toEqual([]);
	});

	test("records that mix both sides of the boundary are cleared entirely", () => {
		// Ledgers written by 0.3.2 could cover both sides in one record. An
		// observation citing any cleared source, and a reflection supported by
		// any cleared observation, carry cleared facts, so they are cleared
		// even though they also describe post-clear work.
		const mixedFalcon = obs("dddddddddddd", "User is working on secret project Falcon.", ["p1"]);
		const mixedCleanup = obs("eeeeeeeeeeee", "User asked to tidy the README.", ["n1"], "medium");
		const spanning = obs("ffffffffffff", "User moved from Falcon to README work.", ["p1", "n1"], "medium");
		const unresolved = obs("999999999999", "User wants the README in British English.", ["gone", "n1"], "medium");
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
			recorded("o1", [mixedFalcon, mixedCleanup, spanning, unresolved], "n1"),
			reflected(
				"f1",
				[
					refl("111111111111", "Falcon is secret.", [mixedFalcon.id]),
					refl("222222222222", "README tidy-up is ongoing.", [mixedCleanup.id, mixedFalcon.id]),
					refl("333333333333", "The user moved on from Falcon.", [mixedCleanup.id, spanning.id]),
					refl("444444444444", "README work is in British English.", [mixedCleanup.id, unresolved.id, "000000000000"]),
				],
				"n1",
			),
		];
		const fold = foldLedger(entries);
		// An id that is not on the branch ("gone") neither keeps nor clears.
		expect(ids(fold.observations)).toEqual([mixedCleanup.id, unresolved.id]);
		// Unknown supporting ids are ignored as well.
		expect(ids(fold.reflections)).toEqual(["444444444444"]);
		const compaction = compactionProjection(entries, "n1");
		expect(ids(compaction.observations)).toEqual([mixedCleanup.id, unresolved.id]);
		expect(ids(compaction.reflections)).toEqual(["444444444444"]);
		expect(ids(visibleProjection(entries).observations)).toEqual([mixedCleanup.id, unresolved.id]);
		expect(ids(visibleProjection(entries).reflections)).toEqual(["444444444444"]);
		// The audit view still shows every record.
		expect(ids(fullProjection(entries).observations)).toHaveLength(4);
		expect(ids(fullProjection(entries).reflections)).toHaveLength(4);
	});

	test("an observation whose sources are all off the branch falls back to its record's coverage", () => {
		const offBranch = obs("777777777777", "User reviewed the deploy plan.", ["gone"], "medium");
		const before: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
			recorded("o1", [offBranch], "p1"),
		];
		expect(foldLedger(before).observations).toEqual([]);
		const after: LedgerEntry[] = [...before.slice(0, 3), recorded("o1", [offBranch], "n1")];
		expect(ids(foldLedger(after).observations)).toEqual([offBranch.id]);
	});

	test("a 0.3.2 reflection that merged cleared and post-clear observations is cleared everywhere", async () => {
		// 0.3.2 folded cleared records into the reflector's pool after a
		// `/clear`, so one reflection could merge both sides.
		const merged = refl(
			"888888888888",
			"User works on secret project Falcon (Postgres) and is tidying its README wording.",
			[falcon.id, cleanup.id],
		);
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			recorded("o1", [falcon], "p1"),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
			messageEntry("n2", "assistant", "Done."),
			recorded("o2", [cleanup], "n2"),
			reflected("f1", [merged], "n2"),
			messageEntry("n3", "user", "Next task."),
		];
		expect(ids(foldLedger(entries).activeObservations)).toEqual([cleanup.id]);
		expect(foldLedger(entries).reflections).toEqual([]);
		expect(compactionProjection(entries, "n3").reflections).toEqual([]);
		expect(visibleProjection(entries).reflections).toEqual([]);
		expect(ids(fullProjection(entries).reflections)).toEqual([merged.id]);

		const recalled = recallMemory(entries, merged.id);
		expect(recalled.found).toBe(false);
		expect(recalled.cleared).toBe(true);
		expect(recalled.text).not.toContain("Falcon");

		const { runtime, ctx } = makeHarness();
		const result = await handleSessionBeforeCompact(runtime, compactEvent(entries, "n3"), ctx);
		expect(result?.compaction?.summary).toContain("README");
		expect(result?.compaction?.summary).not.toContain("Falcon");
	});

	test("a /clear after an ob-memory compaction hides that compaction's memory", () => {
		const base = clearedSession().slice(0, 4);
		const compaction = compactionProjection(base, "p2");
		const entries: LedgerEntry[] = [
			...base,
			{ type: "compaction", id: "c1", firstKeptEntryId: "p2", details: compaction.details },
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
		];
		expect(visibleProjection(entries.slice(0, 5)).observations).toHaveLength(1);
		const visible = visibleProjection(entries);
		expect(visible.observations).toEqual([]);
		expect(visible.reflections).toEqual([]);
	});

	test("chunking starts after the boundary even when the watermark lags", () => {
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			recorded("o1", [falcon], "p1"),
			messageEntry("p2", "assistant", "Noted."),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
		];
		expect(chunkUnobservedEntries(entries, "p1", 10_000)?.sourceEntryIds).toEqual(["n1"]);
		expect(chunkUnobservedEntries(entries, undefined, 10_000)?.sourceEntryIds).toEqual(["n1"]);
		expect(chunkUnobservedEntries(entries.slice(0, 4), "p1", 10_000)).toBeUndefined();
	});

	test("cleared source is not counted as unobserved backlog", () => {
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "x".repeat(40_000)),
			reset("clear"),
			messageEntry("n1", "user", "short"),
		];
		const estimate = (entry: LedgerEntry) => estimateEntryTokens(entry);
		expect(rawTokensAfterIndex(entries, -1, estimate)).toBe(estimateEntryTokens(entries[2]!));
	});

	test("provider-context growth is measured from the first response after the boundary", () => {
		const entries: LedgerEntry[] = [
			messageEntry("p1", "user", "old work"),
			assistantUsage("p2", 50_000),
			recorded("o1", [falcon], "p2"),
			reset("clear"),
			messageEntry("n1", "user", "new work"),
			assistantUsage("n2", 3_000),
		];
		expect(realTokensSinceObservationCoverage(entries, 9_000)).toBe(6_000);
	});

	test("recall never returns cleared memory or cleared source text", () => {
		const entries = clearedSession();
		const cleared = recallMemory(entries, falcon.id);
		expect(cleared.found).toBe(false);
		expect(cleared.cleared).toBe(true);
		expect(cleared.text).toContain("/clear");
		expect(cleared.text).not.toContain("Falcon");
		expect(recallMemory(entries, falconReflection.id).found).toBe(false);

		// A record that cites a cleared source is cleared as a whole, so recall
		// shows neither its text nor any of its sources.
		const mixed: LedgerEntry[] = [
			messageEntry("p1", "user", "Secret project Falcon uses Postgres."),
			reset("clear"),
			messageEntry("n1", "user", "Tidy the README wording."),
			recorded("o1", [obs("ffffffffffff", "User moved on to README work.", ["p1", "n1"], "medium")], "n1"),
		];
		const result = recallMemory(mixed, "ffffffffffff");
		expect(result.found).toBe(false);
		expect(result.cleared).toBe(true);
		expect(result.text).not.toContain("Falcon");
		expect(result.text).not.toContain("Tidy the README wording.");
		expect(result.sourceEntryIds).toEqual([]);
	});
});

function compactEvent(entries: LedgerEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent {
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

describe("/clear boundary in compaction", () => {
	test("an owned compaction summary does not resurrect cleared memory", async () => {
		const { runtime, ctx } = makeHarness();
		const result = await handleSessionBeforeCompact(runtime, compactEvent(clearedSession(), "n3"), ctx);
		expect(result?.compaction).toBeDefined();
		expect(result?.compaction?.summary).toContain("README");
		expect(result?.compaction?.summary).not.toContain("Falcon");
	});

	test("the native-compaction fallback does not inject cleared memory", () => {
		const { runtime, ctx } = makeHarness();
		const entries = clearedSession();
		const result = handleSessionCompacting(
			runtime,
			{ type: "session.compacting", sessionId: "session-test", messages: [] },
			Object.assign(ctx, { sessionManager: { ...ctx.sessionManager, getBranch: () => entries } }),
		);
		expect(result?.context?.[0]).toContain("README");
		expect(result?.context?.[0]).not.toContain("Falcon");
	});
});

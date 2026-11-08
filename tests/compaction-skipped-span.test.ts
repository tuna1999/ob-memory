import { describe, expect, test } from "bun:test";
import type { SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@oh-my-pi/pi-coding-agent";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import type { ObMemoryConfig } from "../src/config-types";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { OM_OBSERVATIONS_RECORDED, type LedgerEntry } from "../src/ledger/types";
import { latestCoverageId } from "../src/ledger/fold";
import { consolidate } from "../src/workers/trigger";
import {
	makeAssistant,
	makeHarness,
	makeToolCall,
	messageEntry,
	observationEntry,
	observationRecord,
	text,
	type Harness,
} from "./helpers";

const CARRIED_HEADING = "## Earlier compaction summary";

/** Coverage-only marker the observer appends when it gives up on a chunk. */
function skipMarker(id: string, coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		timestamp: new Date("2026-10-29T10:00:00Z").toISOString(),
		data: { observations: [], coversUpToId, coverageReason: "retry_limit" },
	};
}

function event(entries: LedgerEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		branchEntries: entries,
		preparation: {
			firstKeptEntryId,
			tokensBefore: 50_000,
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

const DECISION = "DECISION: deploy only to eu-west-1, never us-east-1. Ticket OPS-4411.";

function indexOf(entries: readonly LedgerEntry[], id: string | undefined): number {
	return entries.findIndex((entry) => entry.id === id);
}

describe("compaction with a chunk the observer skipped (retry_limit)", () => {
	function skippedBranch(): LedgerEntry[] {
		return [
			messageEntry("u1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
			messageEntry("u2", "user", DECISION),
			messageEntry("a2", "assistant", "Noted: eu-west-1 only, OPS-4411."),
			messageEntry("k3", "user", "Keep this tail."),
			// Three unproductive runs on u2..k3: the watermark skips the chunk.
			skipMarker("s1", "k3"),
		];
	}

	test("retains the skipped span instead of summarizing it away", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 100_000 });
		entries.push(...skippedBranch());
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "k3"), ctx);
		expect(result?.compaction).toBeDefined();
		// The never-observed decision stays in model context verbatim.
		const firstKept = indexOf(entries, result?.compaction?.firstKeptEntryId);
		expect(firstKept).toBeGreaterThanOrEqual(0);
		expect(firstKept).toBeLessThanOrEqual(indexOf(entries, "u2"));
		expect(result?.compaction?.summary).toContain("Postgres");
	});

	test("delegates when the skipped span does not fit the retained budget", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 1 });
		entries.push(...skippedBranch());
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "k3"), ctx);
		expect(result).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("observed records after the skipped span still reach the summary", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 100_000 });
		entries.push(
			...skippedBranch(),
			messageEntry("u4", "user", "Use pnpm for installs."),
			observationEntry(
				"o2",
				[observationRecord("abcdefabcdef", ["u4"], "u4", "User asked to use pnpm for installs.")],
				"u4",
			),
			messageEntry("k5", "user", "Keep this tail too."),
		);
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "k5"), ctx);
		expect(indexOf(entries, result?.compaction?.firstKeptEntryId)).toBeLessThanOrEqual(indexOf(entries, "u2"));
		expect(result?.compaction?.summary).toContain("pnpm");
	});

	test("a span before the latest compaction's kept tail does not block ownership", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 0 });
		entries.push(
			messageEntry("m1", "user", DECISION),
			messageEntry("m2", "assistant", "Noted."),
			skipMarker("s1", "m2"),
			messageEntry("m3", "user", "We use Postgres."),
			messageEntry("m4", "assistant", "Understood."),
			observationEntry("o1", [observationRecord("0123456789ab", ["m3"], "m4")], "m4"),
			// Native compaction summarized m1..m2; the live context starts at m3.
			{ type: "compaction", id: "c1", firstKeptEntryId: "m3", summary: "Earlier: deploy decision." },
			messageEntry("m5", "user", "Add a migrations folder."),
			messageEntry("m6", "assistant", "Done."),
			observationEntry(
				"o2",
				[observationRecord("abcdefabcdef", ["m5"], "m6", "User asked to add a migrations folder.")],
				"m6",
			),
			messageEntry("m7", "user", "Keep this tail."),
		);
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m7"), ctx);
		expect(result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(result?.compaction?.summary).toContain("migrations folder");
		// The native summary is the only record of the skipped m1..m2.
		expect(result?.compaction?.summary).toContain("Earlier: deploy decision.");
	});

	test("a span the host replays after a provider-native compaction is still live", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 100_000 });
		entries.push(
			messageEntry("m1", "user", "Use Postgres."),
			messageEntry("m2", "assistant", "OK."),
			observationEntry("o1", [observationRecord("aaaaaaaaaaaa", ["m1"], "m2")], "m2"),
			messageEntry("m3", "user", "Run the migration."),
			messageEntry("m4", "assistant", "Done."),
			observationEntry("o2", [observationRecord("bbbbbbbbbbbb", ["m3"], "m4", "User ran the migration.")], "m4"),
			messageEntry("m5", "user", DECISION),
			messageEntry("m6", "assistant", "Noted: eu-west-1 only."),
			// A remote or server-side compaction committed in the background: it
			// summarized through its replay snapshot m4, and the host replays
			// m5..m6 (session-context.ts), which the next preparation summarizes.
			{
				type: "compaction",
				id: "c1",
				summary: "Provider summary of m1..m4.",
				firstKeptEntryId: "",
				providerReplayThroughEntryId: "m4",
			} as LedgerEntry,
			skipMarker("s1", "m6"),
			messageEntry("m7", "user", "Next, the billing module."),
			messageEntry("m8", "assistant", "Refactored billing."),
			observationEntry("o3", [observationRecord("cccccccccccc", ["m7"], "m8", "User refactored billing.")], "m8"),
			messageEntry("m9", "user", "Keep going."),
		);
		// Retaining m5 would cross the compaction entry, so native must run.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m9"), ctx);
		expect(result).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("a span still inside the latest compaction's kept tail keeps blocking ownership", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 100_000 });
		entries.push(
			messageEntry("m1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			messageEntry("m2", "user", DECISION),
			messageEntry("m3", "assistant", "Noted."),
			skipMarker("s1", "m3"),
			// The previous compaction kept m2 onward, so the span is still live.
			{ type: "compaction", id: "c1", firstKeptEntryId: "m2", summary: "Earlier: Postgres." },
			messageEntry("m5", "user", "Add a migrations folder."),
			messageEntry("m6", "assistant", "Done."),
			observationEntry(
				"o2",
				[observationRecord("abcdefabcdef", ["m5"], "m6", "User asked to add a migrations folder.")],
				"m6",
			),
			messageEntry("m7", "user", "Keep this tail."),
		);
		// Retaining from m2 would cross the previous compaction: native must
		// re-summarize the kept span instead of ob-memory dropping it.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m7"), ctx);
		expect(result).toBeUndefined();
	});
});

describe("a skipped chunk that already left context", () => {
	/** Commit an owned result the way the host stores it. */
	function commit(entries: LedgerEntry[], id: string, result: SessionBeforeCompactResult | undefined): void {
		const compaction = result?.compaction;
		if (!compaction) throw new Error("expected an owned compaction");
		entries.push({
			type: "compaction",
			id,
			firstKeptEntryId: compaction.firstKeptEntryId,
			summary: compaction.summary,
			details: compaction.details,
			fromExtension: true,
		});
	}

	function skippedThenNative(config: Partial<ObMemoryConfig> = {}): Harness {
		const harness = makeHarness({ compactionCatchUpMaxChunks: 0, compactionMaxRetainedTokens: 30, ...config });
		harness.entries.push(
			messageEntry("u1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
			messageEntry("u2", "user", DECISION),
			messageEntry("a2", "assistant", "Noted: eu-west-1 only, OPS-4411."),
			skipMarker("s1", "a2"),
			messageEntry("u3", "user", "Add a migrations folder."),
			messageEntry("a3", "assistant", "Done, created migrations/."),
			observationEntry(
				"o2",
				[observationRecord("abcdefabcdef", ["u3"], "a3", "User asked to add a migrations folder.")],
				"a3",
			),
			messageEntry("u4", "user", "Keep this tail."),
		);
		return harness;
	}

	test("owned compactions carry the native summary that is the only record of it", async () => {
		const { runtime, ctx, entries } = skippedThenNative();
		// The live span does not fit the retained budget: native compacts it.
		expect(await handleSessionBeforeCompact(runtime, event([...entries], "u4"), ctx)).toBeUndefined();
		entries.push({ type: "compaction", id: "c1", firstKeptEntryId: "u4", summary: `Earlier: ${DECISION} Postgres.` });
		entries.push(
			messageEntry("u5", "user", "Run the tests."),
			messageEntry("a5", "assistant", "All green."),
			observationEntry(
				"o3",
				[observationRecord("aaaaaaaaaaaa", ["u5"], "a5", "User ran the test suite and it passed.")],
				"a5",
			),
			messageEntry("u6", "user", "Keep this tail too."),
		);
		const second = await handleSessionBeforeCompact(runtime, event([...entries], "u6"), ctx);
		expect(second?.compaction?.firstKeptEntryId).toBe("u6");
		expect(second?.compaction?.summary).toContain(CARRIED_HEADING);
		expect(second?.compaction?.summary).toContain("eu-west-1");
		expect(second?.compaction?.summary).toContain("test suite");
		expect((second?.compaction?.details as { carriedSummary?: string }).carriedSummary).toBe(
			`Earlier: ${DECISION} Postgres.`,
		);

		// The next owned compaction replaces that summary too, so it carries it on.
		commit(entries, "c2", second);
		entries.push(
			messageEntry("u7", "user", "Bump the version."),
			messageEntry("a7", "assistant", "Bumped to 1.2.0."),
			observationEntry(
				"o4",
				[observationRecord("bbbbbbbbbbbb", ["u7"], "a7", "User bumped the version to 1.2.0.")],
				"a7",
			),
			messageEntry("u8", "user", "Last tail."),
		);
		const third = await handleSessionBeforeCompact(runtime, event([...entries], "u8"), ctx);
		expect(third?.compaction?.firstKeptEntryId).toBe("u8");
		expect(third?.compaction?.summary).toContain("eu-west-1");
		expect(third?.compaction?.summary).toContain("version to 1.2.0");
		// Once, not nested.
		expect(third?.compaction?.summary?.split(DECISION).length).toBe(2);
	});

	test("a span retained by an owned compaction is carried once native compacts it", async () => {
		const { runtime, ctx, entries } = skippedThenNative({ compactionMaxRetainedTokens: 100_000 });
		const first = await handleSessionBeforeCompact(runtime, event([...entries], "u4"), ctx);
		expect(indexOf(entries, first?.compaction?.firstKeptEntryId)).toBeLessThanOrEqual(indexOf(entries, "u2"));
		expect(first?.compaction?.summary).not.toContain(CARRIED_HEADING);
		commit(entries, "c1", first);
		entries.push(
			messageEntry("u5", "user", "Run the tests."),
			messageEntry("a5", "assistant", "All green."),
			observationEntry(
				"o3",
				[observationRecord("aaaaaaaaaaaa", ["u5"], "a5", "User ran the test suite and it passed.")],
				"a5",
			),
			messageEntry("u6", "user", "Next tail."),
		);
		// The span sits in c1's kept tail and cannot be retained across c1.
		expect(await handleSessionBeforeCompact(runtime, event([...entries], "u6"), ctx)).toBeUndefined();
		entries.push({ type: "compaction", id: "c2", firstKeptEntryId: "u6", summary: `Native: ${DECISION} Tests green.` });
		entries.push(
			messageEntry("u7", "user", "Bump the version."),
			messageEntry("a7", "assistant", "Bumped to 1.2.0."),
			observationEntry(
				"o4",
				[observationRecord("bbbbbbbbbbbb", ["u7"], "a7", "User bumped the version to 1.2.0.")],
				"a7",
			),
			messageEntry("u8", "user", "Last tail."),
		);
		const third = await handleSessionBeforeCompact(runtime, event([...entries], "u8"), ctx);
		expect(third?.compaction?.firstKeptEntryId).toBe("u8");
		expect(third?.compaction?.summary).toContain("eu-west-1");
	});

	test("delegates rather than truncate a carried summary that does not fit the summary budget", async () => {
		const { runtime, ctx, entries } = skippedThenNative({ compactionSummaryMaxTokens: 2_000 });
		entries.push(
			{ type: "compaction", id: "c1", firstKeptEntryId: "u4", summary: `${DECISION} ${"Long native recap. ".repeat(600)}` },
			messageEntry("u5", "user", "Run the tests."),
			observationEntry("o3", [observationRecord("aaaaaaaaaaaa", ["u5"], "u5", "User ran the tests.")], "u5"),
			messageEntry("u6", "user", "Keep this tail too."),
		);
		expect(await handleSessionBeforeCompact(runtime, event([...entries], "u6"), ctx)).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("redacts the carried summary", async () => {
		const { runtime, ctx, entries } = skippedThenNative();
		entries.push(
			{ type: "compaction", id: "c1", firstKeptEntryId: "u4", summary: `${DECISION} Deploy key sk-abcdefghijklmnopqrstuvwx.` },
			messageEntry("u5", "user", "Run the tests."),
			observationEntry("o3", [observationRecord("aaaaaaaaaaaa", ["u5"], "u5", "User ran the tests.")], "u5"),
			messageEntry("u6", "user", "Keep this tail too."),
		);
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "u6"), ctx);
		expect(result?.compaction?.summary).toContain("eu-west-1");
		expect(result?.compaction?.summary).not.toContain("sk-abcdefghijklmnopqrstuvwx");
		expect(JSON.stringify(result?.compaction?.details)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
	});

	test("carries nothing without a skipped chunk, or once /clear removed it", async () => {
		const plain = makeHarness({ compactionCatchUpMaxChunks: 0 });
		plain.entries.push(
			messageEntry("m1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			{ type: "compaction", id: "c1", firstKeptEntryId: "m1", summary: "Native recap." },
			messageEntry("m2", "user", "Add a migrations folder."),
			observationEntry("o2", [observationRecord("abcdefabcdef", ["m2"], "m2", "User asked to add a migrations folder.")], "m2"),
			messageEntry("m3", "user", "Keep this tail."),
		);
		const result = await handleSessionBeforeCompact(plain.runtime, event([...plain.entries], "m3"), plain.ctx);
		expect(result?.compaction?.summary).toContain("migrations folder");
		expect(result?.compaction?.summary).not.toContain("Native recap.");

		const cleared = skippedThenNative();
		cleared.entries.push(
			{ type: "compaction", id: "c1", firstKeptEntryId: "u4", summary: `Earlier: ${DECISION}` },
			{ type: "reset_boundary", id: "r1", timestamp: new Date("2026-10-29T10:30:00Z").toISOString() },
			messageEntry("u5", "user", "Run the tests."),
			observationEntry("o3", [observationRecord("aaaaaaaaaaaa", ["u5"], "u5", "User ran the tests.")], "u5"),
			messageEntry("u6", "user", "Keep this tail too."),
		);
		const afterClear = await handleSessionBeforeCompact(cleared.runtime, event([...cleared.entries], "u6"), cleared.ctx);
		expect(afterClear?.compaction?.summary).toContain("ran the tests");
		expect(afterClear?.compaction?.summary).not.toContain("eu-west-1");
	});
});

function chunkSourceIds(context: { messages?: Array<{ role?: string; content?: unknown }> }): string[] {
	const first = context.messages?.[0];
	const prompt = typeof first?.content === "string" ? first.content : "";
	const start = prompt.indexOf("NEW CONVERSATION CHUNK:");
	if (start < 0) return [];
	return [...prompt.slice(start).matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((match) => match[1]!);
}

/**
 * A worker whose output is always cut off on the chunk holding `poisonId`
 * (stopReason "length", no tool call), and that records one observation for
 * every other chunk. Every chunk it is sent is logged.
 */
function poisonedComplete(poisonId: string, calls: string[][]): typeof completeSimple {
	return (async (_model: unknown, context: { messages?: Array<{ role?: string; content?: unknown }> }) => {
		const messages = context.messages ?? [];
		if (messages[messages.length - 1]?.role === "toolResult") return makeAssistant([text("done")]);
		const ids = chunkSourceIds(context);
		if (ids.length === 0) return makeAssistant([text("done")]);
		calls.push(ids);
		if (ids.includes(poisonId)) return makeAssistant([text("Let me think about which observations")], "length");
		return makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: `User walked through rollout step ${ids.join(" and ")} for the deploy.`,
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

function longMessage(id: string, role: "user" | "assistant", body: string): LedgerEntry {
	return messageEntry(id, role, `${body} ${"The rollout keeps the service in a single region. ".repeat(4)}`.trim());
}

describe("compaction catch-up that hits the retry limit", () => {
	test("keeps the chunk it skipped and stops instead of observing the kept tail", async () => {
		const { runtime, ctx, entries } = makeHarness({
			redactSecrets: false,
			compactionMaxRetainedTokens: 100_000,
			compactionCatchUpMaxChunks: 4,
			observerChunkMaxTokens: 40,
		});
		entries.push(
			messageEntry("u1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
			longMessage("u2", "user", DECISION),
			longMessage("a2", "assistant", "Noted: eu-west-1 only."),
			longMessage("u3", "user", "Next step."),
			longMessage("a3", "assistant", "Working on it."),
			longMessage("k4", "user", "Keep this tail."),
		);
		const calls: string[][] = [];
		const complete = poisonedComplete("u2", calls);
		// Two background attempts on the u2 chunk accept nothing.
		for (let i = 0; i < 2; i++) await consolidate(runtime, "observe-now", { force: true, complete });
		expect(latestCoverageId(entries, OM_OBSERVATIONS_RECORDED)).toBe("u1");
		expect(calls).toEqual([["u2"], ["u2"]]);

		// The third attempt happens inside compaction catch-up and skips u2.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "k4"), ctx, { complete });
		const marker = entries.find(
			(entry) => (entry.data as { coverageReason?: string } | undefined)?.coverageReason === "retry_limit",
		);
		expect(marker?.data).toMatchObject({ observations: [], coversUpToId: "u2" });
		// Observing newer chunks cannot make the skipped span observed.
		expect(calls).toEqual([["u2"], ["u2"], ["u2"]]);
		expect(result?.compaction).toBeDefined();
		expect(indexOf(entries, result?.compaction?.firstKeptEntryId)).toBeLessThanOrEqual(indexOf(entries, "u2"));
	});

	test("does not start catch-up when a live skipped span already starts the gap", async () => {
		const { runtime, ctx, entries } = makeHarness({
			redactSecrets: false,
			compactionMaxRetainedTokens: 100_000,
			compactionCatchUpMaxChunks: 4,
			observerChunkMaxTokens: 40,
		});
		entries.push(
			messageEntry("u1", "user", "We use Postgres."),
			observationEntry("o1", [observationRecord("0123456789ab", ["u1"], "u1")], "u1"),
			longMessage("u2", "user", DECISION),
			skipMarker("s1", "u2"),
			longMessage("a2", "assistant", "Noted: eu-west-1 only."),
			longMessage("u3", "user", "Next step."),
			longMessage("k4", "user", "Keep this tail."),
		);
		const calls: string[][] = [];
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "k4"), ctx, {
			complete: poisonedComplete("u2", calls),
		});
		expect(calls).toEqual([]);
		expect(indexOf(entries, result?.compaction?.firstKeptEntryId)).toBeLessThanOrEqual(indexOf(entries, "u2"));
	});
});

describe("catch-up with an observer that answers in prose", () => {
	test.each([
		"The user decided to deploy only to eu-west-1 (ticket OPS-4411) and never to us-east-1.",
		"Deploy creds are already in memory; the user deploys only to eu-west-1 (OPS-4411), never us-east-1.",
		"Nothing new.\nBut the user now deploys only to eu-west-1 (OPS-4411).",
	])("the reply %p does not let the same compaction summarize the chunk away", async (reply) => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 1, redactSecrets: false });
		entries.push(
			messageEntry("m1", "user", "Use pnpm for installs."),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			messageEntry("m2", "user", DECISION),
			messageEntry("m3", "assistant", "Noted: eu-west-1 only, OPS-4411."),
			messageEntry("m4", "user", "Keep this tail."),
		);
		let calls = 0;
		// A model with unreliable tool calling writes the fact instead of recording it.
		const prose = (async () => {
			calls++;
			return makeAssistant([text(reply)]);
		}) as unknown as typeof completeSimple;
		const result = await handleSessionBeforeCompact(runtime, event([...entries], "m4"), ctx, { complete: prose });
		expect(calls).toBeGreaterThan(0);
		// Coverage did not move past the decision, so the cut cannot own over it.
		expect(latestCoverageId(entries, OM_OBSERVATIONS_RECORDED)).toBe("m1");
		expect(result).toBeUndefined();
	});
});

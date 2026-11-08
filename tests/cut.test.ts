import { describe, expect, test } from "bun:test";
import { OM_OBSERVATIONS_RECORDED, type LedgerEntry } from "../src/ledger/types";
import {
	createContextTokenCounter,
	isCutPointEntry,
	liveContextStartIndex,
	observedCoverageIndex,
	resolveCompactionCut,
	skippedSourceSpans,
} from "../src/hooks/cut";
import { makeHarness, makeToolCall, messageEntry, observationEntry, observationRecord } from "./helpers";

function skipMarker(id: string, coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		timestamp: new Date("2026-10-29T10:00:00Z").toISOString(),
		data: { observations: [], coversUpToId, coverageReason: "retry_limit" },
	};
}

function emptyCoverage(id: string, coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		timestamp: new Date("2026-10-29T10:00:00Z").toISOString(),
		data: { observations: [], coversUpToId, coverageReason: "empty" },
	};
}

function toolEntries(): LedgerEntry[] {
	return [
		messageEntry("e1", "user", "run it"),
		{
			type: "message",
			id: "e2",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [makeToolCall("bash", { command: "pwd" })],
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "e3",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-1",
				content: [{ type: "text", text: "/tmp" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		messageEntry("e4", "assistant", "done"),
		messageEntry("e5", "user", "next"),
	];
}

describe("compaction cut", () => {
	test("isCutPointEntry rejects tool results", () => {
		const entries = toolEntries();
		expect(isCutPointEntry(entries[2]!)).toBe(false);
		expect(isCutPointEntry(entries[3]!)).toBe(true);
	});

	test("moves the retention boundary before an unobserved tool pair", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 100_000 });
		const entries = toolEntries();
		const resolution = resolveCompactionCut(entries, "e4", 0, {
			reason: "manual",
			runtime,
			rangeStartIndex: -1,
		});
		expect(resolution.kind).toBe("cut");
		if (resolution.kind === "cut") {
			expect(resolution.firstKeptEntryId).toBe("e2");
			expect(resolution.foldThroughEntryId).toBe("e1");
			expect(resolution.gap?.entryCount).toBeGreaterThan(0);
		}
	});

	test("folds through coverage when the observer is ahead of the cut", () => {
		const { runtime } = makeHarness();
		const entries: LedgerEntry[] = [
			messageEntry("e1", "user", "one"),
			messageEntry("e2", "assistant", "two"),
			messageEntry("e3", "user", "three"),
			messageEntry("e4", "assistant", "cut here"),
			messageEntry("e5", "user", "already observed"),
		];
		const resolution = resolveCompactionCut(entries, "e4", 4, {
			reason: "manual",
			runtime,
			rangeStartIndex: -1,
		});
		expect(resolution.kind).toBe("cut");
		if (resolution.kind === "cut") {
			expect(resolution.firstKeptEntryId).toBe("e4");
			expect(resolution.foldThroughEntryId).toBe("e5");
		}
	});

	test("delegates when the cut cannot be retained safely", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 1 });
		const resolution = resolveCompactionCut(toolEntries(), "e4", 0, {
			reason: "manual",
			runtime,
			rangeStartIndex: -1,
		});
		expect(resolution.kind).toBe("delegate");
	});

	test("delegates overflow", () => {
		const { runtime } = makeHarness();
		const resolution = resolveCompactionCut(toolEntries(), "e4", 0, {
			reason: "overflow",
			runtime,
			rangeStartIndex: -1,
		});
		expect(resolution.kind).toBe("delegate");
	});

	test("never moves the cut before the latest /clear boundary", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 100_000 });
		const entries: LedgerEntry[] = [
			messageEntry("e1", "user", "before clear"),
			{ type: "reset_boundary", id: "e2", timestamp: new Date().toISOString() },
			messageEntry("e3", "user", "after clear"),
			messageEntry("e4", "assistant", "still unobserved"),
			messageEntry("e5", "user", "cut here"),
		];
		const resolution = resolveCompactionCut(entries, "e5", 0, {
			reason: "manual",
			runtime,
			rangeStartIndex: -1,
		});
		expect(resolution.kind).toBe("delegate");
	});
});

describe("retained tail size", () => {
	function withToolResult(content: unknown[]): LedgerEntry[] {
		const entries = toolEntries();
		const result = entries[2]!;
		entries[2] = { ...result, message: { ...(result.message as object), content } };
		return entries;
	}

	test("counts the untruncated tool output, not the worker-prompt rendering", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 1_000_000 });
		const entries = withToolResult([{ type: "text", text: "row ".repeat(100_000) }]);
		const resolution = resolveCompactionCut(entries, "e4", 0, { reason: "manual", runtime, rangeStartIndex: -1 });
		expect(resolution.kind).toBe("cut");
		// 400k characters ≈ 100k tokens; the 40k-char worker rendering is ~10k.
		if (resolution.kind === "cut") expect(resolution.retainedTokens).toBeGreaterThanOrEqual(100_000);

		const { runtime: bounded } = makeHarness({ compactionMaxRetainedTokens: 50_000 });
		expect(resolveCompactionCut(entries, "e4", 0, { reason: "manual", runtime: bounded, rangeStartIndex: -1 }).kind).toBe(
			"delegate",
		);
	});

	test("charges retained images instead of a placeholder", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const entries = withToolResult(Array.from({ length: 10 }, () => image));
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 5_000 });
		const resolution = resolveCompactionCut(entries, "e4", 0, { reason: "manual", runtime, rangeStartIndex: -1 });
		expect(resolution.kind).toBe("delegate");
		expect(createContextTokenCounter(runtime).entry(entries[2]!)).toBeGreaterThanOrEqual(10 * 1_000);
	});

	test("falls back to an untruncated local estimate for messages the host tokenizer rejects", () => {
		const { runtime } = makeHarness();
		const counter = createContextTokenCounter(runtime);
		// String content on an assistant message is not a shape the host counts.
		expect(counter.message({ role: "assistant", content: "word ".repeat(80_000) })).toBeGreaterThanOrEqual(100_000);
	});
});

describe("skipped (retry_limit) source spans", () => {
	test("a span starts after the previous record's watermark and ends at the marker's coverage", () => {
		const entries: LedgerEntry[] = [
			messageEntry("m1", "user", "one"),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			messageEntry("m2", "assistant", "two"),
			messageEntry("m3", "user", "three"),
			skipMarker("s1", "m3"),
			messageEntry("m4", "assistant", "four"),
			emptyCoverage("c1", "m4"),
		];
		expect(skippedSourceSpans(entries)).toEqual([{ firstIndex: 1, lastIndex: 3 }]);
		// The watermark is m4, but only m1 was observed.
		expect(observedCoverageIndex(entries)).toBe(0);
		// An `empty` coverage record is a real observation pass, not a skip.
		expect(observedCoverageIndex([...entries.slice(0, 4), emptyCoverage("c0", "m3")])).toBe(3);
	});

	test("a span starts after a /clear that is newer than the previous watermark", () => {
		const entries: LedgerEntry[] = [
			messageEntry("m1", "user", "cleared"),
			{ type: "reset_boundary", id: "r1", timestamp: new Date().toISOString() },
			messageEntry("m2", "user", "after clear"),
			skipMarker("s1", "m2"),
			messageEntry("m3", "user", "tail"),
		];
		expect(skippedSourceSpans(entries)).toEqual([{ firstIndex: 2, lastIndex: 2 }]);
		expect(observedCoverageIndex(entries)).toBe(1);
	});

	test("spans before the live context are ignored and straddling spans are clamped to it", () => {
		const before: LedgerEntry[] = [
			messageEntry("m1", "user", "one"),
			messageEntry("m2", "assistant", "two"),
			skipMarker("s1", "m2"),
			messageEntry("m3", "user", "three"),
			observationEntry("o1", [observationRecord("0123456789ab", ["m3"], "m3")], "m3"),
			{ type: "compaction", id: "c1", firstKeptEntryId: "m3" },
			messageEntry("m4", "assistant", "four"),
		];
		expect(liveContextStartIndex(before)).toBe(3);
		expect(observedCoverageIndex(before)).toBe(3);

		const straddling: LedgerEntry[] = [
			messageEntry("m1", "user", "one"),
			messageEntry("m2", "assistant", "two"),
			messageEntry("m3", "user", "three"),
			skipMarker("s1", "m3"),
			{ type: "compaction", id: "c1", firstKeptEntryId: "m2" },
			messageEntry("m4", "assistant", "four"),
		];
		// m2..m3 were skipped and are still in context after c1.
		expect(liveContextStartIndex(straddling)).toBe(1);
		expect(observedCoverageIndex(straddling)).toBe(0);
	});

	test("a provider-native compaction keeps what follows its replay snapshot in context", () => {
		const providerCompaction = (firstKeptEntryId: string, providerReplayThroughEntryId?: string): LedgerEntry =>
			({ type: "compaction", id: "c1", firstKeptEntryId, providerReplayThroughEntryId }) as LedgerEntry;
		const branch = (compaction: LedgerEntry): LedgerEntry[] => [
			messageEntry("m1", "user", "one"),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			messageEntry("m2", "user", "skipped, appended while the provider compacted"),
			compaction,
			skipMarker("s1", "m2"),
			messageEntry("m3", "user", "after"),
			observationEntry("o2", [observationRecord("abcdefabcdef", ["m3"], "m3")], "m3"),
		];
		// Host session-context.ts replays m2 after a snapshot through m1.
		const replayed = branch(providerCompaction("", "m1"));
		expect(liveContextStartIndex(replayed)).toBe(1);
		expect(observedCoverageIndex(replayed)).toBe(0);
		// A first kept entry before the compaction wins over the snapshot.
		expect(liveContextStartIndex(branch(providerCompaction("m2", "m1")))).toBe(2);
		// Neither on the branch: only what follows the compaction is live.
		const unknown = branch(providerCompaction("", "gone"));
		expect(liveContextStartIndex(unknown)).toBe(4);
		expect(observedCoverageIndex(unknown)).toBe(5);
		// A kept id that only appears after the compaction is not a kept tail.
		expect(liveContextStartIndex(branch(providerCompaction("m3")))).toBe(4);
	});

	test("resolveCompactionCut retains from the skipped span but folds through the watermark", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 100_000 });
		const entries: LedgerEntry[] = [
			messageEntry("m1", "user", "one"),
			observationEntry("o1", [observationRecord("0123456789ab", ["m1"], "m1")], "m1"),
			messageEntry("m2", "user", "skipped decision"),
			messageEntry("m3", "assistant", "skipped reply"),
			skipMarker("s1", "m3"),
			messageEntry("m4", "user", "observed later"),
			observationEntry("o2", [observationRecord("abcdefabcdef", ["m4"], "m4")], "m4"),
			messageEntry("m5", "user", "cut here"),
		];
		const resolution = resolveCompactionCut(entries, "m5", 5, { reason: "manual", runtime, rangeStartIndex: -1 });
		expect(resolution.kind).toBe("cut");
		if (resolution.kind === "cut") {
			expect(resolution.gap?.firstIndex).toBe(1);
			expect(resolution.firstKeptEntryId).toBe("m1");
			expect(resolution.foldThroughEntryId).toBe("m4");
		}
	});

	test("resolveCompactionCut delegates when the live context starts with a skipped chunk", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 100_000 });
		const entries: LedgerEntry[] = [
			messageEntry("m1", "user", "skipped decision"),
			messageEntry("m2", "assistant", "skipped reply"),
			skipMarker("s1", "m2"),
			messageEntry("m3", "user", "cut here"),
		];
		expect(resolveCompactionCut(entries, "m3", 1, { reason: "manual", runtime, rangeStartIndex: -1 }).kind).toBe(
			"delegate",
		);
	});
});

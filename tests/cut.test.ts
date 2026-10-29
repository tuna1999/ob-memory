import { describe, expect, test } from "bun:test";
import type { LedgerEntry } from "../src/ledger/types";
import { isCutPointEntry, resolveCompactionCut } from "../src/hooks/cut";
import { makeHarness, makeToolCall, messageEntry } from "./helpers";

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

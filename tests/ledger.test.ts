import { describe, expect, test } from "bun:test";
import { hashMemoryId } from "../src/util/ids";
import {
	compactionProjection,
	foldLedger,
	fullProjection,
	visibleProjection,
} from "../src/ledger/fold";
import { renderMemory } from "../src/ledger/render";
import { chunkUnobservedEntries, serializeSourceEntries } from "../src/ledger/serialize";
import { recallMemory } from "../src/ledger/recall";
import type { LedgerEntry, Observation, Reflection } from "../src/ledger/types";
import { estimateTextTokens } from "../src/constants";
import { makeToolCall, messageEntry } from "./helpers";

function obs(id: string, content: string, source: string[] = ["e1"]): Observation {
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "medium",
		sourceEntryIds: source,
		tokenCount: estimateTextTokens(content),
	};
}

function refl(id: string, content: string, support: string[]): Reflection {
	return { id, content, supportingObservationIds: support, tokenCount: estimateTextTokens(content) };
}

function recorded(
	id: string,
	observations: Observation[],
	coversUpToId: string,
): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.observations.recorded",
		data: { observations, coversUpToId, createdAt: new Date().toISOString() },
	};
}

function reflected(
	id: string,
	reflections: Reflection[],
	coversUpToId: string,
): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.reflections.recorded",
		data: { reflections, coversUpToId, createdAt: new Date().toISOString() },
	};
}

function dropped(id: string, ids: string[], coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.observations.dropped",
		data: { observationIds: ids, coversUpToId, createdAt: new Date().toISOString() },
	};
}

describe("memory ids", () => {
	test("are deterministic and collision-safe", () => {
		const a = hashMemoryId("same", "2026-10-29 10:00", ["e1"]);
		const b = hashMemoryId("same", "2026-10-29 10:00", ["e1"]);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{12}$/);
		const c = hashMemoryId("same", "2026-10-29 10:00", ["e1"], new Set([a]));
		expect(c).not.toBe(a);
	});
});

describe("ledger fold and projections", () => {
	const base = [messageEntry("e1", "user", "hello"), messageEntry("e2", "assistant", "hi")];
	const observation = obs("aaaaaaaaaaaa", "User greeted the assistant.");
	const record = recorded("e3", [observation], "e2");
	const reflection = refl("bbbbbbbbbbbb", "User is testing the ledger.", [observation.id]);
	const reflectionRecord = reflected("e4", [reflection], "e2");
	const entries = [...base, record, reflectionRecord];

	test("first-valid record wins and drops tombstone", () => {
		const folded = foldLedger(entries);
		expect(folded.observations).toHaveLength(1);
		expect(folded.reflections).toHaveLength(1);
		const tombstoned = foldLedger([...entries, dropped("e5", [observation.id], "e2")]);
		expect(tombstoned.activeObservations).toHaveLength(0);
		expect(tombstoned.droppedObservationIds.has(observation.id)).toBe(true);
	});

	test("full, visible, and compaction projections respect boundaries", () => {
		const full = fullProjection(entries);
		expect(full.observations).toHaveLength(1);
		expect(full.reflections).toHaveLength(1);
		const atCut = fullProjection(entries, "e1");
		expect(atCut.observations).toHaveLength(0);
		const compaction = compactionProjection(entries, "e2");
		expect(compaction.observations).toHaveLength(1);
		expect(compaction.details.type).toBe("ob-memory.folded");
		const compacted: LedgerEntry = {
			type: "compaction",
			id: "e5",
			firstKeptEntryId: "e2",
			details: compaction.details,
		};
		const visible = visibleProjection([...entries, compacted]);
		expect(visible.observations).toHaveLength(1);
		expect(visible.reflections).toHaveLength(1);
	});

	test("dangling coverage is not applied to a projection", () => {
		const dangling = recorded("e9", [obs("cccccccccccc", "dangling")], "missing");
		const projection = fullProjection([...base, dangling]);
		expect(projection.observations).toHaveLength(0);
	});

	test("a tombstone recorded against coverage past the cut still applies to the compaction", () => {
		const observation = obs("dddddddddddd", "User chose Postgres.");
		const entries = [
			messageEntry("e1", "user", "Use Postgres."),
			recorded("e2", [observation], "e1"),
			messageEntry("e5", "user", "Cut here."),
			messageEntry("e6", "assistant", "Later."),
			dropped("e7", [observation.id], "e6"),
		];
		const compaction = compactionProjection(entries, "e5");
		expect(compaction.observations).toHaveLength(0);
		expect(compaction.droppedObservationIds).toContain(observation.id);

		// A historical projection at the cut must not see the later tombstone.
		const historical = fullProjection(entries, "e5");
		expect(historical.observations).toHaveLength(1);
	});
});

describe("renderer", () => {
	test("is empty without records", () => {
		const rendered = renderMemory([], []);
		expect(rendered.text).toBe("");
	});

	test("budgets newest records and reports omissions", () => {
		const observations = Array.from({ length: 20 }, (_, index) =>
			obs(
				(index + 1).toString(16).padStart(12, "0"),
				`observation number ${index} with enough text to consume tokens`,
			),
		);
		const rendered = renderMemory([], observations, { maxTokens: 400 });
		expect(rendered.text).toContain("omitted");
		expect(rendered.observations.length).toBeLessThan(observations.length);
		expect(rendered.observations.at(-1)?.content).toContain("19");
	});

	test("returns only the header when the budget fits no record", () => {
		const rendered = renderMemory([], [obs("aaaaaaaaaaaa", "x".repeat(500))], { maxTokens: 50 });
		expect(rendered.text).toBe("");
		expect(rendered.omittedObservations).toBe(1);
	});

	test("does not describe a skipped newest record as older", () => {
		const observations = [
			obs("000000000001", "short one"),
			obs("000000000002", "short two"),
			obs("000000000003", "short three"),
			obs("000000000004", "z".repeat(2_000)),
		];
		const rendered = renderMemory([], observations, { maxTokens: 260 });
		expect(rendered.omittedObservations).toBeGreaterThan(0);
		expect(rendered.text).toContain("omitted");
		expect(rendered.text).not.toContain("older");
	});
});

describe("source serialization and chunking", () => {
	test("labels every source entry", () => {
		const serialized = serializeSourceEntries([messageEntry("e1", "user", "hello")]);
		expect(serialized.text).toContain("[Source entry id: e1]");
		expect(serialized.sourceEntryIds).toEqual(["e1"]);
	});

	test("never cuts between a tool call and its result", () => {
		const call: LedgerEntry = {
			type: "message",
			id: "e2",
			message: {
				role: "assistant",
				content: [makeToolCall("bash", { command: "pwd" })],
				timestamp: Date.now(),
			},
			timestamp: new Date().toISOString(),
		};
		const result: LedgerEntry = {
			type: "message",
			id: "e3",
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-1",
				content: [{ type: "text", text: "/tmp" }],
				isError: false,
				timestamp: Date.now(),
			},
			timestamp: new Date().toISOString(),
		};
		const entries = [messageEntry("e1", "user", "run pwd"), call, result, messageEntry("e4", "user", "next")];
		const chunk = chunkUnobservedEntries(entries, "e1", 1, estimateTextTokens);
		expect(chunk?.sourceEntryIds).toContain("e2");
		expect(chunk?.sourceEntryIds).toContain("e3");
		expect(chunk?.coversUpToId).toBe("e3");
	});

	test("caps entries per chunk and still advances a long tool-result run", () => {
		const call: LedgerEntry = {
			type: "message",
			id: "c0",
			message: {
				role: "assistant",
				content: [makeToolCall("bash", { command: "for i in $(seq 500); do echo $i; done" })],
				timestamp: Date.now(),
			},
		};
		const results = Array.from({ length: 500 }, (_, index): LedgerEntry => ({
			type: "message",
			id: `r${index}`,
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-1",
				content: [{ type: "text", text: `result ${index} ${"x".repeat(200)}` }],
			},
		}));
		const entries = [call, ...results];
		const first = chunkUnobservedEntries(entries, "c0", 12_000);
		expect(first).toBeDefined();
		expect(first!.sourceEntryIds.length).toBeLessThan(500);
		const second = chunkUnobservedEntries(entries, first!.coversUpToId, 12_000);
		expect(second).toBeDefined();
		expect(second!.sourceEntryIds.some((id) => first!.sourceEntryIds.includes(id))).toBe(false);
	});

	test("per-entry truncation keeps a prompt bounded", () => {
		const serialized = serializeSourceEntries([messageEntry("e1", "user", "x".repeat(5_000))], {
			perEntryMaxChars: 32,
		});
		expect(serialized.text).toContain("truncated");
		expect(serialized.text.length).toBeLessThan(500);
		expect(serialized.truncatedSourceEntryIds).toEqual(["e1"]);
	});

	test("starts after an already-covered tool result instead of looping", () => {
		const call: LedgerEntry = {
			type: "message",
			id: "e1",
			message: {
				role: "assistant",
				content: [makeToolCall("bash", { command: "pwd" })],
				timestamp: Date.now(),
			},
		};
		const first: LedgerEntry = {
			type: "message",
			id: "e2",
			message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text: "a" }] },
		};
		const second: LedgerEntry = {
			type: "message",
			id: "e3",
			message: { role: "toolResult", toolName: "bash", toolCallId: "call-2", content: [{ type: "text", text: "b" }] },
		};
		const entries = [call, first, second, messageEntry("e4", "user", "next")];
		const chunk = chunkUnobservedEntries(entries, "e2", 10_000);
		expect(chunk?.sourceEntryIds).toEqual(["e3", "e4"]);
		expect(chunk?.coversUpToId).toBe("e4");
	});

	test("never claims coverage for a tool pair entry dropped from the prompt", () => {
		const huge = "A".repeat(5_000);
		const call: LedgerEntry = {
			type: "message",
			id: "e2",
			message: {
				role: "assistant",
				content: [makeToolCall("bash", { command: huge })],
				timestamp: Date.now(),
			},
		};
		const result: LedgerEntry = {
			type: "message",
			id: "e3",
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-1",
				content: [{ type: "text", text: huge }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const entries = [messageEntry("e1", "user", "run it"), call, result, messageEntry("e4", "user", "next")];
		const chunk = chunkUnobservedEntries(entries, "e1", 100, estimateTextTokens);
		expect(chunk).toBeDefined();
		expect(chunk!.sourceEntryIds).toContain("e3");
		expect(chunk!.text).toContain("[Source entry id: e3]");
		expect(chunk!.coversUpToId).toBe(chunk!.sourceEntryIds.at(-1)!);
		expect(chunk!.truncatedSourceEntryIds).toContain("e2");
	});
});

describe("recall", () => {
	test("returns an observation and its source evidence", () => {
		const observation = obs("aaaaaaaaaaaa", "User greeted the assistant.");
		const entries = [messageEntry("e1", "user", "hello"), recorded("e2", [observation], "e1")];
		const result = recallMemory(entries, observation.id);
		expect(result.found).toBe(true);
		expect(result.kind).toBe("observation");
		expect(result.text).toContain("hello");
		expect(result.sourceEntryIds).toEqual(["e1"]);
	});

	test("reports missing ids without throwing", () => {
		const result = recallMemory([], "aaaaaaaaaaaa");
		expect(result.found).toBe(false);
		expect(result.text).toContain("No memory record");
	});

	test("truncates one oversized source entry to the recall budget", () => {
		const observation = obs("aaaaaaaaaaaa", "User pasted a large log.");
		const entries = [
			messageEntry("e1", "user", "x".repeat(20_000)),
			recorded("e2", [observation], "e1"),
		];
		const result = recallMemory(entries, observation.id, { maxSourceTokens: 200 });
		expect(result.found).toBe(true);
		expect(result.text).toContain("truncated to fit the input budget");
		expect(result.text).not.toContain("x".repeat(20_000));
		expect(estimateTextTokens(result.text)).toBeLessThan(1_000);
	});

	test("reports source entries omitted by the recall budget", () => {
		const observation = obs("aaaaaaaaaaaa", "User cited two logs.", ["e1", "e2"]);
		const entries = [
			messageEntry("e1", "user", "a".repeat(300)),
			messageEntry("e2", "assistant", "b".repeat(300)),
			recorded("e3", [observation], "e2"),
		];
		const result = recallMemory(entries, observation.id, { maxSourceTokens: 100 });
		expect(result.sourceEntryIds).toEqual(["e1"]);
		expect(result.omittedSourceEntryIds).toEqual(["e2"]);
	});
});

describe("branch and resume locality", () => {
	test("ledger records do not leak across branches", () => {
		const branchA = [
			messageEntry("e1", "user", "branch A"),
			messageEntry("e2", "assistant", "A"),
			recorded("e3", [obs("aaaaaaaaaaaa", "branch A fact")], "e2"),
		];
		const branchB = [
			messageEntry("e1", "user", "branch A"),
			messageEntry("e4", "assistant", "B"),
		];
		expect(fullProjection(branchA).observations).toHaveLength(1);
		expect(fullProjection(branchB).observations).toHaveLength(0);
	});

	test("a missing boundary never folds the whole branch", () => {
		const entries = [
			messageEntry("e1", "user", "hello"),
			recorded("e2", [obs("aaaaaaaaaaaa", "fact")], "e1"),
		];
		expect(fullProjection(entries, "missing").observations).toHaveLength(0);
	});
});

describe("attachments", () => {
	test("image bytes are never serialized; metadata is opt-in", () => {
		const entry: LedgerEntry = {
			type: "message",
			id: "e1",
			message: {
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: "BASE64DATA" }],
				timestamp: Date.now(),
			},
		};
		expect(serializeSourceEntries([entry]).text).toContain("[image omitted]");
		expect(serializeSourceEntries([entry], { observeAttachments: true }).text).toContain("[image: image/png]");
		expect(serializeSourceEntries([entry], { observeAttachments: true }).text).not.toContain("BASE64DATA");
	});
});

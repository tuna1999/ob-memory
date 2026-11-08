import { describe, expect, test } from "bun:test";
import type { SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../src/constants";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { foldLedger, fullProjection, latestCoverageId } from "../src/ledger/fold";
import { recallMemory } from "../src/ledger/recall";
import { chunkUnobservedEntries } from "../src/ledger/serialize";
import {
	buildObservationCoverageData,
	buildObservationsRecordedData,
	isObservationsRecordedData,
	type LedgerEntry,
	type Observation,
} from "../src/ledger/types";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { consolidate, observeChunk, shouldObserve } from "../src/workers/trigger";
import {
	makeAssistant,
	makeHarness,
	makeModel,
	makeToolCall,
	messageEntry,
	observationEntry,
	text,
} from "./helpers";

const resolved: ResolvedWorkerModel = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low",
	maxTokens: 4096,
	label: "test/test-model",
	fallbackUsed: false,
};

const RECORDED = "ob-memory.observations.recorded";

function observation(id: string, sourceEntryIds: string[], content = "User chose Postgres for the project database."): Observation {
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "high",
		sourceEntryIds,
		tokenCount: estimateTextTokens(content),
	};
}

function coverageEntry(id: string, coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: RECORDED,
		timestamp: "2026-10-29T10:00:00.000Z",
		data: buildObservationCoverageData(coversUpToId, "empty"),
	};
}

function sequence(scripts: Array<ReturnType<typeof makeAssistant>>): typeof completeSimple {
	let index = 0;
	return (async () => scripts[Math.min(index++, scripts.length - 1)]!) as unknown as typeof completeSimple;
}

const rejectedProposal = makeAssistant(
	[
		makeToolCall("record_observations", {
			observations: [
				{ timestamp: "bad", content: "User chose Postgres for the project database.", relevance: "high", sourceEntryIds: ["u1"] },
			],
		}),
	],
	"toolUse",
);

describe("coverage-only observation records", () => {
	test("the guard accepts an empty observation list and the builder keeps the coverage id", () => {
		const data = buildObservationCoverageData("e1", "empty");
		expect(isObservationsRecordedData(data)).toBe(true);
		expect(data).toMatchObject({ observations: [], coversUpToId: "e1", coverageReason: "empty" });
		expect(buildObservationCoverageData("", "empty")).toBeUndefined();
		// The regular builder still refuses an empty list.
		expect(buildObservationsRecordedData([], "e1")).toBeUndefined();
	});

	test("readers advance coverage but add no memory", () => {
		const obs = observation("aaaaaaaaaaaa", ["e1"]);
		const entries: LedgerEntry[] = [
			messageEntry("e1", "user", "Please use Postgres for this project."),
			observationEntry("o1", [obs], "e1"),
			messageEntry("e2", "user", "Routine status."),
			coverageEntry("o2", "e2"),
			messageEntry("e3", "user", "Unobserved."),
		];
		expect(latestCoverageId(entries, RECORDED)).toBe("e2");
		expect(foldLedger(entries).observations).toEqual([obs]);
		expect(fullProjection(entries).observations).toEqual([obs]);
		expect(recallMemory(entries, obs.id).found).toBe(true);
		const chunk = chunkUnobservedEntries(entries, latestCoverageId(entries, RECORDED), 10_000);
		expect(chunk?.sourceEntryIds).toEqual(["e3"]);
	});

	test("a clean empty catch-up chunk lets compaction own the cut", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionMaxRetainedTokens: 0 });
		entries.push(
			messageEntry("e1", "user", "Please use Postgres for this project."),
			messageEntry("e2", "assistant", "Understood."),
			observationEntry("e3", [observation("aaaaaaaaaaaa", ["e1"])], "e2"),
			messageEntry("e4", "user", "Thanks, routine check-in."),
			messageEntry("e5", "assistant", "Nothing else to do."),
			messageEntry("e6", "user", "Keep this tail."),
		);
		const event = {
			type: "session_before_compact",
			branchEntries: [...entries],
			preparation: {
				firstKeptEntryId: "e6",
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
		const result = await handleSessionBeforeCompact(runtime, event, ctx, {
			complete: sequence([makeAssistant([text("Nothing new in this chunk.")])]),
		});
		expect(result?.compaction?.firstKeptEntryId).toBe("e6");
		expect(result?.compaction?.summary).toContain("Postgres");
	});
});

describe("observer partial results", () => {
	test("keeps accepted observations when a later turn errors, covering only cited ids", async () => {
		const { runtime, entries } = makeHarness({ redactSecrets: false });
		entries.push(messageEntry("e1", "user", "Please use Postgres."), messageEntry("e2", "assistant", "Noted."));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		const records = await observeChunk(
			runtime,
			entries,
			resolved,
			chunk!,
			new AbortController().signal,
			sequence([
				makeAssistant(
					[
						makeToolCall("record_observations", {
							observations: [
								{ timestamp: "2026-10-29 10:00", content: "User chose Postgres.", relevance: "high", sourceEntryIds: ["e1"] },
							],
						}),
					],
					"toolUse",
				),
				makeAssistant([text("")], "error", "overloaded"),
			]),
		);
		expect(records).toHaveLength(1);
		const record = entries.find((entry) => entry.customType === RECORDED);
		expect((record?.data as { coversUpToId: string }).coversUpToId).toBe("e1");
	});

	test("still fails when the first turn errors before anything is accepted", async () => {
		const { runtime, entries } = makeHarness({ redactSecrets: false });
		entries.push(messageEntry("e1", "user", "Please use Postgres."));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		await expect(
			observeChunk(runtime, entries, resolved, chunk!, new AbortController().signal, sequence([
				makeAssistant([text("")], "error", "overloaded"),
			])),
		).rejects.toThrow("overloaded");
		expect(entries.some((entry) => entry.customType === RECORDED)).toBe(false);
	});
});

describe("branch-local worker state", () => {
	test("an empty-run backoff from another tree path does not suppress the observer", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 6_000,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("root", "user", "Start."));
		entries.push(messageEntry("u1", "user", "x".repeat(40_000)));
		await consolidate(runtime, "test", { force: true, complete: sequence([rejectedProposal, makeAssistant([text("done")])]) });
		expect(runtime.emptyBackoff).toBeDefined();
		expect(latestCoverageId(entries, RECORDED)).toBeUndefined();

		// `/tree` back to the root and continue in a new direction (same session, same runtime).
		entries.length = 1;
		entries.push(messageEntry("b1", "user", "y".repeat(32_000)));
		expect(shouldObserve(entries, runtime)).toBe(true);
	});

	test("the empty-run backoff still applies on the path that produced it", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 6_000,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("u1", "user", "x".repeat(40_000)));
		await consolidate(runtime, "test", { force: true, complete: sequence([rejectedProposal, makeAssistant([text("done")])]) });
		entries.push(messageEntry("u2", "user", "small follow-up"));
		expect(shouldObserve(entries, runtime)).toBe(false);
	});

	test("a reflection gate from another tree path does not block the reflector", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1_000_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres."));
		entries.push(observationEntry("e2", [observation("aaaaaaaaaaaa", ["e1"])], "e1"));
		entries.push(messageEntry("a3", "user", "Path A continues."));
		let calls = 0;
		const complete = (async () => {
			calls++;
			return makeAssistant([text("nothing durable")]);
		}) as unknown as typeof completeSimple;
		await consolidate(runtime, "agent_end", { complete });
		expect(calls).toBe(1);
		await consolidate(runtime, "agent_end", { complete });
		expect(calls).toBe(1);

		entries.length = 2;
		entries.push(messageEntry("b3", "user", "Path B continues."));
		await consolidate(runtime, "agent_end", { complete });
		expect(calls).toBe(2);
	});
});

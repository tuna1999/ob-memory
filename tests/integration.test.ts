import { describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../src/constants";
import { foldLedger, latestCoverageId } from "../src/ledger/fold";
import type { Observation } from "../src/ledger/types";
import {
	OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS,
	cancelScheduledConsolidation,
	consolidate,
	rawTokensSinceCoverage,
} from "../src/workers/trigger";
import { makeAssistant, makeHarness, makeToolCall, messageEntry, observationEntry, scriptedComplete, text } from "./helpers";

function observation(): Observation {
	const content = "User chose Postgres for the project database.";
	return {
		id: "aaaaaaaaaaaa",
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "medium",
		sourceEntryIds: ["e1"],
		tokenCount: estimateTextTokens(content),
	};
}

describe("consolidation pipeline", () => {
	test("observes an unobserved chunk and advances coverage once", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		const call = makeAssistant(
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
		const result = await consolidate(runtime, "test", {
			force: true,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(result.observed).toBe(1);
		const record = entries.find((entry) => entry.customType === "ob-memory.observations.recorded");
		expect(record).toBeDefined();
		expect((record?.data as { coversUpToId: string }).coversUpToId).toBe("e1");

		const second = await consolidate(runtime, "test");
		expect(second.observed).toBe(0);
	});

	test("a clean empty observer run advances coverage without adding memory", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Routine hello."));
		const result = await consolidate(runtime, "test", {
			force: true,
			complete: scriptedComplete([makeAssistant([text("nothing new")])]),
		});
		expect(result.observed).toBe(0);
		const records = entries.filter((entry) => entry.customType === "ob-memory.observations.recorded");
		expect(records).toHaveLength(1);
		expect(records[0]?.data).toMatchObject({ observations: [], coversUpToId: "e1", coverageReason: "empty" });
		expect(latestCoverageId(entries, "ob-memory.observations.recorded")).toBe("e1");
		expect(foldLedger(entries).observations).toHaveLength(0);
	});

	test("an empty run with rejected proposals retries, then skips the chunk at the retry limit", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		const invalid = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29T10:00",
							content: "User chose Postgres for the project database.",
							relevance: "high",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		const attempt = () =>
			consolidate(runtime, "test", { force: true, complete: scriptedComplete([invalid, makeAssistant([text("done")])]) });
		const coverage = () => latestCoverageId(entries, "ob-memory.observations.recorded");
		for (let i = 1; i < OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS; i++) {
			await attempt();
			expect(coverage()).toBeUndefined();
		}
		await attempt();
		expect(coverage()).toBe("e1");
		const record = entries.find((entry) => entry.customType === "ob-memory.observations.recorded");
		expect(record?.data).toMatchObject({ observations: [], coverageReason: "retry_limit" });
	});

	test("an observer that declines a full chunk still reaches newer content", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			observerChunkMaxTokens: 300,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		for (let i = 1; i <= 12; i++) entries.push(messageEntry(`m${i}`, "user", `Routine status update number ${i}, nothing changed.`));
		entries.push(messageEntry("p1", "user", "User decided to use Postgres for the ledger store."));
		const prompts: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
			const content = context.messages[0]?.content;
			const prompt = typeof content === "string" ? content : "";
			prompts.push(prompt);
			const chunk = prompt.split("NEW CONVERSATION CHUNK:").at(-1) ?? "";
			if (!chunk.includes("[Source entry id: p1]") || context.messages.length > 1) return makeAssistant([text("Nothing new.")]);
			return makeAssistant(
				[makeToolCall("record_observations", { observations: [{ timestamp: "2026-10-29 10:00", content: "User decided to use Postgres for the ledger store.", relevance: "high", sourceEntryIds: ["p1"] }] })],
				"toolUse",
			);
		}) as unknown as typeof completeSimple;
		for (let round = 0; round < 6 && foldLedger(entries).observations.length === 0; round++) {
			await consolidate(runtime, "test", { force: true, complete });
		}
		expect(foldLedger(entries).observations.map((item) => item.content)).toContain(
			"User decided to use Postgres for the ledger store.",
		);
		expect(latestCoverageId(entries, "ob-memory.observations.recorded")).toBe("p1");
		cancelScheduledConsolidation(runtime);
	});

	test("drops when the reflection pass finds nothing new", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 100_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1,
			observationsPoolTargetTokens: 1,
			redactSecrets: false,
		});
		const obs = observation();
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [obs], "e1"));
		const dropCall = makeAssistant([makeToolCall("drop_observations", { ids: [obs.id] })], "toolUse");
		const result = await consolidate(runtime, "test", {
			complete: scriptedComplete([
				makeAssistant([text("nothing durable")]),
				dropCall,
				makeAssistant([text("done")]),
			]),
		});
		expect(result.reflected).toBe(0);
		expect(result.dropped).toBe(1);
	});

	test("reflects and then drops only after a successful reflection pass", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 100_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1,
			observationsPoolTargetTokens: 1,
			redactSecrets: false,
		});
		const obs = observation();
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [obs], "e1"));

		const reflectCall = makeAssistant(
			[
				makeToolCall("record_reflections", {
					reflections: [
						{
							content: "User chose Postgres for the project database.",
							supportingObservationIds: [obs.id],
						},
					],
				}),
			],
			"toolUse",
		);
		const reflectDone = makeAssistant([text("done")]);
		const dropCall = makeAssistant([makeToolCall("drop_observations", { ids: [obs.id] })], "toolUse");
		const dropDone = makeAssistant([text("done")]);

		const result = await consolidate(runtime, "test", {
			complete: scriptedComplete([reflectCall, reflectDone, dropCall, dropDone]),
		});
		expect(result.reflected).toBe(1);
		expect(result.dropped).toBe(1);
		expect(entries.some((entry) => entry.customType === "ob-memory.reflections.recorded")).toBe(true);
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.dropped")).toBe(true);
	});
});

describe("worker backoff", () => {
	test("an empty reflection run is not retried over the same pool", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 100_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		const obs = observation();
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [obs], "e1"));
		let calls = 0;
		const complete = (async () => {
			calls++;
			return makeAssistant([text("nothing durable")]);
		}) as unknown as typeof import("@oh-my-pi/pi-ai").completeSimple;

		const first = await consolidate(runtime, "test", { complete });
		expect(first.reflected).toBe(0);
		expect(calls).toBe(1);
		const second = await consolidate(runtime, "test", { complete });
		expect(second.reflected).toBe(0);
		expect(calls).toBe(1);
	});

	test("a productive reflection pass is not repeated over an unchanged pool", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 100_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		const obs = observation();
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [obs], "e1"));
		let reflectorCalls = 0;
		let wording = 0;
		const complete = (async (_model: unknown, context: { messages: unknown[] }) => {
			if (context.messages.length > 1) return makeAssistant([text("done")]);
			reflectorCalls++;
			wording++;
			return makeAssistant(
				[
					makeToolCall("record_reflections", {
						reflections: [{ content: `The project database is Postgres (wording ${wording}).`, supportingObservationIds: [obs.id] }],
					}),
				],
				"toolUse",
			);
		}) as unknown as typeof completeSimple;

		const results = [];
		for (let i = 0; i < 4; i++) results.push(await consolidate(runtime, "agent_end", { complete }));
		expect(reflectorCalls).toBe(1);
		expect(results.map((result) => result.reflected)).toEqual([1, 0, 0, 0]);
		expect(entries.filter((entry) => entry.customType === "ob-memory.reflections.recorded")).toHaveLength(1);
	});

	test("the reflection gate reopens once enough new observation tokens are recorded", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 100_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [observation()], "e1"));
		let reflectorCalls = 0;
		const complete = (async () => {
			reflectorCalls++;
			return makeAssistant([text("nothing durable")]);
		}) as unknown as typeof completeSimple;
		await consolidate(runtime, "agent_end", { complete });
		expect(reflectorCalls).toBe(1);

		const content = `User described the deployment pipeline in detail: ${"stage ".repeat(800)}`.trim();
		entries.push(messageEntry("e3", "user", "Long deployment notes."));
		entries.push(
			observationEntry(
				"e4",
				[{ ...observation(), id: "bbbbbbbbbbbb", content, sourceEntryIds: ["e3"], tokenCount: estimateTextTokens(content) }],
				"e3",
			),
		);
		await consolidate(runtime, "agent_end", { complete });
		expect(reflectorCalls).toBe(2);
	});
});

describe("passive mode", () => {
	test("manual observe-now bypasses passive but automatic runs do not", async () => {
		const { runtime, entries } = makeHarness({
			passive: true,
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Please use Postgres."));
		const call = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User chose Postgres for the database.",
							relevance: "high",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		const manual = await consolidate(runtime, "manual", {
			force: true,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(manual.observed).toBe(1);
		const automatic = await consolidate(runtime, "agent_end");
		expect(automatic.skipped).toBe("passive");
	});
});

describe("trigger accounting", () => {
	test("counts unobserved source that precedes a later compaction", () => {
		const { runtime, entries } = makeHarness();
		entries.push(messageEntry("e1", "user", "observed"));
		entries.push(observationEntry("e2", [observation()], "e1"));
		entries.push(messageEntry("e3", "user", "unobserved gap before compaction"));
		entries.push({
			type: "compaction",
			id: "e4",
			timestamp: new Date().toISOString(),
			summary: "native summary",
			firstKeptEntryId: "e3",
		});
		expect(rawTokensSinceCoverage(entries, runtime)).toBeGreaterThan(0);
	});
});

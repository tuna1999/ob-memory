import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "../src/constants";
import type { Observation } from "../src/ledger/types";
import { consolidate } from "../src/workers/trigger";
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

	test("an empty observer run does not advance coverage", async () => {
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
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.recorded")).toBe(false);
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

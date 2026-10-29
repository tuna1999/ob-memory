import { describe, expect, test } from "bun:test";
import type { Observation } from "../src/ledger/types";
import { runDropper } from "../src/workers/dropper";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { runObserver } from "../src/workers/observer";
import { runReflector } from "../src/workers/reflector";
import { estimateTextTokens } from "../src/constants";
import { makeAssistant, makeHarness, makeModel, makeToolCall, scriptedComplete, text } from "./helpers";

const resolved: ResolvedWorkerModel = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low",
	maxTokens: 4096,
	label: "test/test-model",
	fallbackUsed: false,
};

function observation(id: string, content = "User stated the project uses Postgres."): Observation {
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "medium",
		sourceEntryIds: ["e1"],
		tokenCount: estimateTextTokens(content),
	};
}

describe("observer", () => {
	test("accepts a valid observation and rejects invented source ids", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const call = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User stated the project uses Postgres.",
							relevance: "high",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		const finish = makeAssistant([text("done")]);
		const records = await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: "[Source entry id: e1]\n[User @ 2026-10-29 10:00]: use postgres",
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, finish]),
		});
		expect(records).toHaveLength(1);
		expect(records?.[0]?.id).toMatch(/^[a-f0-9]{12}$/);
		expect(records?.[0]?.sourceEntryIds).toEqual(["e1"]);

		const badCall = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "Invented",
							relevance: "high",
							sourceEntryIds: ["invented"],
						},
					],
				}),
			],
			"toolUse",
		);
		const rejected = await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: "[Source entry id: e1]\n[User]: hi",
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete: scriptedComplete([badCall, finish]),
		});
		expect(rejected).toBeUndefined();
	});

	test("redacts credentials before storing an observation", async () => {
		const { runtime } = makeHarness({ redactSecrets: true });
		const call = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User pasted sk-abcdefghijklmnopqrstuvwx into the config.",
							relevance: "medium",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		const records = await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: "[Source entry id: e1]\n[User]: key",
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records?.[0]?.content).toContain("[REDACTED API KEY]");
		expect(records?.[0]?.content).not.toContain("sk-abcdef");
	});
});

describe("reflector", () => {
	test("accepts a durable reflection with valid support ids", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const obs = observation("aaaaaaaaaaaa");
		const call = makeAssistant(
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
		const records = await runReflector({
			runtime,
			resolved,
			reflections: [],
			observations: [obs],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records).toHaveLength(1);
		expect(records?.[0]?.supportingObservationIds).toEqual([obs.id]);
	});

	test("rejects support ids that are not active observations", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const call = makeAssistant(
			[
				makeToolCall("record_reflections", {
					reflections: [{ content: "Unsupported", supportingObservationIds: ["bbbbbbbbbbbb"] }],
				}),
			],
			"toolUse",
		);
		const records = await runReflector({
			runtime,
			resolved,
			reflections: [],
			observations: [observation("aaaaaaaaaaaa")],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records).toBeUndefined();
	});
});

describe("dropper", () => {
	test("never drops a critical observation", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const critical = { ...observation("aaaaaaaaaaaa"), relevance: "critical" as const };
		const medium = observation("bbbbbbbbbbbb");
		const call = makeAssistant(
			[makeToolCall("drop_observations", { ids: [critical.id, medium.id] })],
			"toolUse",
		);
		const ids = await runDropper({
			runtime,
			resolved,
			reflections: [],
			observations: [critical, medium],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(ids).toEqual([medium.id]);
	});
});

describe("content quality", () => {
	test("rejects placeholder reflections", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const obs = observation("aaaaaaaaaaaa");
		const call = makeAssistant(
			[makeToolCall("record_reflections", { reflections: [{ content: "placeholder", supportingObservationIds: [obs.id] }] })],
			"toolUse",
		);
		const records = await runReflector({
			runtime,
			resolved,
			reflections: [],
			observations: [obs],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records).toBeUndefined();
	});
});

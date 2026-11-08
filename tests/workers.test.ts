import { describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import type { Observation } from "../src/ledger/types";
import { runDropper } from "../src/workers/dropper";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { runObserver } from "../src/workers/observer";
import { runReflector } from "../src/workers/reflector";
import { consolidate, observeChunk } from "../src/workers/trigger";
import { chunkUnobservedEntries } from "../src/ledger/serialize";
import { estimateTextTokens } from "../src/constants";
import {
	makeAssistant,
	makeHarness,
	makeModel,
	makeToolCall,
	messageEntry,
	observationEntry,
	scriptedComplete,
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

function validProposal(sourceEntryId: string, content = "User chose Postgres for the project database.") {
	return { timestamp: "2026-10-29 10:00", content, relevance: "high", sourceEntryIds: [sourceEntryId] };
}

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

	test("collapses identical observations proposed in the same run", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const proposal = {
			timestamp: "2026-10-29 10:00",
			content: "User stated the project uses Postgres.",
			relevance: "high",
			sourceEntryIds: ["e1"],
		};
		const call = makeAssistant(
			[makeToolCall("record_observations", { observations: [proposal, proposal] })],
			"toolUse",
		);
		const records = await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: "[Source entry id: e1]\n[User @ 2026-10-29 10:00]: use postgres",
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records).toHaveLength(1);
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

describe("observer turn budget", () => {
	test("does not append observations when aborted after the model responds", async () => {
		const { runtime, entries } = makeHarness({ redactSecrets: false });
		entries.push(messageEntry("e1", "user", "first source"));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		const controller = new AbortController();
		const complete = (async () => {
			controller.abort();
			return makeAssistant([makeToolCall("record_observations", { observations: [] })], "toolUse");
		}) as typeof completeSimple;
		await expect(
			observeChunk(runtime, entries, resolved, chunk!, controller.signal, complete),
		).rejects.toThrow();
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.recorded")).toBe(false);
	});

	test("does not append a valid observation when aborted after the last turn responds", async () => {
		// One turn and a valid proposal: no later turn-start check can mask a
		// missing abort guard between the model response and the append.
		const { runtime, entries } = makeHarness({ agentMaxTurns: 1, redactSecrets: false });
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		const controller = new AbortController();
		const complete = (async () => {
			controller.abort();
			return makeAssistant([makeToolCall("record_observations", { observations: [validProposal("e1")] })], "toolUse");
		}) as typeof completeSimple;
		await expect(
			observeChunk(runtime, entries, resolved, chunk!, controller.signal, complete),
		).rejects.toThrow();
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.recorded")).toBe(false);
	});

	test("does not append reflections when the pass is aborted after the reflector responds", async () => {
		const { runtime, entries } = makeHarness({
			agentMaxTurns: 1,
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1_000_000,
			redactSecrets: false,
		});
		const obs = observation("aaaaaaaaaaaa");
		entries.push(messageEntry("e1", "user", "Please use Postgres for this project."));
		entries.push(observationEntry("e2", [obs], "e1"));
		const complete = (async () => {
			runtime.abort("test");
			return makeAssistant(
				[
					makeToolCall("record_reflections", {
						reflections: [{ content: "The project database is Postgres.", supportingObservationIds: [obs.id] }],
					}),
				],
				"toolUse",
			);
		}) as unknown as typeof completeSimple;
		const result = await consolidate(runtime, "test", { complete });
		expect(result.reflected).toBe(0);
		expect(result.skipped).toBe("aborted");
		expect(entries.some((entry) => entry.customType === "ob-memory.reflections.recorded")).toBe(false);
	});

	test("does not append drops when the pass is aborted after the dropper responds", async () => {
		const { runtime, entries } = makeHarness({
			agentMaxTurns: 1,
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1,
			observationsPoolTargetTokens: 1,
			redactSecrets: false,
		});
		const low = { ...observation("aaaaaaaaaaaa", "User mentioned the office coffee machine."), relevance: "low" as const };
		entries.push(messageEntry("e1", "user", "Coffee chat."));
		entries.push(observationEntry("e2", [low], "e1"));
		let calls = 0;
		const complete = (async () => {
			calls++;
			// Reflector: nothing durable. Dropper: proposes the low record, then the pass aborts.
			if (calls === 1) return makeAssistant([text("nothing durable")]);
			runtime.abort("test");
			return makeAssistant([makeToolCall("drop_observations", { ids: [low.id] })], "toolUse");
		}) as unknown as typeof completeSimple;
		const result = await consolidate(runtime, "test", { complete });
		expect(calls).toBe(2);
		expect(result.dropped).toBe(0);
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.dropped")).toBe(false);
	});

	test("does not claim coverage past the last cited source entry", async () => {
		const { runtime, entries } = makeHarness({ agentMaxTurns: 1, redactSecrets: false });
		entries.push(messageEntry("e1", "user", "first source"), messageEntry("e2", "assistant", "second source"));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		expect(chunk).toBeDefined();
		const call = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User supplied the first source.",
							relevance: "high",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"toolUse",
		);
		const records = await observeChunk(
			runtime,
			entries,
			resolved,
			chunk!,
			new AbortController().signal,
			scriptedComplete([call]),
		);
		expect(records).toHaveLength(1);
		const record = entries.find((entry) => entry.customType === "ob-memory.observations.recorded");
		expect((record?.data as { coversUpToId?: string } | undefined)?.coversUpToId).toBe("e1");
	});

	test("does not claim coverage past cited ids when output hits the length limit", async () => {
		const { runtime, entries } = makeHarness({ agentMaxTurns: 3, redactSecrets: false });
		entries.push(messageEntry("e1", "user", "first source"), messageEntry("e2", "assistant", "second source"));
		const chunk = chunkUnobservedEntries(entries, undefined, 10_000);
		expect(chunk).toBeDefined();
		const truncated = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User supplied the first source.",
							relevance: "high",
							sourceEntryIds: ["e1"],
						},
					],
				}),
			],
			"length",
		);
		const done = makeAssistant([text("done")], "stop");
		const records = await observeChunk(
			runtime,
			entries,
			resolved,
			chunk!,
			new AbortController().signal,
			scriptedComplete([truncated, done]),
		);
		expect(records).toHaveLength(1);
		const record = entries.find((entry) => entry.customType === "ob-memory.observations.recorded");
		expect((record?.data as { coversUpToId?: string } | undefined)?.coversUpToId).toBe("e1");
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

	test("collapses identical reflections proposed in the same run", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const obs = observation("aaaaaaaaaaaa");
		const proposal = {
			content: "User chose Postgres for the project database.",
			supportingObservationIds: [obs.id],
		};
		const call = makeAssistant(
			[makeToolCall("record_reflections", { reflections: [proposal, proposal] })],
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

	test("keeps observations in the worker context when reflections exceed the budget", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 600 });
		const reflections = Array.from({ length: 60 }, (_, index) => ({
			id: index.toString(16).padStart(12, "c"),
			content: `Reflection number ${index} about a durable project decision.`,
			supportingObservationIds: ["dddddddddddd"],
			tokenCount: 15,
		}));
		const obs = observation("aaaaaaaaaaaa", "User chose Postgres for the ledger store.");
		const call = makeAssistant(
			[
				makeToolCall("record_reflections", {
					reflections: [{ content: "The project stores its ledger in Postgres.", supportingObservationIds: [obs.id] }],
				}),
			],
			"toolUse",
		);
		const records = await runReflector({
			runtime,
			resolved,
			reflections,
			observations: [obs],
			signal: new AbortController().signal,
			complete: scriptedComplete([call, makeAssistant([text("done")])]),
		});
		expect(records?.[0]?.supportingObservationIds).toEqual([obs.id]);
	});

	test("rejects support ids omitted from the bounded worker context", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 1 });
		const obs = observation("aaaaaaaaaaaa");
		const call = makeAssistant(
			[
				makeToolCall("record_reflections", {
					reflections: [{ content: "Cites an observation it never received.", supportingObservationIds: [obs.id] }],
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

	test("bounds the prompt to workerMemoryMaxTokens and only allows listed ids", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 150 });
		const oldest = observation("aaaaaaaaaaaa", `${"a".repeat(400)}`);
		const newest = observation("bbbbbbbbbbbb", `${"b".repeat(400)}`);
		let prompt = "";
		const complete = (async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
			const content = context.messages[0]?.content;
			prompt = typeof content === "string" ? content : "";
			return makeAssistant([text("keep")]);
		}) as typeof completeSimple;
		const ids = await runDropper({
			runtime,
			resolved,
			reflections: [],
			observations: [oldest, newest],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(ids).toBeUndefined();
		expect(prompt).toContain(oldest.id);
		expect(prompt).not.toContain(newest.id);
		expect(prompt).toContain("1 observation omitted");
	});

	test("skips an oversized oldest observation instead of hiding every later one", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 150 });
		const oversized = observation("aaaaaaaaaaaa", "a".repeat(800));
		const small = observation("bbbbbbbbbbbb", "User mentioned the office coffee machine.");
		let prompt = "";
		const complete = (async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
			const content = context.messages[0]?.content;
			prompt = typeof content === "string" ? content : "";
			return makeAssistant([text("keep")]);
		}) as typeof completeSimple;
		await runDropper({
			runtime,
			resolved,
			reflections: [],
			observations: [oversized, small],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(prompt).not.toContain(oversized.id);
		expect(prompt).toContain(small.id);
	});

	test("reserves part of the worker budget for observations when reflections are large", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 600 });
		const reflections = Array.from({ length: 60 }, (_, index) => ({
			id: index.toString(16).padStart(12, "c"),
			content: `Reflection number ${index} about a durable project decision.`,
			supportingObservationIds: ["dddddddddddd"],
			tokenCount: 15,
		}));
		const low = { ...observation("aaaaaaaaaaaa", "User mentioned the office coffee machine."), relevance: "low" as const };
		let calls = 0;
		const complete = (async () => {
			calls++;
			return calls === 1
				? makeAssistant([makeToolCall("drop_observations", { ids: [low.id] })], "toolUse")
				: makeAssistant([text("done")]);
		}) as unknown as typeof completeSimple;
		const ids = await runDropper({
			runtime,
			resolved,
			reflections,
			observations: [low],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(ids).toEqual([low.id]);
	});

	test("drops over-budget uncovered records after an empty reflection pass, never high ones", async () => {
		const { runtime, entries } = makeHarness({
			redactSecrets: false,
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 1,
			observationsPoolTargetTokens: 1,
		});
		const low = { ...observation("aaaaaaaaaaaa", "User mentioned the office coffee machine."), relevance: "low" as const };
		const high = { ...observation("bbbbbbbbbbbb", "User chose Postgres for the ledger store."), relevance: "high" as const };
		entries.push(messageEntry("e1", "user", "Use Postgres."));
		entries.push(observationEntry("e2", [low, high], "e1"));
		const result = await consolidate(runtime, "test", {
			complete: scriptedComplete([
				// Reflector: nothing durable to reflect.
				makeAssistant([text("nothing to reflect")]),
				// Dropper: proposes both; only the uncovered low record is accepted.
				makeAssistant([makeToolCall("drop_observations", { ids: [low.id, high.id] })], "toolUse"),
				makeAssistant([text("done")]),
			]),
		});
		expect(result.reflected).toBe(0);
		expect(result.dropped).toBe(1);
		const drop = entries.find((entry) => entry.customType === "ob-memory.observations.dropped");
		expect((drop?.data as { observationIds: string[] }).observationIds).toEqual([low.id]);
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

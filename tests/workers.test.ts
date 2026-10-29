import { describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import type { Observation } from "../src/ledger/types";
import { runDropper } from "../src/workers/dropper";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { runObserver } from "../src/workers/observer";
import { runReflector } from "../src/workers/reflector";
import { observeChunk } from "../src/workers/trigger";
import { chunkUnobservedEntries } from "../src/ledger/serialize";
import { estimateTextTokens } from "../src/constants";
import { makeAssistant, makeHarness, makeModel, makeToolCall, messageEntry, scriptedComplete, text } from "./helpers";

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
		expect(prompt).toContain("1 newer observation omitted");
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

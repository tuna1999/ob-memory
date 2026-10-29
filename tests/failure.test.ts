import { describe, expect, test } from "bun:test";
import type { TJsonSchema } from "@oh-my-pi/pi-ai";
import { runWorkerLoop, WorkerModelError } from "../src/workers/loop";
import { consolidate } from "../src/workers/trigger";
import { makeAssistant, makeHarness, makeModel, makeToolCall, messageEntry, scriptedComplete, text } from "./helpers";

const resolved = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low" as const,
	maxTokens: 1024,
	label: "test/test-model",
	fallbackUsed: false,
};

describe("failure handling", () => {
	test("a provider error rejects the worker loop", async () => {
		const tool = {
			name: "record_observations",
			description: "test",
			parameters: { type: "object" } as TJsonSchema,
			execute: async () => ({ text: "ok" }),
		};
		await expect(
			runWorkerLoop({
				stage: "observer",
				model: resolved.model,
				auth: resolved.auth,
				thinking: resolved.thinking,
				maxTokens: 1024,
				maxTurns: 2,
				system: "system",
				user: "user",
				tool,
				signal: new AbortController().signal,
				complete: scriptedComplete([makeAssistant([text("")], "error", "provider down")]),
			}),
		).rejects.toBeInstanceOf(WorkerModelError);
	});

	test("an unknown tool call becomes an error result, not a crash", async () => {
		const tool = {
			name: "record_observations",
			description: "test",
			parameters: { type: "object" } as TJsonSchema,
			execute: async () => ({ text: "ok" }),
		};
		const result = await runWorkerLoop({
			stage: "observer",
			model: resolved.model,
			auth: resolved.auth,
			thinking: resolved.thinking,
			maxTokens: 1024,
			maxTurns: 3,
			system: "system",
			user: "user",
			tool,
			signal: new AbortController().signal,
			complete: scriptedComplete([
				makeAssistant([makeToolCall("unknown_tool", {})], "toolUse"),
				makeAssistant([text("done")]),
			]),
		});
		expect(result.records[0]?.isError).toBe(true);
		expect(result.finalText).toBe("done");
	});

	test("an append failure stops the pass without inventing coverage", async () => {
		const { runtime, entries, pi } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 100_000,
			observationsPoolMaxTokens: 100_000,
			redactSecrets: false,
		});
		entries.push(messageEntry("e1", "user", "Use Postgres."));
		(pi as unknown as { appendEntry: () => never }).appendEntry = () => {
			throw new Error("disk full");
		};
		const call = makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: "User chose Postgres.",
							relevance: "high",
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
		expect(result.observed).toBe(0);
		expect(entries.some((entry) => entry.customType === "ob-memory.observations.recorded")).toBe(false);
	});
});

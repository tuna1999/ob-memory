import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, completeSimple, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { DEFAULT_CONFIG } from "../src/config-types";
import { estimateTextTokens } from "../src/constants";
import type { Observation } from "../src/ledger/types";
import { SessionRuntime } from "../src/runtime";
import { runDropper } from "../src/workers/dropper";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { runObserver } from "../src/workers/observer";
import { runReflector } from "../src/workers/reflector";
import { makeAssistant, makeHarness, makeModel, makeToolCall, text } from "./helpers";

const resolved: ResolvedWorkerModel = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low",
	maxTokens: 4096,
	label: "test/test-model",
	fallbackUsed: false,
};

const CHUNK = "[Source entry id: e1]\n[User @ 2026-10-29 10:00]: use postgres";

function observation(id: string, content = "User stated the project uses Postgres.", relevance: Observation["relevance"] = "medium"): Observation {
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance,
		sourceEntryIds: ["e1"],
		tokenCount: estimateTextTokens(content),
	};
}

/** Replays `scripts` and keeps every tool result the worker loop sent back. */
function recording(scripts: AssistantMessage[]) {
	const toolResults: ToolResultMessage[] = [];
	let index = 0;
	const complete = (async (_model: unknown, context: { messages: Array<{ role: string }> }) => {
		const last = context.messages[context.messages.length - 1];
		if (last?.role === "toolResult") {
			const fresh = context.messages.filter((message) => message.role === "toolResult").slice(toolResults.length);
			toolResults.push(...(fresh as ToolResultMessage[]));
		}
		return scripts[Math.min(index++, scripts.length - 1)]!;
	}) as unknown as typeof completeSimple;
	return { complete, toolResults };
}

function resultText(message: ToolResultMessage | undefined): string {
	const block = message?.content[0];
	return block && block.type === "text" ? block.text : "";
}

function observerCall(observations: unknown[]): AssistantMessage {
	return makeAssistant([makeToolCall("record_observations", { observations })], "toolUse");
}

const valid = { timestamp: "2026-10-29 10:00", content: "User chose Postgres for the database.", relevance: "high", sourceEntryIds: ["e1"] };

describe("worker tool feedback", () => {
	test("observer results name each rejection reason and count only their own call", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const { complete, toolResults } = recording([
			observerCall([{ ...valid, timestamp: "2026-10-29T10:00" }]),
			observerCall([valid]),
			makeAssistant([text("done")]),
		]);
		const records = await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: CHUNK,
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete,
		});
		expect(records).toHaveLength(1);
		expect(toolResults).toHaveLength(2);
		expect(resultText(toolResults[0])).toContain("invalid timestamp; use YYYY-MM-DD HH:MM");
		expect(toolResults[0]?.isError).toBe(true);
		expect(resultText(toolResults[1])).not.toContain("rejected");
		expect(toolResults[1]?.isError).toBe(false);
	});

	test("a call whose arguments were cut off asks for smaller batches", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const truncated = makeAssistant(
			[makeToolCall("record_observations", { __parseError: "Unexpected end of JSON input", __rawJson: '{"observations":[{"times' })],
			"length",
		);
		const { complete, toolResults } = recording([truncated, makeAssistant([text("done")])]);
		await runObserver({
			runtime,
			resolved,
			reflections: [],
			observations: [],
			chunk: CHUNK,
			allowedSourceEntryIds: ["e1"],
			signal: new AbortController().signal,
			complete,
		});
		expect(resultText(toolResults[0])).toContain("cut off by the output token limit");
		expect(resultText(toolResults[0])).toContain("fewer");
		expect(toolResults[0]?.isError).toBe(true);
	});

	test("reflector results explain an unknown support id", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const obs = observation("aaaaaaaaaaaa");
		const { complete, toolResults } = recording([
			makeAssistant(
				[
					makeToolCall("record_reflections", {
						reflections: [{ content: "The project database is Postgres.", supportingObservationIds: [obs.id, "zzzzzzzzzzzz"] }],
					}),
				],
				"toolUse",
			),
			makeAssistant([text("done")]),
		]);
		await runReflector({ runtime, resolved, reflections: [], observations: [obs], signal: new AbortController().signal, complete });
		expect(resultText(toolResults[0])).toContain("supportingObservationIds");
		expect(toolResults[0]?.isError).toBe(true);
	});

	test("dropper results tell a protected record apart from an unknown id", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const critical = observation("aaaaaaaaaaaa", "User is the project owner.", "critical");
		const low = observation("bbbbbbbbbbbb", "User mentioned the office coffee machine.", "low");
		const { complete, toolResults } = recording([
			makeAssistant([makeToolCall("drop_observations", { ids: [critical.id, "cccccccccccc"] })], "toolUse"),
			makeAssistant([makeToolCall("drop_observations", { ids: [low.id] })], "toolUse"),
			makeAssistant([text("done")]),
		]);
		const ids = await runDropper({
			runtime,
			resolved,
			reflections: [],
			observations: [critical, low],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(ids).toEqual([low.id]);
		expect(resultText(toolResults[0])).toContain("critical observations are never dropped");
		expect(resultText(toolResults[0])).toContain("not an id listed");
		expect(toolResults[0]?.isError).toBe(true);
		expect(resultText(toolResults[1])).not.toContain("rejected");
	});
});

describe("partial results after a later provider error", () => {
	test("the reflector keeps reflections accepted before the error", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const obs = observation("aaaaaaaaaaaa");
		const { complete } = recording([
			makeAssistant(
				[
					makeToolCall("record_reflections", {
						reflections: [{ content: "The project database is Postgres.", supportingObservationIds: [obs.id] }],
					}),
				],
				"toolUse",
			),
			makeAssistant([text("")], "error", "overloaded"),
		]);
		const records = await runReflector({ runtime, resolved, reflections: [], observations: [obs], signal: new AbortController().signal, complete });
		expect(records).toHaveLength(1);
	});

	test("the dropper keeps drops validated before the error", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const low = observation("bbbbbbbbbbbb", "User mentioned the office coffee machine.", "low");
		const { complete } = recording([
			makeAssistant([makeToolCall("drop_observations", { ids: [low.id] })], "toolUse"),
			makeAssistant([text("")], "error", "overloaded"),
		]);
		const ids = await runDropper({
			runtime,
			resolved,
			reflections: [],
			observations: [low],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(ids).toEqual([low.id]);
	});

	test("an abort still discards accepted records", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const controller = new AbortController();
		let calls = 0;
		const complete = (async () => {
			calls++;
			if (calls === 1) return observerCall([valid]);
			controller.abort();
			return makeAssistant([text("")], "aborted");
		}) as unknown as typeof completeSimple;
		await expect(
			runObserver({
				runtime,
				resolved,
				reflections: [],
				observations: [],
				chunk: CHUNK,
				allowedSourceEntryIds: ["e1"],
				signal: controller.signal,
				complete,
			}),
		).rejects.toThrow();
	});
});

describe("observer usage logging", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	test("logs usage for every turn even when the run throws", async () => {
		dir = mkdtempSync(join(tmpdir(), "ob-memory-usage-"));
		const { pi, ctx } = makeHarness();
		const runtime = new SessionRuntime(pi, ctx, { ...DEFAULT_CONFIG, debugLog: true, redactSecrets: false }, dir);
		const first = observerCall([{ ...valid, timestamp: "bad" }]);
		first.usage = { ...first.usage, input: 12_345 };
		const failure = makeAssistant([text("")], "error", "overloaded");
		failure.usage = { ...failure.usage, input: 777 };
		const { complete } = recording([first, failure]);
		await expect(
			runObserver({
				runtime,
				resolved,
				reflections: [],
				observations: [],
				chunk: CHUNK,
				allowedSourceEntryIds: ["e1"],
				signal: new AbortController().signal,
				complete,
			}),
		).rejects.toThrow("overloaded");
		const lines = readFileSync(runtime.debug.path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { stage: string; event: string; usage?: { input?: number } });
		const usage = lines.filter((line) => line.stage === "observer" && line.event === "usage");
		expect(usage.map((line) => line.usage?.input)).toEqual([12_345, 777]);
	});
});

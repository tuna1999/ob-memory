import { afterEach, describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { latestCoverageId } from "../src/ledger/fold";
import type { SessionRuntime } from "../src/runtime";
import {
	consolidate,
	hasScheduledConsolidation,
	scheduleConsolidation,
} from "../src/workers/trigger";
import { makeAssistant, makeHarness, makeToolCall, messageEntry, text } from "./helpers";

const RECORDED = "ob-memory.observations.recorded";

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(20);
	}
	return condition();
}

/** Observer model that records one valid observation citing the first entry of each chunk. */
function citingObserver(): { complete: typeof completeSimple; calls: () => number } {
	let calls = 0;
	const complete = (async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
		if (context.messages.length > 1) return makeAssistant([text("done")]);
		calls++;
		const prompt = typeof context.messages[0]?.content === "string" ? context.messages[0].content : "";
		const chunk = prompt.split("NEW CONVERSATION CHUNK:").at(-1) ?? "";
		const id = /\[Source entry id: ([^\]]+)\]/.exec(chunk)?.[1] ?? "missing";
		return makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{ timestamp: "2026-10-29 10:00", content: `User discussed topic ${id} in detail.`, relevance: "medium", sourceEntryIds: [id] },
					],
				}),
			],
			"toolUse",
		);
	}) as unknown as typeof completeSimple;
	return { complete, calls: () => calls };
}

function backlogHarness(count: number) {
	const harness = makeHarness({
		observeAfterTokens: 1,
		observerChunkMaxTokens: 300,
		reflectAfterTokens: 1_000_000,
		observationsPoolMaxTokens: 1_000_000,
		redactSecrets: false,
	});
	for (let i = 1; i <= count; i++) harness.entries.push(messageEntry(`m${i}`, "user", `Topic ${i}: ${"detail ".repeat(140)}`));
	return harness;
}

let active: SessionRuntime | undefined;
afterEach(() => {
	active?.dispose("test");
	active = undefined;
});

describe("backlog drain", () => {
	test("follow-up passes drain a backlog larger than one chunk without new lifecycle events", async () => {
		const { runtime, entries } = backlogHarness(4);
		active = runtime;
		const observer = citingObserver();
		const first = await consolidate(runtime, "agent_end", { complete: observer.complete });
		expect(first.observed).toBe(1);
		expect(latestCoverageId(entries, RECORDED)).toBe("m1");
		expect(await waitFor(() => latestCoverageId(entries, RECORDED) === "m4")).toBe(true);
		expect(observer.calls()).toBe(4);
		expect(await waitFor(() => !hasScheduledConsolidation(runtime))).toBe(true);
	});

	test("a pass that makes no observer progress schedules no follow-up", async () => {
		const { runtime } = backlogHarness(4);
		active = runtime;
		const rejecting = (async () =>
			makeAssistant(
				[
					makeToolCall("record_observations", {
						observations: [{ timestamp: "bad", content: "User discussed a topic.", relevance: "medium", sourceEntryIds: ["m1"] }],
					}),
				],
				"toolUse",
			)) as unknown as typeof completeSimple;
		const result = await consolidate(runtime, "agent_end", { complete: rejecting });
		expect(result.observed).toBe(0);
		expect(hasScheduledConsolidation(runtime)).toBe(false);
	});

	test("a trigger that finds the lock busy leaves a retry scheduled", async () => {
		const { runtime, entries } = backlogHarness(1);
		active = runtime;
		const gate = Promise.withResolvers<void>();
		const holder = runtime.runExclusive("hold", () => gate.promise, { requireIdle: false });
		const observer = citingObserver();
		const result = await consolidate(runtime, "agent_end", { complete: observer.complete });
		expect(result.skipped).toBe("busy");
		expect(hasScheduledConsolidation(runtime)).toBe(true);
		gate.resolve();
		await holder;
		expect(await waitFor(() => latestCoverageId(entries, RECORDED) === "m1")).toBe(true);
	});

	test("an aborted pass is not retried behind the abort", async () => {
		const { runtime } = backlogHarness(1);
		active = runtime;
		const complete = (async () => {
			runtime.abort("agent_start");
			return makeAssistant([text("")], "aborted");
		}) as unknown as typeof completeSimple;
		const result = await consolidate(runtime, "agent_end", { complete });
		expect(result.skipped).toBe("aborted");
		expect(hasScheduledConsolidation(runtime)).toBe(false);
		expect(runtime.isFailureBackoffActive()).toBe(false);
	});
});

describe("scheduled consolidation errors", () => {
	test("a throw before the lock is recorded instead of escaping as an unhandled rejection", async () => {
		const { runtime } = backlogHarness(1);
		active = runtime;
		Object.assign(runtime.ctx.sessionManager, {
			getBranch: () => {
				throw new Error("branch read exploded");
			},
		});
		scheduleConsolidation(runtime, "agent_end", 0);
		expect(await waitFor(() => runtime.lastError !== undefined, 1_000)).toBe(true);
		expect(runtime.lastError?.message).toBe("branch read exploded");
	});
});

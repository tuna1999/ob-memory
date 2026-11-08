import { afterEach, describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../src/constants";
import { foldLedger, latestCoverageId, observationTokens } from "../src/ledger/fold";
import type { LedgerEntry, Observation } from "../src/ledger/types";
import type { SessionRuntime } from "../src/runtime";
import { isNothingNewReply } from "../src/workers/observer";
import { OBSERVER_SYSTEM } from "../src/workers/prompts";
import {
	OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS,
	cancelScheduledConsolidation,
	consolidate,
	DROPPER_MAX_FAILURES,
	shouldObserve,
} from "../src/workers/trigger";
import { makeAssistant, makeHarness, makeToolCall, messageEntry, observationEntry, text } from "./helpers";

// Host `/clear` appends a `reset_boundary` to the same session and emits no
// extension event, so the runtime and its gates survive it (host
// agent-session.ts resetSessionContext, session-manager.ts appendResetBoundary).

const RECORDED = "ob-memory.observations.recorded";

type Stage = "observer" | "reflector" | "dropper";

interface WorkerContext {
	systemPrompt: string[];
	messages: Array<{ content: unknown }>;
}

function stageOf(context: WorkerContext): Stage {
	const system = context.systemPrompt[0] ?? "";
	if (system.includes("reflection agent")) return "reflector";
	if (system.includes("dropper agent")) return "dropper";
	return "observer";
}

function resetBoundary(id: string): LedgerEntry {
	return { type: "reset_boundary", id, timestamp: "2026-10-29T10:30:00.000Z" };
}

function observation(id: string, sourceId: string, content: string, relevance: Observation["relevance"] = "medium"): Observation {
	return { id, content, timestamp: "2026-10-29 10:00", relevance, sourceEntryIds: [sourceId], tokenCount: estimateTextTokens(content) };
}

function hexId(prefix: string, n: number): string {
	return `${prefix}${n.toString(16).padStart(11, "0")}`;
}

/**
 * Append `count` source messages, each with one observation that covers it.
 * `idPrefix` is one hex digit so observation ids stay valid memory ids.
 */
function pushObserved(entries: LedgerEntry[], prefix: string, idPrefix: string, count: number): void {
	for (let n = 0; n < count; n++) {
		entries.push(messageEntry(`${prefix}${n}`, "user", `${prefix} message ${n}`));
		entries.push(
			observationEntry(
				`${prefix}o${n}`,
				[observation(hexId(idPrefix, n), `${prefix}${n}`, `User decided detail number ${n} about the storage layer and its migration plan ${"x".repeat(60)}`)],
				`${prefix}${n}`,
			),
		);
	}
}

/** Worker model that records stage calls and declines everything. */
function decliningWorkers(): { complete: typeof completeSimple; stages: Stage[] } {
	const stages: Stage[] = [];
	const complete = (async (_model: unknown, context: WorkerContext) => {
		if (context.messages.length === 1) stages.push(stageOf(context));
		return makeAssistant([text("Nothing new.")]);
	}) as unknown as typeof completeSimple;
	return { complete, stages };
}

const invalidProposal = (sourceId: string) =>
	makeAssistant(
		[
			makeToolCall("record_observations", {
				observations: [{ timestamp: "bad", content: "User discussed the storage layer.", relevance: "medium", sourceEntryIds: [sourceId] }],
			}),
		],
		"toolUse",
	);

/** Observer that proposes only invalid timestamps (an unproductive, non-clean run). */
function rejectingObserver(sourceId: string): { complete: typeof completeSimple; calls: () => number } {
	let calls = 0;
	const complete = (async (_model: unknown, context: WorkerContext) => {
		if (context.messages.length > 1) return makeAssistant([text("done")]);
		calls++;
		return invalidProposal(sourceId);
	}) as unknown as typeof completeSimple;
	return { complete, calls: () => calls };
}

function recordedEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
	return entries.filter((entry) => entry.customType === RECORDED);
}

let active: SessionRuntime | undefined;
afterEach(() => {
	if (active) {
		cancelScheduledConsolidation(active);
		active.dispose("test");
	}
	active = undefined;
});

describe("worker gates across /clear", () => {
	test("a reflection gate from before /clear does not block the reflector and dropper on the post-clear pool", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 10_000_000,
			reflectAfterTokens: 400, // gate threshold: max(1000, 200) = 1000
			observationsPoolMaxTokens: 800,
			observationsPoolTargetTokens: 500,
			redactSecrets: false,
		});
		active = runtime;
		pushObserved(entries, "p", "a", 120);
		const workers = decliningWorkers();
		await consolidate(runtime, "agent_end", { complete: workers.complete });
		expect(workers.stages).toEqual(["reflector", "dropper"]);
		expect(runtime.reflectionGate).toBeDefined();

		entries.push(resetBoundary("clear"));
		pushObserved(entries, "q", "b", 60);
		const postClear = observationTokens(foldLedger(entries).activeObservations);
		expect(postClear).toBeGreaterThan(1_000);
		// Smaller than the pre-clear total the gate recorded.
		expect(postClear).toBeLessThan(runtime.reflectionGate!.recordedTokens);

		const result = await consolidate(runtime, "agent_end", { complete: workers.complete });
		expect(result.skipped).toBeUndefined();
		expect(workers.stages).toEqual(["reflector", "dropper", "reflector", "dropper"]);
		expect(runtime.reflectionGate?.resetId).toBe("clear");

		// The gate set after /clear still gates the unchanged post-clear pool.
		const again = await consolidate(runtime, "agent_end", { complete: workers.complete });
		expect(again.skipped).toBe("below_threshold");
		expect(workers.stages).toHaveLength(4);
	});

	test("an empty-run backoff from before /clear does not suppress the observer afterwards", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 6_000,
			reflectAfterTokens: 1_000_000,
			observationsPoolMaxTokens: 1_000_000,
			redactSecrets: false,
		});
		active = runtime;
		entries.push(messageEntry("u1", "user", "x".repeat(40_000)));
		const rejecting = rejectingObserver("u1");
		await consolidate(runtime, "agent_end", { complete: rejecting.complete });
		expect(rejecting.calls()).toBe(1);
		expect(runtime.emptyBackoff).toBeDefined();
		expect(latestCoverageId(entries, RECORDED)).toBeUndefined();

		entries.push(resetBoundary("clear"));
		// Above observeAfterTokens, below the pre-clear progress plus the backoff threshold.
		entries.push(messageEntry("b1", "user", `Decision: the ledger store is Postgres 16. ${"y".repeat(32_000)}`));
		expect(shouldObserve(entries, runtime)).toBe(true);

		let observerCalls = 0;
		const recording = (async (_model: unknown, context: WorkerContext) => {
			if (context.messages.length > 1) return makeAssistant([text("done")]);
			observerCalls++;
			return makeAssistant(
				[
					makeToolCall("record_observations", {
						observations: [{ timestamp: "2026-10-29 10:00", content: "User decided the ledger store is Postgres 16.", relevance: "high", sourceEntryIds: ["b1"] }],
					}),
				],
				"toolUse",
			);
		}) as unknown as typeof completeSimple;
		const result = await consolidate(runtime, "agent_end", { complete: recording });
		expect(observerCalls).toBe(1);
		expect(result.observed).toBe(1);
		expect(latestCoverageId(entries, RECORDED)).toBe("b1");
	});
});

describe("worker gates and a /clear during a pass", () => {
	// The host does not abort extension work on `/clear` and its getBranch()
	// returns a fresh array, so a pass keeps the snapshot it read.
	function snapshotBranch(runtime: SessionRuntime, entries: LedgerEntry[]): void {
		(runtime.ctx.sessionManager as unknown as { getBranch: () => LedgerEntry[] }).getBranch = () => [...entries];
	}

	const reflection = () =>
		makeAssistant(
			[makeToolCall("record_reflections", { reflections: [{ content: "The storage layer migration plan has many numbered details.", supportingObservationIds: [hexId("a", 0)] }] })],
			"toolUse",
		);

	function gateHarness(observeAfterTokens: number) {
		const harness = makeHarness({
			observeAfterTokens,
			reflectAfterTokens: 400, // gate threshold: max(1000, 200) = 1000
			observationsPoolMaxTokens: 800,
			observationsPoolTargetTokens: 500,
			redactSecrets: false,
		});
		snapshotBranch(harness.runtime, harness.entries);
		pushObserved(harness.entries, "p", "a", 120);
		return harness;
	}

	async function expectPostClearPassReflects(runtime: SessionRuntime, entries: LedgerEntry[], complete: typeof completeSimple, stages: Stage[]) {
		pushObserved(entries, "q", "b", 60);
		const postClear = observationTokens(foldLedger(entries).activeObservations);
		expect(postClear).toBeGreaterThan(1_000);
		expect(postClear).toBeLessThan(runtime.reflectionGate!.recordedTokens);
		const before = stages.length;
		const result = await consolidate(runtime, "agent_end", { complete });
		expect(result.skipped).toBeUndefined();
		expect(stages.slice(before).filter((stage) => stage !== "observer")).toEqual(["reflector", "dropper"]);
		expect(runtime.reflectionGate?.resetId).toBe("clear");
	}

	test("a /clear during a productive reflector call does not gate the post-clear pool", async () => {
		const { runtime, entries } = gateHarness(10_000_000);
		active = runtime;
		const stages: Stage[] = [];
		let cleared = false;
		const complete = (async (_model: unknown, context: WorkerContext) => {
			if (context.messages.length > 1) return makeAssistant([text("done")]);
			const stage = stageOf(context);
			stages.push(stage);
			if (stage === "reflector" && !cleared) {
				cleared = true;
				entries.push(resetBoundary("clear"));
				return reflection();
			}
			return makeAssistant([text("Nothing new.")]);
		}) as unknown as typeof completeSimple;

		const first = await consolidate(runtime, "agent_end", { complete });
		expect(first.reflected).toBe(1);
		// The total was measured before the boundary, so the gate keeps the old one.
		expect(runtime.reflectionGate?.resetId).toBeUndefined();
		await expectPostClearPassReflects(runtime, entries, complete, stages);
	});

	test("a /clear during an unproductive observer call does not gate the post-clear pool", async () => {
		const { runtime, entries } = gateHarness(1);
		active = runtime;
		entries.push(messageEntry("u1", "user", "Unobserved tail the observer cannot handle."));
		const stages: Stage[] = [];
		let cleared = false;
		const complete = (async (_model: unknown, context: WorkerContext) => {
			if (context.messages.length > 1) return makeAssistant([text("done")]);
			const stage = stageOf(context);
			stages.push(stage);
			if (stage === "observer" && !cleared) {
				cleared = true;
				entries.push(resetBoundary("clear"));
				return invalidProposal("u1");
			}
			if (stage === "reflector") return reflection();
			return makeAssistant([text("Nothing new.")]);
		}) as unknown as typeof completeSimple;

		const first = await consolidate(runtime, "agent_end", { complete });
		// The pass reflected over its pre-clear snapshot.
		expect(stages.slice(0, 2)).toEqual(["observer", "reflector"]);
		expect(first.reflected).toBe(1);
		expect(runtime.reflectionGate?.resetId).toBeUndefined();
		await expectPostClearPassReflects(runtime, entries, complete, stages);
	});
});

describe("observer retry counter across /tree", () => {
	test("attempts made on another path sharing the chunk start do not count", async () => {
		const { runtime, entries } = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 1_000_000,
			observationsPoolMaxTokens: 1_000_000,
			redactSecrets: false,
		});
		active = runtime;
		entries.push(messageEntry("s1", "user", "Shared start of the conversation about the storage layer."));
		entries.push(messageEntry("a2", "user", "Path A: routine chatter."));
		const rejecting = rejectingObserver("s1");
		for (let i = 1; i < OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS; i++) {
			await consolidate(runtime, "manual", { force: true, complete: rejecting.complete });
		}
		expect(runtime.observerRetry).toMatchObject({ startId: "s1", attempts: OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS - 1 });

		// `/tree` back to s1 (same session, same runtime) and continue on path B.
		entries.length = 1;
		entries.push(messageEntry("b2", "user", "Decision: the ledger store is Postgres 16; never use SQLite."));
		await consolidate(runtime, "agent_end", { complete: rejecting.complete });
		expect(rejecting.calls()).toBe(OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS);
		expect(recordedEntries(entries)).toHaveLength(0);
		expect(runtime.observerRetry).toMatchObject({ startId: "s1", attempts: 1, tipId: "b2" });

		// The counter still reaches the limit on path B itself.
		for (let i = 1; i < OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS; i++) {
			await consolidate(runtime, "manual", { force: true, complete: rejecting.complete });
		}
		expect(recordedEntries(entries).at(-1)?.data).toMatchObject({ observations: [], coversUpToId: "b2", coverageReason: "retry_limit" });
	});
});

describe("incomplete dropper runs", () => {
	function overBudgetHarness() {
		const harness = makeHarness({
			observeAfterTokens: 10_000_000,
			reflectAfterTokens: 100,
			observationsPoolMaxTokens: 300,
			observationsPoolTargetTokens: 200,
			redactSecrets: false,
		});
		for (let i = 0; i < 20; i++) {
			harness.entries.push(messageEntry(`m${i}`, "user", `msg ${i}`));
			harness.entries.push(
				observationEntry(`o${i}`, [observation(hexId("a", i), `m${i}`, `User mentioned routine status item number ${i} about the build ${"x".repeat(40)}`, "low")], `m${i}`),
			);
		}
		return harness;
	}

	function workers(runtime: SessionRuntime, dropperFailure: () => "abort" | "error" | undefined) {
		const stages: Stage[] = [];
		const complete = (async (_model: unknown, context: WorkerContext) => {
			if (context.messages.length > 1) return makeAssistant([text("done")]);
			const stage = stageOf(context);
			stages.push(stage);
			if (stage === "reflector") {
				return makeAssistant(
					[makeToolCall("record_reflections", { reflections: [{ content: "The build emits many routine status messages.", supportingObservationIds: [hexId("a", 0)] }] })],
					"toolUse",
				);
			}
			if (stage === "dropper") {
				const failure = dropperFailure();
				if (failure === "abort") {
					runtime.abort("agent_start");
					return makeAssistant([text("")], "aborted");
				}
				if (failure === "error") return makeAssistant([text("")], "error", "overloaded");
				return makeAssistant([makeToolCall("drop_observations", { ids: [hexId("a", 1), hexId("a", 2)] })], "toolUse");
			}
			return makeAssistant([text("Nothing new.")]);
		}) as unknown as typeof completeSimple;
		return { complete, stages };
	}

	test("an aborted dropper is retried alone on the next pass, without another reflector run", async () => {
		const { runtime, entries } = overBudgetHarness();
		active = runtime;
		let failure: "abort" | undefined = "abort";
		const { complete, stages } = workers(runtime, () => failure);
		const first = await consolidate(runtime, "agent_end", { complete });
		expect(first.skipped).toBe("aborted");
		expect(first.reflected).toBe(1);
		expect(runtime.dropPending).toBeDefined();
		const before = observationTokens(foldLedger(entries).activeObservations);
		expect(before).toBeGreaterThan(300);

		failure = undefined;
		const second = await consolidate(runtime, "agent_end", { complete });
		expect(second).toMatchObject({ reflected: 0, dropped: 2 });
		expect(stages).toEqual(["reflector", "dropper", "dropper"]);
		expect(observationTokens(foldLedger(entries).activeObservations)).toBeLessThan(before);
		expect(runtime.dropPending).toBeUndefined();

		// A completed dropper run is not repeated over the unchanged pool.
		const third = await consolidate(runtime, "agent_end", { complete });
		expect(third.skipped).toBe("below_threshold");
		expect(stages).toHaveLength(3);
	});

	test("a failed dropper is retried alone once the failure backoff expires", async () => {
		const { runtime } = overBudgetHarness();
		active = runtime;
		let failure: "error" | undefined = "error";
		const { complete, stages } = workers(runtime, () => failure);
		const first = await consolidate(runtime, "agent_end", { complete });
		expect(first.skipped).toBe("failed");
		expect(runtime.dropPending).toBeDefined();

		failure = undefined;
		runtime.failureBackoffUntil = 0;
		const second = await consolidate(runtime, "agent_end", { complete });
		expect(second).toMatchObject({ reflected: 0, dropped: 2 });
		expect(stages).toEqual(["reflector", "dropper", "dropper"]);
	});

	test("a dropper that keeps failing is retried a bounded number of times without failing later passes", async () => {
		const { runtime } = overBudgetHarness();
		active = runtime;
		const { complete, stages } = workers(runtime, () => "error");
		const first = await consolidate(runtime, "agent_end", { complete });
		expect(first.skipped).toBe("failed");
		runtime.failureBackoffUntil = 0;

		const later: Array<string | undefined> = [];
		for (let i = 0; i < 5; i++) later.push((await consolidate(runtime, "agent_end", { complete })).skipped);
		// Two failed retries complete their passes; then the retry is given up
		// and only a new reflector pass re-arms the dropper.
		expect(stages).toEqual(["reflector", ...Array<Stage>(DROPPER_MAX_FAILURES).fill("dropper")]);
		expect(later).toEqual([undefined, undefined, "below_threshold", "below_threshold", "below_threshold"]);
		expect(runtime.failureCount).toBe(0);
		expect(runtime.isFailureBackoffActive()).toBe(false);
		expect(runtime.dropPending).toBeUndefined();
	});
});

describe("tool-less observer replies", () => {
	const decision = "Decision: the ledger store is Postgres 16; never use SQLite. The deploy key lives in vault path kv/deploy.";

	function proseHarness() {
		const harness = makeHarness({
			observeAfterTokens: 1,
			reflectAfterTokens: 1_000_000,
			observationsPoolMaxTokens: 1_000_000,
			redactSecrets: false,
		});
		harness.entries.push(messageEntry("m1", "user", decision));
		harness.entries.push(messageEntry("m2", "assistant", "Understood, Postgres 16 and vault kv/deploy."));
		return harness;
	}

	function replying(reply: string): { complete: typeof completeSimple; calls: () => number } {
		let calls = 0;
		const complete = (async () => {
			calls++;
			return makeAssistant([text(reply)]);
		}) as unknown as typeof completeSimple;
		return { complete, calls: () => calls };
	}

	test("observations written as prose are an unproductive attempt, not a clean empty chunk", async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		const prose = replying(
			"Here is what I observed in this chunk. The user decided that the ledger store is Postgres 16 and that SQLite must never be used. " +
				"The deploy key lives in vault path kv/deploy, and the assistant acknowledged both points without further changes.",
		);
		await consolidate(runtime, "manual", { force: true, complete: prose.complete });
		expect(recordedEntries(entries)).toHaveLength(0);
		expect(latestCoverageId(entries, RECORDED)).toBeUndefined();
		expect(runtime.observerRetry).toMatchObject({ startId: "m1", attempts: 1 });

		for (let i = 1; i < OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS; i++) {
			await consolidate(runtime, "manual", { force: true, complete: prose.complete });
		}
		expect(prose.calls()).toBe(OBSERVER_MAX_UNPRODUCTIVE_ATTEMPTS);
		expect(recordedEntries(entries).at(-1)?.data).toMatchObject({ observations: [], coversUpToId: "m2", coverageReason: "retry_limit" });
	});

	test("a short list of observations in text is not a clean empty chunk", async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		const list = "Observations:\n- 2026-10-29 10:00 [critical] User decided the ledger store is Postgres 16 and never SQLite.\n- [high] Deploy key lives at vault kv/deploy.";
		expect(list.length).toBeLessThanOrEqual(200);
		await consolidate(runtime, "manual", { force: true, complete: replying(list).complete });
		expect(recordedEntries(entries)).toHaveLength(0);
	});

	test("a tool call written out as JSON text is not a clean empty chunk", async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		await consolidate(runtime, "manual", { force: true, complete: replying('{"observations": []}').complete });
		expect(recordedEntries(entries)).toHaveLength(0);
	});

	test("a reply with no visible text is not a clean empty chunk", async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		await consolidate(runtime, "manual", { force: true, complete: replying("").complete });
		expect(recordedEntries(entries)).toHaveLength(0);
		expect(runtime.observerRetry).toMatchObject({ attempts: 1 });
	});

	test("a one-line observation in prose is retried, not a clean empty chunk", async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		const observer = replying("User chose Postgres 16 for the ledger store and never SQLite.");
		await consolidate(runtime, "manual", { force: true, complete: observer.complete });
		expect(recordedEntries(entries)).toHaveLength(0);
		expect(runtime.observerRetry).toMatchObject({ startId: "m1", attempts: 1 });
	});

	test('"Nothing new." advances coverage with a coverage-only marker', async () => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		const result = await consolidate(runtime, "manual", { force: true, complete: replying("Nothing new.").complete });
		expect(result.observed).toBe(0);
		expect(recordedEntries(entries)).toHaveLength(1);
		expect(recordedEntries(entries)[0]?.data).toMatchObject({ observations: [], coversUpToId: "m2", coverageReason: "empty" });
	});

	test.each([
		"Observations: none.",
		"No new observations as of 2026-10-29.",
		"Nothing new.\n\nThe chunk only repeats what is already in memory.",
	])("the explicit negative %p is a clean empty chunk on the first attempt", async (reply) => {
		const { runtime, entries } = proseHarness();
		active = runtime;
		const observer = replying(reply);
		await consolidate(runtime, "manual", { force: true, complete: observer.complete });
		expect(observer.calls()).toBe(1);
		expect(recordedEntries(entries)).toHaveLength(1);
		expect(recordedEntries(entries)[0]?.data).toMatchObject({ observations: [], coversUpToId: "m2", coverageReason: "empty" });
		expect(runtime.observerRetry).toBeUndefined();
	});

	test("classifies replies", () => {
		expect(isNothingNewReply("Nothing new.")).toBe(true);
		expect(isNothingNewReply("  nothing new  \n")).toBe(true);
		expect(isNothingNewReply("No new information in this chunk.")).toBe(true);
		// Length alone is not a verdict: a short line that does not say "nothing new" is a fact.
		expect(isNothingNewReply("x".repeat(200))).toBe(false);
		expect(isNothingNewReply("The user decided to deploy only to eu-west-1 (ticket OPS-4411) and never to us-east-1.")).toBe(false);
		expect(isNothingNewReply("User prefers tabs over spaces and wants all PRs squash-merged.")).toBe(false);
		expect(isNothingNewReply("Nothing new except that the user chose Postgres.")).toBe(false);
		expect(isNothingNewReply("The user said nothing new should ship before Friday.")).toBe(false);
		expect(isNothingNewReply("The user found no new information about the bug in the logs.")).toBe(false);
		// Verdict words inside a sentence about the conversation are a fact, not a verdict.
		for (const fact of [
			"User noted the embeddings index is already in memory and decided to drop the disk cache.",
			"The user said the old branch has nothing worth keeping and deleted it.",
			"The user approved the plan with nothing else to add; implementation starts with the parser in src/parse.ts.",
			"User requested that error responses expose no additional details.",
			"The user searched the logs and found no new information.",
			"The user chose eu-west-1; nothing else to record.",
		]) {
			expect(isNothingNewReply(fact)).toBe(false);
		}
		// An explanation must say why nothing is new and carry no exception or fact.
		expect(isNothingNewReply("Nothing new.\nExcept that the user chose Postgres 16.")).toBe(false);
		expect(isNothingNewReply("Nothing new.\nBut the user chose Postgres 16.")).toBe(false);
		expect(isNothingNewReply("Nothing new.\nUser chose Postgres 16 and never SQLite.")).toBe(false);
		expect(isNothingNewReply("Nothing new to record; the user chose eu-west-1.")).toBe(false);
		expect(isNothingNewReply("Nothing new; however the user chose Postgres 16.")).toBe(false);
		expect(isNothingNewReply("Nothing new. - User chose Postgres.")).toBe(false);
		// "Nothing new" said in other words, or with a reason on the same line.
		for (const verdict of [
			"There is nothing new to record.",
			"The chunk contains nothing new.",
			"Nothing worth recording in this chunk.",
			"All of this is already in memory.",
			"No new information to record in this chunk.",
			"Nothing new to observe.",
			"Nothing noteworthy.",
			"Nothing new. The chunk only contains a greeting.",
			"Nothing new - just small talk.",
			"Nothing new here; the user only said thanks.",
		]) {
			expect(isNothingNewReply(verdict)).toBe(true);
		}
		// No visible text at all: a swallowed tool call is not an explicit "nothing new".
		expect(isNothingNewReply("")).toBe(false);
		expect(isNothingNewReply("  \n ")).toBe(false);
		expect(isNothingNewReply("x".repeat(201))).toBe(false);
		// Explicit negatives that use record-like words, a bare date, or a short explanation.
		expect(isNothingNewReply("Observations: none.")).toBe(true);
		expect(isNothingNewReply("New observations: nothing new")).toBe(true);
		expect(isNothingNewReply("**Nothing new.**")).toBe(true);
		expect(isNothingNewReply("- Nothing new.")).toBe(true);
		expect(isNothingNewReply("No new observations as of 2026-10-29.")).toBe(true);
		expect(isNothingNewReply("Nothing new.\n\nThe chunk only repeats what is already in memory.")).toBe(true);
		expect(isNothingNewReply("Nothing new.\r\nNo new observations.")).toBe(true);
		// Only an explicit verdict may be followed by more lines, and never by records.
		expect(isNothingNewReply("The user said thanks.\nThe assistant replied.")).toBe(false);
		expect(isNothingNewReply("Nothing new.\n- User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("Nothing new.\n[high] User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("Nothing new.\nObservations: User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("Observations: none, except the user chose Postgres.")).toBe(false);
		expect(isNothingNewReply("2026-10-29 10:00 User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("I would call record_observations here.")).toBe(false);
		expect(isNothingNewReply('{"observations":[{"content":"x"}]}')).toBe(false);
		expect(isNothingNewReply("<tool_call>record</tool_call>")).toBe(false);
		expect(isNothingNewReply("- User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("Observations: User chose Postgres.")).toBe(false);
		expect(isNothingNewReply("[high] User chose Postgres.")).toBe(false);
	});

	test('the observer prompt asks for exactly "Nothing new." when nothing is worth recording', () => {
		expect(OBSERVER_SYSTEM).toContain('reply with exactly "Nothing new."');
	});
});

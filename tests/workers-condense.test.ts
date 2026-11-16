import { afterEach, describe, expect, test } from "bun:test";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../src/constants";
import { foldLedger } from "../src/ledger/fold";
import type { LedgerEntry, Observation, Reflection } from "../src/ledger/types";
import type { SessionRuntime } from "../src/runtime";
import {
	CONDENSER_BATCH_MAX_TOKENS,
	CONDENSER_MAX_MERGED_CONDENSED_TOKENS,
	CONDENSER_MAX_MERGED_TOKENS,
	CONDENSER_MAX_TURNS,
	condenserRecentTokens,
	namesMissingFromSources,
	runCondenser,
} from "../src/workers/condenser";
import type { ResolvedWorkerModel } from "../src/workers/model";
import { cancelScheduledConsolidation, consolidate } from "../src/workers/trigger";
import { backlogEntries, makeAssistant, makeHarness, makeModel, makeToolCall, messageEntry, observationEntry, scriptedComplete, text } from "./helpers";

const CONDENSED = "ob-memory.reflections.condensed";

const resolved: ResolvedWorkerModel = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low",
	maxTokens: 4096,
	label: "test/test-model",
	fallbackUsed: false,
};

function obs(id: string, relevance: Observation["relevance"] = "medium"): Observation {
	const content = `User decided detail ${id} about the storage layer.`;
	return { id, content, timestamp: "2026-10-29 10:00", relevance, sourceEntryIds: ["m1"], tokenCount: estimateTextTokens(content) };
}

function refl(id: string, content: string, support: string[]): Reflection {
	return { id, content, supportingObservationIds: support, tokenCount: estimateTextTokens(content) };
}

const O1 = "a00000000001";
const O2 = "a00000000002";
const O3 = "a00000000003";
const R1 = refl("b00000000001", "The ledger store is Postgres 16, chosen for its JSONB support and the existing ops runbooks.", [O1]);
const R2 = refl("b00000000002", "The schedule editor timezone field is being replaced by the Base UI combobox from web/src/components/ui/combobox.tsx.", [O2]);
const R3 = refl("b00000000003", "Work in progress was parked in /tmp/hotpath-wip.patch because git stash is blocked in the shared checkout.", [O3]);
const R4 = refl("b00000000004", "The schedule editor timezone field now uses the Base UI combobox with a controlled value and an optional portal container.", [O3]);
const POOL = [R1, R2, R3, R4];
const OBSERVATIONS = [obs(O1), obs(O2), obs(O3)];

function condenseCall(args: { merges?: Array<{ replaces: string[]; content: string; subject?: string }>; retire?: string[] }) {
	const merges = (args.merges ?? []).map((merge) => ({ subject: "test subject", ...merge }));
	return makeAssistant([makeToolCall("condense_reflections", { merges, retire: args.retire ?? [] })], "toolUse");
}

function isMergeCheck(context: { tools?: Array<{ name: string }> }): boolean {
	return context.tools?.[0]?.name === "report_merge_checks";
}

/** A merge-check reply that finds no issue in any merge. */
function cleanCheck() {
	return makeAssistant([makeToolCall("report_merge_checks", { merges: [] })], "toolUse");
}

function promptCapture(reply = makeAssistant([text("Nothing to condense.")])) {
	const prompts: string[] = [];
	const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
		if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
		const content = context.messages[0]?.content;
		prompts.push(typeof content === "string" ? content : "");
		return reply;
	}) as unknown as typeof completeSimple;
	return { complete, prompts };
}

describe("condenser", () => {
	test("merges reflections into one shorter line with their combined support and retires obsolete ones", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const content = "The schedule editor timezone field is the Base UI combobox (web/src/components/ui/combobox.tsx).";
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: POOL,
			observations: OBSERVATIONS,
			targetTokens: 1,
			signal: new AbortController().signal,
			complete: scriptedComplete([
				condenseCall({ merges: [{ replaces: [R4.id, R2.id], content }], retire: [R3.id] }),
				makeAssistant([text("Done.")]),
			]),
		});
		expect(result?.retiredReflectionIds).toEqual([R2.id, R3.id, R4.id]);
		expect(result?.reflections).toHaveLength(1);
		const merged = result!.reflections[0]!;
		expect(merged.content).toBe(content);
		expect(merged.condensedFromIds).toEqual([R2.id, R4.id]);
		expect(merged.supportingObservationIds).toEqual([O2, O3]);
		expect(merged.id).toMatch(/^[a-f0-9]{12}$/);
		expect(POOL.some((reflection) => reflection.id === merged.id)).toBe(false);
	});

	test("rejects unknown and reused ids, lines that do not shrink, and retiring a protected reflection", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const toolResults: string[] = [];
		let call = 0;
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ role?: string; content: unknown }>; tools?: Array<{ name: string }> },
		) => {
			if (isMergeCheck(context)) return context.messages.length === 1 ? cleanCheck() : makeAssistant([text("Done.")]);
			call++;
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({
				merges: [
					{ replaces: [R2.id], content: `${R2.content} It also keeps the browser timezone as the default value.` },
					{ replaces: [R3.id, R4.id], content: "The timezone field is the Base UI combobox; WIP sits in /tmp/hotpath-wip.patch." },
				],
				retire: [R1.id, "ffffffffffff", R3.id],
			});
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: POOL,
			observations: [obs(O1, "critical"), obs(O2), obs(O3)],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(call).toBe(2);
		// Merges are validated before retirements, so retiring R3 reuses an id.
		expect(result?.reflections.map((reflection) => reflection.condensedFromIds)).toEqual([[R3.id, R4.id]]);
		expect(result?.retiredReflectionIds).toEqual([R3.id, R4.id]);
		const feedback = toolResults.join("\n");
		expect(feedback).toContain("must cut at least a tenth of the reflections it replaces");
		expect(feedback).toContain("protected");
		expect(feedback).toContain("not an id listed under REFLECTION POOL");
		expect(feedback).toContain("already used");
		expect(feedback).toContain("Accepted 1 merge and 0 retirements (merge #2)");
		expect(feedback).toContain("Accepted changes are final: never send them again. Send only corrected versions of the rejected items");
		expect(feedback).toMatch(/Cut so far this run: ~\d+ of ~\d+ tokens/);
	});

	test("rejects a merged line that names a path, function, commit or ticket none of its sources mention", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const toolResults: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({
				merges: [
					// R1 says nothing about a migration file: the name comes from elsewhere.
					{ replaces: [R1.id], content: "The ledger store is Postgres 16 (JSONB), migrated by db/migrate_016.sql." },
					{ replaces: [R2.id, R4.id], content: "The schedule timezone field is the Base UI combobox (web/src/components/ui/combobox.tsx)." },
				],
			});
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(toolResults.join("\n")).toContain("merge #1: names db/migrate_016.sql that none of the reflections it replaces mention");
		expect(result?.reflections.map((reflection) => reflection.condensedFromIds)).toEqual([[R2.id, R4.id]]);
	});

	test("finds names a merged line takes from outside its sources", () => {
		const sources = [
			"Retry lives in server/task_retry.go (runDueTaskRetries, MAX_RETRY_DELAY) and shipped as PR #84 at 1385795 for SKEIN-84.",
			"GitHub Actions is advisory for the fork.",
		];
		expect(
			namesMissingFromSources("Retry is server/task_retry.go runDueTaskRetries max_retry_delay, PR #84 (1385795), SKEIN-84, on github.", sources),
		).toEqual([]);
		expect(
			namesMissingFromSources(
				"Retry is server/retry.go with scheduleRetries, retry_budget and commit 9f9b11a for PR #85 and SKEIN-91; GitLab runs CI.",
				sources,
			),
		).toEqual(["server/retry.go", "9f9b11a", "scheduleRetries", "GitLab", "retry_budget", "#85", "SKEIN-91"]);
		// A slash-joined list of files each named on its own, and units or acronyms, are not new names.
		expect(namesMissingFromSources("Mocks live in data.ts/handler.ts and stay under 16 KiB for E2E runs.", ["Update mock data.ts and handler.ts."])).toEqual([]);
		expect(namesMissingFromSources("Mocks live in data.ts/other.ts.", ["Update mock data.ts and handler.ts."])).toEqual(["data.ts/other.ts"]);
	});

	test("finds file names, long numbers and code names in another case that the sources lack", () => {
		const sources = ["Follow CONTRIBUTING.md; createTask caps bodies at 16,384 bytes; SKEIN_TEST_DSN names the test database.", "Merged at 1385795."];
		// The same names, a number written without its separator, and snake_case in another case are known.
		expect(namesMissingFromSources("CONTRIBUTING.md: createTask caps bodies at 16384 bytes (skein_test_dsn); merged at 1385795.", sources)).toEqual([]);
		// A file name without a directory, an all-digit commit, and a code name whose case differs are not.
		expect(namesMissingFromSources("HANDOFF.md: CreateTask merged at 5127577, not 1385795.", sources)).toEqual(["HANDOFF.md", "CreateTask", "5127577"]);
		// Abbreviations, versions, decimals and method calls on a one-letter receiver are not file names.
		expect(namesMissingFromSources("Use e.g. v0.6.1 at 1.5x, then t.Cleanup.", sources)).toEqual([]);
	});

	test("rejects a merge that does not name the one subject it covers", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const toolResults: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({ merges: [{ replaces: [R2.id, R4.id], subject: "  ", content: "The schedule timezone field is the Base UI combobox." }] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(result).toBeUndefined();
		expect(toolResults.join("\n")).toContain("merge #1: subject must name");
	});

	test("rejects a merge whose subject joins several subjects", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const toolResults: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({
				merges: [
					{ replaces: [R2.id], subject: "schedule timezone and retry backoff", content: "The schedule timezone field is the Base UI combobox." },
					{ replaces: [R4.id], subject: "timezone field, combobox", content: "The timezone field is a Base UI combobox." },
				],
			});
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(result).toBeUndefined();
		const joined = toolResults.join("\n");
		expect(joined).toContain('merge #1: subject \\"schedule timezone and retry backoff\\" joins more than one subject');
		expect(joined).toContain("merge #2: subject \\\"timezone field, combobox\\\" joins more than one subject");
	});

	test("rejects a merge the check finds changes what its sources say, and keeps the faithful ones", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const toolResults: string[] = [];
		const checkPrompts: string[] = [];
		const distorted = "The ledger store is Postgres 16, chosen for the ops runbooks alone.";
		const faithful = "The schedule editor timezone field is the Base UI combobox (web/src/components/ui/combobox.tsx).";
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ role?: string; content: unknown }>; tools?: Array<{ name: string }> },
		) => {
			const last = context.messages.at(-1);
			if (isMergeCheck(context)) {
				if (last?.role === "toolResult") return makeAssistant([text("Done.")]);
				checkPrompts.push(String(context.messages[0]?.content));
				return makeAssistant(
					[
						makeToolCall("report_merge_checks", {
							merges: [
								{ merge: 1, issues: [{ claim: "chosen for the ops runbooks alone", problem: "The source gives JSONB support as a reason too." }] },
								{ merge: 2, issues: [{ claim: "a claim this line never makes", problem: "Not about this line." }] },
							],
						}),
					],
					"toolUse",
				);
			}
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({
				merges: [
					{ replaces: [R1.id], content: distorted },
					{ replaces: [R2.id, R4.id], content: faithful },
				],
				retire: [R1.id],
			});
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		// One check covers both merges of the call.
		expect(checkPrompts).toHaveLength(1);
		expect(checkPrompts[0]).toContain(`MERGE 1\nMerged line: ${distorted}\nSources (oldest first):\n- ${R1.content}`);
		expect(checkPrompts[0]).toContain(`MERGE 2\nMerged line: ${faithful}`);
		// A claim that does not quote its line is ignored, so merge #2 is kept.
		expect(result?.reflections.map((reflection) => reflection.content)).toEqual([faithful]);
		// R1 belongs to the rejected merge, so it is not retired either.
		expect(result?.retiredReflectionIds).toEqual([R2.id, R4.id]);
		const feedback = toolResults.join("\n");
		expect(feedback).toContain(
			'merge #1: changes what the reflections behind it say (\\"chosen for the ops runbooks alone\\": The source gives JSONB support as a reason too.)',
		);
		expect(feedback).toContain(`retire #1: ${R1.id} is part of merge #1, which was rejected`);
	});

	test("checks a merge of a condensed line against the original reflections behind it", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const condensed: Reflection = {
			...refl("c00000000001", "The schedule editor timezone field is the Base UI combobox with a controlled value.", [O2, O3]),
			condensedFromIds: [R2.id, R4.id],
			tier: 1,
		};
		const byId = new Map([R2, R4, condensed, R1].map((reflection) => [reflection.id, reflection]));
		const checkPrompts: string[] = [];
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ role?: string; content: unknown }>; tools?: Array<{ name: string }> },
		) => {
			if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
			if (isMergeCheck(context)) {
				checkPrompts.push(String(context.messages[0]?.content));
				return cleanCheck();
			}
			return condenseCall({ merges: [{ replaces: [condensed.id, R1.id], content: "Timezone field: Base UI combobox; ledger store: Postgres 16." }] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: [condensed, R1],
			observations: OBSERVATIONS,
			targetTokens: 1,
			reflectionsById: byId,
			signal: new AbortController().signal,
			complete,
		});
		expect(result?.reflections).toHaveLength(1);
		expect(checkPrompts[0]).toContain(`- ${R2.content}\n- ${R4.content}\n- ${R1.content}`);
		expect(checkPrompts[0]).not.toContain(condensed.content);
	});

	test("accepts checked merges as before when the check itself fails", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const content = "The schedule editor timezone field is the Base UI combobox (web/src/components/ui/combobox.tsx).";
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ role?: string; content: unknown }>; tools?: Array<{ name: string }> },
		) => {
			if (isMergeCheck(context)) return makeAssistant([text("")], "error", "overloaded");
			if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
			return condenseCall({ merges: [{ replaces: [R2.id, R4.id], content }] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(result?.reflections.map((reflection) => reflection.content)).toEqual([content]);
	});

	test("skips the merge check when condenserCheck is off", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, condenserCheck: false });
		const content = "The schedule editor timezone field is the Base UI combobox (web/src/components/ui/combobox.tsx).";
		let checks = 0;
		const complete = (async (
			_model: unknown,
			context: { messages: Array<{ role?: string; content: unknown }>; tools?: Array<{ name: string }> },
		) => {
			if (isMergeCheck(context)) {
				checks++;
				return cleanCheck();
			}
			if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
			return condenseCall({ merges: [{ replaces: [R2.id, R4.id], content }] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(checks).toBe(0);
		expect(result?.reflections.map((reflection) => reflection.content)).toEqual([content]);
	});

	test("caps retirements at the hard maximum for this run", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const pool = [R1, R2, R3];
		const total = pool.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: pool,
			observations: OBSERVATIONS,
			// At most one average reflection over target allows one retirement.
			targetTokens: total - Math.floor(total / pool.length),
			signal: new AbortController().signal,
			complete: scriptedComplete([condenseCall({ retire: [R1.id, R2.id, R3.id] }), makeAssistant([text("Done.")])]),
		});
		expect(result?.retiredReflectionIds).toEqual([R1.id]);
	});

	test("lists the pool oldest first, marks protected reflections, and states the retirement maximum", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const { complete, prompts } = promptCapture();
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: POOL,
			observations: [obs(O1, "critical"), obs(O2), obs(O3)],
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		expect(result).toBeUndefined();
		const prompt = prompts[0] ?? "";
		expect(prompt.indexOf(R1.id)).toBeLessThan(prompt.indexOf(R4.id));
		expect(prompt).toContain(`[${R1.id}] [protected] ${R1.content}`);
		expect(prompt).toContain(`[${R2.id}] ${R2.content}`);
		expect(prompt).toMatch(/Hard maximum retirements this run: \d+/);
		expect(prompt).toMatch(/This batch: ~\d+ tokens; aim to cut it by about 50%/);
	});

	test("keeps the prompt inside workerMemoryMaxTokens and only accepts listed ids", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 90 });
		const { complete, prompts } = promptCapture(condenseCall({ retire: POOL.map((reflection) => reflection.id) }));
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: POOL,
			observations: OBSERVATIONS,
			targetTokens: 1,
			signal: new AbortController().signal,
			complete,
		});
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("not listed in this batch");
		const listed = POOL.filter((reflection) => prompt.includes(reflection.id)).map((reflection) => reflection.id);
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.length).toBeLessThan(POOL.length);
		expect(result?.retiredReflectionIds).toEqual(listed);
	});

	test("lists at most one batch of reflections however large the worker memory budget", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 1_000_000 });
		const pool = Array.from({ length: 400 }, (_, index) =>
			refl(`d${index.toString(16).padStart(11, "0")}`, `Durable fact number ${index} about the billing service and its storage layer.`, [O1]),
		);
		const { complete, prompts } = promptCapture();
		await runCondenser({ runtime, resolved, reflections: pool, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		const listed = pool.filter((reflection) => prompt.includes(reflection.id));
		const listedTokens = listed.reduce((total, reflection) => total + estimateTextTokens(`[${reflection.id}] ${reflection.content}`) + 1, 0);
		expect(listedTokens).toBeLessThanOrEqual(CONDENSER_BATCH_MAX_TOKENS);
		expect(listed.length).toBeGreaterThan(0);
		// Oldest first, one contiguous run.
		expect(listed.map((reflection) => reflection.id)).toEqual(pool.slice(0, listed.length).map((reflection) => reflection.id));
		expect(prompt).toContain("not listed in this batch");
		// The newest reflection is shown as read-only context, without its id.
		const context = prompt.slice(prompt.indexOf("OTHER REFLECTIONS"));
		expect(context).toContain(`- ${pool.at(-1)!.content}`);
		expect(context).not.toContain(pool.at(-1)!.id);
	});

	test("never lists the newest reflections, so they stay verbatim, and shows them as read-only context", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const pool = Array.from({ length: 20 }, (_, index) =>
			refl(`d${index.toString(16).padStart(11, "0")}`, `Durable fact number ${index} about the billing service and its storage layer.`, [O1]),
		);
		const total = pool.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
		const targetTokens = total - 30;
		let window = 0;
		const recent = new Set<string>();
		for (const reflection of [...pool].reverse()) {
			if (window + reflection.tokenCount > condenserRecentTokens(targetTokens)) break;
			window += reflection.tokenCount;
			recent.add(reflection.id);
		}
		expect(recent.size).toBeGreaterThan(0);
		expect(recent.size).toBeLessThan(pool.length);
		const newest = pool.at(-1)!;
		const toolResults: string[] = [];
		const prompts: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			const content = context.messages[0]?.content;
			prompts.push(typeof content === "string" ? content : "");
			return condenseCall({ retire: [newest.id, pool[0]!.id] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: pool, observations: OBSERVATIONS, targetTokens, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		for (const reflection of pool) expect(prompt.includes(reflection.id)).toBe(!recent.has(reflection.id));
		expect(prompt.slice(prompt.indexOf("OTHER REFLECTIONS"))).toContain(`- ${newest.content}`);
		expect(toolResults.join("\n")).toContain("retire #1: not an id listed under REFLECTION POOL");
		expect(result?.retiredReflectionIds).toEqual([pool[0]!.id]);
	});

	test("leaves merged lines out of a batch whose never-condensed reflections can supply the cut, showing them as context", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const merged: Reflection = {
			...refl("c00000000001", "Merged line about the schedule editor: its timezone field is the Base UI combobox with a controlled value.", [O2, O3]),
			condensedFromIds: ["b00000000009", "b0000000000a"],
		};
		const pool = [merged, ...POOL];
		const total = pool.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
		const { complete, prompts } = promptCapture();
		// A pool barely over target: the raw reflections outside the recent window cover the cut.
		await runCondenser({ runtime, resolved, reflections: pool, observations: OBSERVATIONS, targetTokens: total - 5, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain(R1.id);
		expect(prompt).not.toContain(merged.id);
		expect(prompt.slice(prompt.indexOf("OTHER REFLECTIONS"))).toContain(`- ${merged.content}`);
	});

	test("lists never-condensed reflections before merged lines, which sit at old positions", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 90 });
		const merged: Reflection = {
			...refl("c00000000001", "Merged line about the schedule editor: its timezone field is the Base UI combobox with a controlled value.", [O2, O3]),
			condensedFromIds: ["b00000000009", "b0000000000a"],
		};
		const { complete, prompts } = promptCapture();
		await runCondenser({ runtime, resolved, reflections: [merged, ...POOL], observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain(R1.id);
		expect(prompt).not.toContain(merged.id);
	});

	test("a short merged line does not fill a leftover gap while never-condensed reflections are left out", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 90 });
		const merged: Reflection = { ...refl("c00000000001", "Postgres 16 is the ledger store.", [O1]), condensedFromIds: ["b00000000009"] };
		const { complete, prompts } = promptCapture();
		await runCondenser({ runtime, resolved, reflections: [merged, ...POOL], observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		expect(POOL.some((reflection) => !prompt.includes(reflection.id))).toBe(true);
		expect(prompt).not.toContain(merged.id);
	});

	test("condenses merged lines again once every never-condensed reflection fits in the batch", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const merged: Reflection = { ...refl("c00000000001", R2.content, [O2]), condensedFromIds: ["b00000000009"] };
		const { complete, prompts } = promptCapture();
		await runCondenser({ runtime, resolved, reflections: [merged, R1], observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(prompts[0]).toContain(merged.id);
	});

	test("rejects a merged line past the hard length cap even when it cuts enough", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const pool = Array.from({ length: 5 }, (_, index) =>
			refl(`e${index.toString(16).padStart(11, "0")}`, `Billing detail ${index}: ${"the invoice pipeline writes immutable rows and reconciles totals nightly; ".repeat(5)}`, [O1]),
		);
		const toolResults: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			return condenseCall({ merges: [{ replaces: pool.map((reflection) => reflection.id), content: `Billing: ${"invoice rows are immutable and reconciled nightly, ".repeat(18)}` }] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: pool, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(result).toBeUndefined();
		expect(toolResults.join("\n")).toContain("split unrelated subjects into separate merges");
	});

	test("merged lines are marked and a mostly-condensed batch is asked for a smaller cut", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const condensed = (id: string, content: string, from: string): Reflection => ({ ...refl(id, content, [O2]), condensedFromIds: [from] });
		const M1 = condensed("c00000000001", "The schedule editor timezone field is the Base UI combobox with a controlled value and a portal container.", "b00000000011");
		const M2 = condensed("c00000000002", "Schedule edits need an e2e smoke that fills future once windows after choosing a timezone.", "b00000000012");
		const M3 = condensed("c00000000003", "The ledger store is Postgres 16, chosen for JSONB support and existing ops runbooks.", "b00000000013");
		const prompts: string[] = [];
		const toolResults: string[] = [];
		const complete = (async (_model: unknown, context: { messages: Array<{ role?: string; content: unknown }> }) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResults.push(JSON.stringify(last.content));
				return makeAssistant([text("Done.")]);
			}
			const content = context.messages[0]?.content;
			prompts.push(typeof content === "string" ? content : "");
			return condenseCall({
				merges: [
					{ replaces: [M3.id], content: "The ledger store is Postgres 16, chosen for JSONB support and its runbooks." },
					{ replaces: [M1.id, M2.id], content: "Schedule timezone is a Base UI combobox; smokes fill future once windows after picking a zone." },
				],
			});
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: [M1, M2, M3], observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(prompts[0]).toContain(`[${M1.id}] [condensed] ${M1.content}`);
		expect(prompts[0]).toMatch(/aim to cut it by about 30%/);
		expect(toolResults.join("\n")).toContain("merge #1: the merged line must cut at least a tenth");
		expect(result?.reflections.map((reflection) => reflection.condensedFromIds)).toEqual([[M1.id, M2.id]]);
	});

	test("a merged line records a tier one above its highest source", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const T1: Reflection = { ...refl("c00000000001", R2.content, [O2]), condensedFromIds: ["b00000000011"], tier: 1 };
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: [R1, T1, R3, R4],
			observations: OBSERVATIONS,
			targetTokens: 1,
			signal: new AbortController().signal,
			complete: scriptedComplete([
				condenseCall({
					merges: [
						{ replaces: [T1.id, R4.id], content: "The schedule timezone field is the Base UI combobox." },
						{ replaces: [R1.id, R3.id], content: "Postgres 16 is the ledger store; WIP sits in /tmp/hotpath-wip.patch." },
					],
				}),
				makeAssistant([text("Done.")]),
			]),
		});
		expect(result?.reflections.map((reflection) => [reflection.condensedFromIds, reflection.tier])).toEqual([
			[[R1.id, R3.id], 1],
			[[T1.id, R4.id], 2],
		]);
	});

	test("merged lines fill the batch lowest tier first, so no line is distilled twice before its tier had a turn", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, workerMemoryMaxTokens: 70 });
		const line = (id: string, tier: number): Reflection => ({
			...refl(id, `Durable fact ${id} about the billing service and its nightly reconciliation job.`, [O1]),
			condensedFromIds: [`b${id.slice(1)}`],
			tier,
		});
		const pool = [line("c00000000001", 2), line("c00000000002", 2), line("c00000000003", 1), line("c00000000004", 1)];
		const { complete, prompts } = promptCapture();
		await runCondenser({ runtime, resolved, reflections: pool, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("c00000000003");
		expect(prompt).toContain("c00000000004");
		expect(prompt).not.toContain("c00000000001");
	});

	test("a merged line may be shortened alone when the cut is deep enough", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const M3: Reflection = { ...refl("c00000000003", "The ledger store is Postgres 16, chosen for JSONB support and the existing ops runbooks that the team maintains.", [O1]), condensedFromIds: ["b00000000013"] };
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: [M3],
			observations: OBSERVATIONS,
			targetTokens: 1,
			signal: new AbortController().signal,
			complete: scriptedComplete([condenseCall({ merges: [{ replaces: [M3.id], content: "Postgres 16 is the ledger store (JSONB)." }] }), makeAssistant([text("Done.")])]),
		});
		expect(result?.reflections.map((reflection) => reflection.condensedFromIds)).toEqual([[M3.id]]);
	});

	test("a line merging condensed lines may run longer than a plain merged line, up to its own cap", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const long = (id: string, topic: string): Reflection => ({
			...refl(id, `${topic}: ${"the scheduler admits queued tasks in FIFO order under the concurrency limit and parks the rest; ".repeat(8)}`, [O2]),
			condensedFromIds: [`b${id.slice(1)}`],
		});
		const pool = [long("c00000000001", "Admission"), long("c00000000002", "Parking"), long("c00000000003", "Queues"), long("c00000000004", "Limits")];
		const merged = `Scheduling: ${"FIFO admission under the concurrency limit parks the remaining queued tasks until a slot frees; ".repeat(9)}`;
		const tooLong = `Scheduling: ${"FIFO admission under the concurrency limit parks the remaining queued tasks until a slot frees; ".repeat(13)}`;
		expect(estimateTextTokens(merged)).toBeGreaterThan(CONDENSER_MAX_MERGED_TOKENS);
		expect(estimateTextTokens(merged)).toBeLessThanOrEqual(CONDENSER_MAX_MERGED_CONDENSED_TOKENS);
		expect(estimateTextTokens(tooLong)).toBeGreaterThan(CONDENSER_MAX_MERGED_CONDENSED_TOKENS);
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: pool,
			observations: OBSERVATIONS,
			targetTokens: 1,
			signal: new AbortController().signal,
			complete: scriptedComplete([
				condenseCall({ merges: [{ replaces: [pool[0]!.id, pool[1]!.id], content: merged }, { replaces: [pool[2]!.id, pool[3]!.id], content: tooLong }] }),
				makeAssistant([text("Done.")]),
			]),
		});
		expect(result?.reflections.map((reflection) => reflection.condensedFromIds)).toEqual([[pool[0]!.id, pool[1]!.id]]);
	});

	test("stops a correction loop after CONDENSER_MAX_TURNS model turns", async () => {
		const { runtime } = makeHarness({ redactSecrets: false, agentMaxTurns: 8 });
		let calls = 0;
		const complete = (async () => {
			calls++;
			return condenseCall({ retire: ["ffffffffffff"] });
		}) as unknown as typeof completeSimple;
		const result = await runCondenser({ runtime, resolved, reflections: POOL, observations: OBSERVATIONS, targetTokens: 1, signal: new AbortController().signal, complete });
		expect(result).toBeUndefined();
		expect(calls).toBe(CONDENSER_MAX_TURNS);
	});

	test("does not call the model when the pool is within target", async () => {
		const { runtime } = makeHarness({ redactSecrets: false });
		const { complete, prompts } = promptCapture();
		const result = await runCondenser({
			runtime,
			resolved,
			reflections: POOL,
			observations: OBSERVATIONS,
			targetTokens: 100_000,
			signal: new AbortController().signal,
			complete,
		});
		expect(result).toBeUndefined();
		expect(prompts).toEqual([]);
	});
});

type Stage = "observer" | "reflector" | "condenser" | "checker" | "dropper";

function stageOf(context: { systemPrompt: string[] }): Stage {
	const system = context.systemPrompt[0] ?? "";
	if (system.includes("condenser agent")) return "condenser";
	if (system.includes("merge checker")) return "checker";
	if (system.includes("reflection agent")) return "reflector";
	if (system.includes("dropper agent")) return "dropper";
	return "observer";
}

/** Stage-aware worker model: `condenser` decides the condenser reply, every other stage declines. */
function workers(condenser: (call: number) => ReturnType<typeof makeAssistant> | "throw") {
	const stages: Stage[] = [];
	let condenserCalls = 0;
	const complete = (async (_model: unknown, context: { systemPrompt: string[]; messages: Array<{ role?: string }> }) => {
		if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
		const stage = stageOf(context);
		stages.push(stage);
		if (stage === "checker") return cleanCheck();
		if (stage !== "condenser") return makeAssistant([text("Nothing new.")]);
		const reply = condenser(++condenserCalls);
		if (reply === "throw") return makeAssistant([text("")], "error", "overloaded");
		return reply;
	}) as unknown as typeof completeSimple;
	return { complete, stages };
}

function reflectionsEntry(id: string, reflections: Reflection[], coversUpToId: string): LedgerEntry {
	return { type: "custom", id, customType: "ob-memory.reflections.recorded", data: { reflections, coversUpToId } };
}

let active: SessionRuntime | undefined;
afterEach(() => {
	if (active) {
		cancelScheduledConsolidation(active);
		active.dispose("test");
	}
	active = undefined;
});

/** Observed source, reflections over `reflectionsPoolMaxTokens`, every other stage idle. */
function overBudgetHarness() {
	const harness = makeHarness({
		redactSecrets: false,
		observeAfterTokens: 10_000_000,
		observationsPoolMaxTokens: 1_000_000,
		reflectAfterTokens: 1_000_000,
		reflectionsPoolMaxTokens: 60,
		reflectionsPoolTargetTokens: 40,
	});
	active = harness.runtime;
	harness.entries.push(messageEntry("m1", "user", "Use Postgres 16."));
	harness.entries.push(observationEntry("o1", OBSERVATIONS, "m1"));
	harness.entries.push(reflectionsEntry("r1", POOL, "m1"));
	return harness;
}

describe("condenser in a consolidation pass", () => {
	test("condenses an over-budget reflection pool into one condense record", async () => {
		const { runtime, entries } = overBudgetHarness();
		const content = "The schedule editor timezone field is the Base UI combobox.";
		const { complete, stages } = workers(() =>
			condenseCall({ merges: [{ replaces: [R2.id, R4.id], content }], retire: [R3.id] }),
		);
		const result = await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser", "checker"]);
		expect(result).toMatchObject({ observed: 0, reflected: 0, condensed: 3, dropped: 0 });
		const records = entries.filter((entry) => entry.customType === CONDENSED);
		expect(records).toHaveLength(1);
		expect(foldLedger(entries).reflections.map((reflection) => reflection.content)).toEqual([R1.content, content]);
		expect(runtime.lastCondenserAt).toBeGreaterThan(0);
	});

	test("does not run while the pool is within reflectionsPoolMaxTokens", async () => {
		const harness = overBudgetHarness();
		harness.runtime.config = { ...harness.runtime.config, reflectionsPoolMaxTokens: 100_000, reflectionsPoolTargetTokens: 50_000 };
		const { complete, stages } = workers(() => condenseCall({ retire: [R3.id] }));
		const result = await consolidate(harness.runtime, "turn_end", { complete });
		expect(result.skipped).toBe("below_threshold");
		expect(stages).toEqual([]);
	});

	test("a declined run is not repeated until new reflections grow the pool", async () => {
		const { runtime, entries } = overBudgetHarness();
		const { complete, stages } = workers(() => makeAssistant([text("Nothing to condense.")]));
		await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser"]);
		const second = await consolidate(runtime, "turn_end", { complete });
		expect(second.skipped).toBe("below_threshold");
		expect(stages).toEqual(["condenser"]);
		entries.push(
			reflectionsEntry("r2", [
				refl("b00000000005", `The deploy pipeline publishes to the staging registry first ${"and then promotes ".repeat(60)}`, [O1]),
				refl("b00000000006", `Release notes are generated from conventional commits ${"with scoped sections ".repeat(60)}`, [O2]),
			], "m1"),
		);
		await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser", "condenser"]);
		expect(entries.some((entry) => entry.customType === CONDENSED)).toBe(false);
	});

	test("a failing condenser is recorded without failing the pass or retrying at once", async () => {
		const { runtime, entries } = overBudgetHarness();
		const { complete, stages } = workers(() => "throw");
		const result = await consolidate(runtime, "turn_end", { complete });
		expect(result.skipped).toBeUndefined();
		expect(result.condensed).toBe(0);
		expect(runtime.lastError?.stage).toBe("condenser");
		expect(runtime.isFailureBackoffActive()).toBe(false);
		await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser"]);
		expect(entries.some((entry) => entry.customType === CONDENSED)).toBe(false);
	});

	test("a run that clearly shrinks a still over-budget pool leaves no wait and schedules a follow-up", async () => {
		const harness = makeHarness({
			redactSecrets: false,
			observeAfterTokens: 10_000_000,
			observationsPoolMaxTokens: 1_000_000,
			reflectAfterTokens: 1_000_000,
			reflectionsPoolMaxTokens: 300,
			reflectionsPoolTargetTokens: 200,
		});
		active = harness.runtime;
		const pool = Array.from({ length: 40 }, (_, index) =>
			refl(`d${index.toString(16).padStart(11, "0")}`, `Routine status number ${index} about the nightly build of the billing service.`, [O1]),
		);
		harness.entries.push(messageEntry("m1", "user", "Use Postgres 16."));
		harness.entries.push(observationEntry("o1", OBSERVATIONS, "m1"));
		harness.entries.push(reflectionsEntry("r1", pool, "m1"));
		const { complete, stages } = workers((call) => condenseCall({ retire: pool.slice((call - 1) * 12, call * 12).map((reflection) => reflection.id) }));
		const first = await consolidate(harness.runtime, "turn_end", { complete });
		expect(first.condensed).toBe(12);
		expect(harness.runtime.condenseGate).toBeUndefined();
		expect(harness.runtime.followUpPasses).toBe(1);
		cancelScheduledConsolidation(harness.runtime);
		const second = await consolidate(harness.runtime, "turn_end", { complete });
		expect(second.condensed).toBe(12);
		expect(stages).toEqual(["condenser", "condenser"]);
	});

	test("waits while the observer has a backlog, so observation is never delayed by condensing", async () => {
		const harness = makeHarness({
			redactSecrets: false,
			observeAfterTokens: 200,
			observerChunkMaxTokens: 400,
			observationsPoolMaxTokens: 1_000_000,
			reflectAfterTokens: 1_000_000,
			reflectionsPoolMaxTokens: 60,
			reflectionsPoolTargetTokens: 40,
		});
		active = harness.runtime;
		harness.entries.push(...backlogEntries(10));
		harness.entries.push(reflectionsEntry("r1", POOL, "m1"));
		const { complete, stages } = workers(() => condenseCall({ retire: [R3.id] }));
		const result = await consolidate(harness.runtime, "turn_end", { complete });
		expect(stages).toEqual(["observer"]);
		expect(result.condensed).toBe(0);
		expect(harness.runtime.condenseGate).toBeUndefined();
	});

	test("a /clear lifts the wait left by a declined run on the pre-clear pool", async () => {
		const { runtime, entries } = overBudgetHarness();
		const { complete, stages } = workers(() => makeAssistant([text("Nothing to condense.")]));
		await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser"]);
		entries.push({ type: "reset_boundary", id: "reset", timestamp: "2026-10-29T10:30:00.000Z" });
		entries.push(messageEntry("m2", "user", "Start over with the billing service."));
		entries.push(observationEntry("o2", [{ ...obs("a00000000009"), sourceEntryIds: ["m2"] }], "m2"));
		entries.push(
			reflectionsEntry("r2", [
				refl("b00000000007", "The billing service is the new focus after the reset, with its own Postgres schema.", ["a00000000009"]),
				refl("b00000000008", "Billing invoices are generated nightly by the scheduler and stored as immutable rows.", ["a00000000009"]),
				refl("b0000000000a", "Billing totals are computed in integer cents to avoid floating point rounding drift.", ["a00000000009"]),
			], "m2"),
		);
		await consolidate(runtime, "turn_end", { complete });
		expect(stages).toEqual(["condenser", "condenser"]);
	});

	test("observe-now condenses a pool above target even below the max", async () => {
		const harness = overBudgetHarness();
		const total = POOL.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
		harness.runtime.config = { ...harness.runtime.config, reflectionsPoolMaxTokens: total + 100, reflectionsPoolTargetTokens: total - 10 };
		const { complete, stages } = workers(() => condenseCall({ retire: [R3.id] }));
		const result = await consolidate(harness.runtime, "manual", { force: true, complete });
		expect(stages).toContain("condenser");
		expect(result.condensed).toBe(1);
	});
});

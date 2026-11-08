import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
	zod as piZod,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, completeSimple } from "@oh-my-pi/pi-ai";
import { handleMemoryCommand } from "../src/commands/control";
import { loadConfig } from "../src/config";
import { MAX_SOURCE_ENTRY_CHARS, estimateTextTokens } from "../src/constants";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { handleSessionCompacting } from "../src/hooks/compacting";
import { latestCompactionDetails, visibleProjection } from "../src/ledger/fold";
import { recallMemory } from "../src/ledger/recall";
import { serializeEntry } from "../src/ledger/serialize";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationCoverageData,
	type LedgerEntry,
	type MemoryDetails,
	type Observation,
	type Reflection,
} from "../src/ledger/types";
import { createObMemory, type ObMemoryOptions } from "../src/index";
import type { SessionRuntime } from "../src/runtime";
import { runDropper } from "../src/workers/dropper";
import { MAX_WORKER_OUTPUT_TOKENS, resolveWorkerModel, type ResolvedWorkerModel } from "../src/workers/model";
import { runReflector } from "../src/workers/reflector";
import { consolidate } from "../src/workers/trigger";
import {
	makeAssistant,
	makeHarness,
	makeModel,
	makeToolCall,
	messageEntry,
	observationEntry,
	text,
	type Harness,
} from "./helpers";

// Every sink that docs/privacy.md lists under "Redaction" gets a test here
// that fails when redaction at that sink is removed.

const TS = "2026-10-29T10:00:00.000Z";
const API_KEY = "sk-abcdefghijklmnopqrstuvwx";
const PASSWORD_COMMAND = "PASSWORD=hunter2 ./deploy.sh --prod";
const SECRETS = [API_KEY, "hunter2"];

const KEY_LINES = Array.from({ length: 30 }, (_, index) => `${String.fromCharCode(65 + (index % 26))}${"Zq7".repeat(21)}`);
/**
 * A private key rendered as a table column: every line ends in ` |`. Only the
 * rule for a complete BEGIN…END block tolerates such lines; once truncation
 * drops the END line, the cut-off-key fallback stops at the first ` |` line.
 * So these lines are hidden only when each entry is redacted before it is
 * truncated.
 */
const PEM_CAT_A = [
	"-----BEGIN PRIVATE KEY----- |",
	...KEY_LINES.map((line) => `${line} |`),
	"-----END PRIVATE KEY----- |",
].join("\n");

const HALF_CAP = Math.floor(MAX_SOURCE_ENTRY_CHARS / 2);
/** Tool output larger than the per-entry cap whose key block straddles the head cut: BEGIN is kept, END is dropped. */
const KEY_DUMP_OUTPUT = `${"x".repeat(HALF_CAP - 500)}\n${PEM_CAT_A}\n${"y".repeat(HALF_CAP + 5_000)}`;

function expectNoSecrets(value: string): void {
	for (const secret of SECRETS) expect(value).not.toContain(secret);
}

function expectNoKeyMaterial(value: string): void {
	expect(value).not.toContain("BEGIN PRIVATE KEY");
	for (const line of KEY_LINES) expect(value).not.toContain(line);
}

function userMessage(id: string, content: string): LedgerEntry {
	return messageEntry(id, "user", content);
}

function bashCall(id: string, command: string): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: TS,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: { command } }],
			timestamp: Date.parse(TS),
		},
	};
}

function bashResult(id: string, output: string): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: TS,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: Date.parse(TS),
		},
	};
}

/** A record stored before redaction was enabled (or by an older version): raw secret content. */
function storedObservation(
	id: string,
	content: string,
	sourceEntryIds: string[],
	relevance: Observation["relevance"] = "medium",
): Observation {
	return { id, content, timestamp: "2026-10-29 10:00", relevance, sourceEntryIds, tokenCount: estimateTextTokens(content) };
}

function storedReflection(id: string, content: string, supportingObservationIds: string[]): Reflection {
	return { id, content, supportingObservationIds, tokenCount: estimateTextTokens(content) };
}

function reflectionEntry(id: string, reflections: Reflection[], coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: OM_REFLECTIONS_RECORDED,
		timestamp: TS,
		data: { reflections, coversUpToId, createdAt: TS },
	};
}

function coverageOnlyEntry(id: string, coversUpToId: string): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		timestamp: TS,
		data: buildObservationCoverageData(coversUpToId, "empty"),
	};
}

function foldedDetails(observations: Observation[], droppedObservationIds: string[] = []): MemoryDetails {
	return {
		type: "ob-memory.folded",
		version: 1,
		fullFold: true,
		observations,
		reflections: [],
		droppedObservationIds,
		foldThroughEntryId: "e2",
	};
}

function compactionEntry(id: string, firstKeptEntryId: string, details: unknown): LedgerEntry {
	return { type: "compaction", id, timestamp: TS, summary: "summary", firstKeptEntryId, details };
}

const LEAKY_CONTENT = `User exported OPENAI_API_KEY=${API_KEY} and ran ${PASSWORD_COMMAND}.`;

const runtimes: SessionRuntime[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose("test");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** Harness with redaction on (the default), captured UI output, and timers that never fire. */
function harness(config: Parameters<typeof makeHarness>[0] = {}): Harness & { notifications: string[] } {
	const result = makeHarness({ redactSecrets: true, ...config });
	runtimes.push(result.runtime);
	const notifications: string[] = [];
	Object.assign(result.ctx, {
		hasUI: true,
		mode: "rpc",
		setTimeout: () => 0 as never,
		clearTimer: () => {},
	});
	Object.assign(result.ctx.ui, { notify: (message: string) => notifications.push(message) });
	return { ...result, notifications };
}

interface WorkerCall {
	tool: string;
	/** The request text ob-memory built (the first user message). */
	user: string;
}

/**
 * Worker stand-in that records the request ob-memory built for each stage and
 * answers with `respond`. Follow-up turns after a tool result end the loop.
 */
function recordingComplete(respond: (call: WorkerCall) => AssistantMessage = () => makeAssistant([text("Nothing new.")])) {
	const calls: WorkerCall[] = [];
	const complete = (async (
		_model: unknown,
		context: { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> },
	) => {
		const messages = context.messages;
		if (messages[messages.length - 1]?.role === "toolResult") return makeAssistant([text("done")]);
		const first = messages[0]?.content;
		const call = { tool: context.tools?.[0]?.name ?? "", user: typeof first === "string" ? first : JSON.stringify(first) };
		calls.push(call);
		return respond(call);
	}) as unknown as typeof completeSimple;
	return { complete, calls };
}

const resolved: ResolvedWorkerModel = {
	model: makeModel(),
	auth: { apiKey: "test-key" },
	thinking: "low",
	maxTokens: 4096,
	label: "test/test-model",
	fallbackUsed: false,
};

function compactEvent(entries: LedgerEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		branchEntries: [...entries],
		preparation: {
			firstKeptEntryId,
			tokensBefore: 12_000,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			fileOps: { read: new Set(), edited: new Set() },
			settings: {},
		},
		signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

const compactingEvent = { type: "session.compacting" as const, sessionId: "session-test", messages: [] };

type Handler = (event: never, ctx: ExtensionContext) => unknown;
interface CapturedTool {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

/** Fake host for the extension factory: handlers, tools and UI output, with timers that never fire. */
function loadExtension({ systemPrompt, ...options }: ObMemoryOptions & { systemPrompt?: string[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const tools: CapturedTool[] = [];
	const pi = {
		setLabel() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: CapturedTool) {
			tools.push(tool);
		},
		registerCommand() {},
		appendEntry() {},
		logger: { info() {}, warn() {}, error() {} },
		zod: piZod,
	} as unknown as ExtensionAPI;
	const instance = createObMemory({ agentDir: tempDir("ob-memory-agent-"), env: {}, ...options })(pi);
	const { ctx, entries } = makeHarness();
	const notifications: string[] = [];
	Object.assign(ctx, {
		cwd: tempDir("ob-memory-cwd-"),
		hasUI: true,
		setTimeout: () => 0 as never,
		clearTimer: () => {},
		...(systemPrompt ? { getSystemPrompt: () => systemPrompt } : {}),
	});
	Object.assign(ctx.ui, { notify: (message: string) => notifications.push(message) });
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event } as never, ctx);
	};
	return { instance, ctx, entries, notifications, tools, emit };
}

describe("worker prompts", () => {
	test("the consolidation observer prompt redacts each source entry before truncation and the prior memory", async () => {
		const { runtime, entries } = harness();
		// The dump really straddles the cut: unredacted, the cap keeps BEGIN and key lines and drops END.
		const unredacted = serializeEntry(bashResult("r2", KEY_DUMP_OUTPUT));
		expect(unredacted).toContain("BEGIN PRIVATE KEY");
		expect(unredacted).toContain(KEY_LINES[0]!);
		expect(unredacted).not.toContain("END PRIVATE KEY");
		entries.push(
			userMessage("u0", "Please use Postgres for this project."),
			observationEntry("o0", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["u0"])], "u0"),
			userMessage("u1", `Deploy with ${API_KEY} and keep it out of the logs.`),
			bashCall("a1", PASSWORD_COMMAND),
			bashResult("r1", "deployed"),
			bashCall("a2", "cat -A ~/.ssh/deploy_key"),
			bashResult("r2", KEY_DUMP_OUTPUT),
		);
		const { complete, calls } = recordingComplete();
		await consolidate(runtime, "manual", { force: true, complete });
		const observer = calls.filter((call) => call.tool === "record_observations");
		expect(observer).toHaveLength(1);
		const prompt = observer[0]!.user;
		expect(prompt).toContain("[Source entry id: r2]");
		expect(prompt).toContain("[REDACTED PRIVATE KEY]");
		expect(prompt).toContain("[REDACTED API KEY]");
		expect(prompt).toContain("[REDACTED CREDENTIAL]");
		expectNoSecrets(prompt);
		expectNoKeyMaterial(prompt);
	});

	test("the compaction catch-up observer prompt redacts each source entry before truncation", async () => {
		const { runtime, ctx, entries } = harness({ compactionMaxRetainedTokens: 0 });
		entries.push(
			userMessage("e1", "Please use Postgres for this project."),
			messageEntry("e2", "assistant", "Understood."),
			observationEntry("e3", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["e1"])], "e2"),
			bashCall("a4", PASSWORD_COMMAND),
			bashResult("r4", "deployed"),
			bashCall("a5", "cat -A ~/.ssh/deploy_key"),
			bashResult("r5", KEY_DUMP_OUTPUT),
			userMessage("e6", "Keep this tail."),
		);
		const { complete, calls } = recordingComplete();
		await handleSessionBeforeCompact(runtime, compactEvent(entries, "e6"), ctx, { complete });
		const observer = calls.filter((call) => call.tool === "record_observations");
		expect(observer.length).toBeGreaterThan(0);
		const prompt = observer[0]!.user;
		expect(prompt).toContain("[Source entry id: r5]");
		expect(prompt).toContain("[REDACTED PRIVATE KEY]");
		expectNoSecrets(prompt);
		expectNoKeyMaterial(prompt);
	});

	test("reflector and dropper prompts redact stored memory", async () => {
		const { runtime } = harness();
		const observations = [
			storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["u1"]),
			storedObservation("bbbbbbbbbbbb", `User pasted the token ${API_KEY} into the config.`, ["u2"], "low"),
		];
		const reflections = [storedReflection("cccccccccccc", `Deploys use ${PASSWORD_COMMAND}.`, ["aaaaaaaaaaaa"])];
		const { complete, calls } = recordingComplete();
		const signal = new AbortController().signal;
		await runReflector({ runtime, resolved, reflections, observations, signal, complete });
		await runDropper({ runtime, resolved, reflections, observations, targetTokens: 1, signal, complete });
		const reflector = calls.find((call) => call.tool === "record_reflections");
		const dropper = calls.find((call) => call.tool === "drop_observations");
		expect(reflector?.user).toContain("[aaaaaaaaaaaa]");
		expect(dropper?.user).toContain("[bbbbbbbbbbbb]");
		for (const call of [reflector!, dropper!]) {
			expect(call.user).toContain("[REDACTED");
			expectNoSecrets(call.user);
		}
	});
});

describe("stored memory and the owned compaction", () => {
	test("observations and reflections echoing a secret are stored redacted, and the summary and details stay clean", async () => {
		const { runtime, ctx, entries } = harness();
		entries.push(
			userMessage("u0", "Please use Postgres for this project."),
			observationEntry("o0", [storedObservation("aaaaaaaaaaaa", "User chose Postgres for the project database.", ["u0"])], "u0"),
			userMessage("u1", `Deploy with ${API_KEY}.`),
			bashCall("a1", PASSWORD_COMMAND),
			bashResult("r1", "deployed"),
		);
		const { complete } = recordingComplete((call) => {
			if (call.tool === "record_observations") {
				return makeAssistant(
					[
						makeToolCall("record_observations", {
							observations: [
								{
									timestamp: "2026-10-29 10:00",
									content: `User deployed with key ${API_KEY} after running ${PASSWORD_COMMAND}.`,
									relevance: "high",
									sourceEntryIds: ["u1", "a1"],
								},
							],
						}),
					],
					"toolUse",
				);
			}
			if (call.tool === "record_reflections") {
				return makeAssistant(
					[
						makeToolCall("record_reflections", {
							reflections: [
								{
									content: `Production deploys use key ${API_KEY} and ${PASSWORD_COMMAND}.`,
									supportingObservationIds: ["aaaaaaaaaaaa"],
								},
							],
						}),
					],
					"toolUse",
				);
			}
			return makeAssistant([text("Nothing to drop.")]);
		});
		const result = await consolidate(runtime, "manual", { force: true, complete });
		expect(result.observed).toBe(1);
		expect(result.reflected).toBe(1);

		const stored = entries.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.id !== "o0" &&
				(entry.customType === OM_OBSERVATIONS_RECORDED || entry.customType === OM_REFLECTIONS_RECORDED),
		);
		expect(stored.map((entry) => entry.customType)).toEqual([OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED]);
		for (const entry of stored) {
			const data = JSON.stringify(entry.data);
			expect(data).toContain("[REDACTED");
			expectNoSecrets(data);
		}

		entries.push(userMessage("u2", "Keep this tail."));
		const compacted = await handleSessionBeforeCompact(runtime, compactEvent(entries, "u2"), ctx);
		const compaction = compacted?.compaction;
		expect(compaction?.summary).toContain("[REDACTED");
		expectNoSecrets(compaction?.summary ?? "");
		expect((compaction?.details as MemoryDetails | undefined)?.reflections).toHaveLength(1);
		expectNoSecrets(JSON.stringify(compaction?.details));
	});

	test("the owned compaction summary redacts records stored before redaction was enabled", async () => {
		const { runtime, ctx } = harness();
		const entries = [
			userMessage("e1", "Please use Postgres for this project."),
			messageEntry("e2", "assistant", "Understood."),
			observationEntry("e3", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["e1"], "critical")], "e2"),
			userMessage("e4", "Keep this tail."),
		];
		const result = await handleSessionBeforeCompact(runtime, compactEvent(entries, "e4"), ctx);
		expect(result?.compaction?.summary).toContain("[REDACTED API KEY]");
		expectNoSecrets(result?.compaction?.summary ?? "");
	});

	test("the session.compacting fallback context is redacted", () => {
		const { runtime, ctx, entries } = harness();
		entries.push(
			userMessage("e1", "Please use Postgres for this project."),
			observationEntry("e2", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["e1"])], "e1"),
		);
		const result = handleSessionCompacting(runtime, compactingEvent, ctx);
		const context = result?.context?.[0] ?? "";
		expect(context).toContain("[REDACTED API KEY]");
		expectNoSecrets(context);
	});
});

describe("ob_recall", () => {
	function recallEntries(): LedgerEntry[] {
		// The key block straddles the head cut of the 4k-token recall source budget.
		const output = `${"a".repeat(7_500)}\n${PEM_CAT_A}\n${"z".repeat(12_000)}`;
		return [
			userMessage("e1", `Deploy with ${API_KEY}.`),
			bashCall("e2", PASSWORD_COMMAND),
			bashResult("e3", output),
			observationEntry("e4", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["e1", "e2", "e3"])], "e3"),
		];
	}

	test("recallMemory redacts the record and each source before truncating it", () => {
		// Unredacted, the recall budget keeps BEGIN and key lines and drops END.
		const raw = recallMemory(recallEntries(), "aaaaaaaaaaaa", { redact: false }).text;
		expect(raw).toContain(KEY_LINES[0]!);
		expect(raw).not.toContain("END PRIVATE KEY");
		const result = recallMemory(recallEntries(), "aaaaaaaaaaaa");
		expect(result.found).toBe(true);
		expect(result.sourceEntryIds).toEqual(["e1", "e2", "e3"]);
		expect(result.text).toContain("[REDACTED PRIVATE KEY]");
		expectNoSecrets(result.text);
		expectNoKeyMaterial(result.text);
		expectNoSecrets(JSON.stringify(result.details));
	});

	test("the ob_recall tool passes the session redaction setting through", async () => {
		const { tools, entries, ctx, emit } = loadExtension();
		await emit("session_start");
		entries.push(...recallEntries());
		const tool = tools.find((candidate) => candidate.name === "ob_recall");
		const result = await tool!.execute("call-1", { id: "aaaaaaaaaaaa" }, undefined, undefined, ctx);
		const output = result.content.map((block) => block.text).join("\n");
		expect(result.isError).toBe(false);
		expect(output).toContain("[REDACTED API KEY]");
		expectNoSecrets(output);
		expectNoKeyMaterial(output);
		expectNoSecrets(JSON.stringify(result.details));
		await emit("session_shutdown");
	});
});

describe("command output, notifications and the debug log", () => {
	const failingComplete = (async () => {
		throw new Error(`401 Unauthorized: Incorrect API key provided: ${API_KEY}`);
	}) as unknown as typeof completeSimple;

	test("/ob-memory status redacts the last error", async () => {
		const { runtime, ctx, entries, notifications } = harness();
		entries.push(userMessage("u1", "Please use Postgres for this project."));
		const result = await consolidate(runtime, "manual", { force: true, complete: failingComplete });
		expect(result.skipped).toBe("failed");
		await handleMemoryCommand(runtime, ctx, "status");
		const output = notifications.join("\n");
		expect(output).toContain("last error: consolidation: 401 Unauthorized");
		expect(output).toContain("[REDACTED API KEY]");
		expectNoSecrets(output);
	});

	test("/ob-memory view redacts visible and full memory", async () => {
		const { runtime, ctx, entries, notifications } = harness();
		entries.push(
			userMessage("e1", "Please use Postgres for this project."),
			observationEntry("e2", [storedObservation("aaaaaaaaaaaa", LEAKY_CONTENT, ["e1"])], "e1"),
		);
		await handleMemoryCommand(runtime, ctx, "view");
		await handleMemoryCommand(runtime, ctx, "view full");
		expect(notifications).toHaveLength(2);
		for (const output of notifications) {
			expect(output).toContain("[aaaaaaaaaaaa]");
			expect(output).toContain("[REDACTED API KEY]");
			expectNoSecrets(output);
		}
	});

	test("automatic notifications redact a model-unavailable reason", async () => {
		const { runtime, ctx, entries, notifications } = harness();
		Object.assign(ctx, {
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: false, error: `stored credential ${API_KEY} was rejected` }),
				resolveModelHeaders: async () => ({}),
			},
		});
		entries.push(userMessage("u1", "Please use Postgres for this project."));
		const { complete, calls } = recordingComplete();
		const result = await consolidate(runtime, "manual", { force: true, complete });
		expect(result.skipped).toBe("model_unavailable");
		expect(calls).toEqual([]);
		const output = notifications.join("\n");
		expect(output).toContain("model unavailable");
		expect(output).toContain("[REDACTED API KEY]");
		expectNoSecrets(output);
	});

	test("config warnings from the extension factory are redacted", async () => {
		const agentDir = tempDir("ob-memory-agent-");
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ model: API_KEY }));
		const { notifications, emit } = loadExtension({ agentDir });
		await emit("session_start");
		const warnings = notifications.filter((message) => message.startsWith("Observational Memory config:"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[REDACTED API KEY]");
		expectNoSecrets(warnings[0]!);
		await emit("session_shutdown");
	});

	test("the debug log redacts worker errors", async () => {
		const { instance, entries, emit } = loadExtension({ env: { OB_MEMORY_DEBUG_LOG: "true" } });
		await emit("session_start");
		const runtime = instance.runtime!;
		entries.push(userMessage("u1", "Please use Postgres for this project."));
		await consolidate(runtime, "manual", { force: true, complete: failingComplete });
		const log = readFileSync(runtime.debug.path, "utf8");
		expect(log).toContain('"event":"error"');
		expect(log).toContain("[REDACTED API KEY]");
		expectNoSecrets(log);
		await emit("session_shutdown");
	});
});

describe("integration wiring", () => {
	test("session.compacting injects again after an ob-memory compaction only for real new records", () => {
		const postgres = storedObservation("aaaaaaaaaaaa", "User chose Postgres for the project database.", ["e1"]);
		const plain = foldedDetails([postgres]);
		const rollover = { kind: "experimental-context-rollover", version: 1, hookDetails: plain };
		for (const details of [plain, rollover]) {
			const { runtime, ctx, entries } = harness();
			entries.push(
				userMessage("e1", "Please use Postgres for this project."),
				messageEntry("e2", "assistant", "Understood."),
				observationEntry("o1", [postgres], "e2"),
				compactionEntry("c1", "e3", details),
				userMessage("e3", "Routine check-in."),
				coverageOnlyEntry("o2", "e3"),
			);
			// A coverage-only marker adds nothing the ob-memory summary lacks.
			expect(handleSessionCompacting(runtime, compactingEvent, ctx)).toBeUndefined();

			const redis = storedObservation("dddddddddddd", "User switched the cache to Redis.", ["e4"]);
			entries.push(userMessage("e4", "Switch the cache to Redis."), observationEntry("o3", [redis], "e4"));
			const context = handleSessionCompacting(runtime, compactingEvent, ctx)?.context?.[0];
			expect(context).toContain("Redis");
		}
	});

	test("latestCompactionDetails and visibleProjection unwrap the host rollover details", async () => {
		const kept = storedObservation("aaaaaaaaaaaa", "User chose Postgres for the project database.", ["e1"]);
		const dropped = storedObservation("bbbbbbbbbbbb", "User asked for a status update.", ["e1"], "low");
		const details = foldedDetails([kept, dropped], [dropped.id]);
		const base = [
			userMessage("e1", "Please use Postgres for this project."),
			messageEntry("e2", "assistant", "Understood."),
			observationEntry("o1", [kept, dropped], "e2"),
		];
		const rollover = [
			...base,
			compactionEntry("c1", "e3", { kind: "experimental-context-rollover", version: 1, hookDetails: details }),
			userMessage("e3", "Keep this tail."),
		];
		expect(latestCompactionDetails(rollover)).toEqual(details);
		expect(visibleProjection(rollover)).toEqual({
			observations: [kept],
			reflections: [],
			droppedObservationIds: [dropped.id],
		});

		const { runtime, ctx, entries, notifications } = harness();
		entries.push(...rollover);
		await handleMemoryCommand(runtime, ctx, "view");
		expect(notifications[0]).toContain("visible memory: 1 active observations");
		expect(notifications[0]).toContain("Postgres");

		// A rollover the host summarized itself carries no ob-memory details.
		const native = [
			...base,
			compactionEntry("c1", "e3", { kind: "experimental-context-rollover", version: 1 }),
			userMessage("e3", "Keep this tail."),
		];
		expect(latestCompactionDetails(native)).toBeUndefined();
		expect(visibleProjection(native).observations).toEqual([]);
	});

	test("bindSession pauses automatic passes when omp Hide Secrets is active, and only then", async () => {
		const notice = "- `$$HASH$$`, `$$HASH:CASE$$`, `$$NAME_HASH:CASE$$` output tokens: opaque strings.";
		const paused = (messages: string[]) => messages.filter((message) => message.includes("automatic memory passes are paused"));
		const warned = (messages: string[]) => messages.filter((message) => message.includes("'Hide Secrets' is on"));

		// Default pauseOnHostSecrets: worker requests would bypass the host
		// obfuscation, so the session goes passive instead of only warning.
		const active = loadExtension({ systemPrompt: ["You are a coding agent.", notice] });
		await active.emit("session_start");
		expect(paused(active.notifications)).toHaveLength(1);
		expect(warned(active.notifications)).toEqual([]);
		expect(active.instance.runtime?.config.passive).toBe(true);
		expect(active.instance.runtime?.hostSecretsPause).toBe("paused");
		await active.emit("session_shutdown");

		const inactive = loadExtension({ systemPrompt: ["You are a coding agent. Mention $$HASH$$ once."] });
		await inactive.emit("session_start");
		expect(paused(inactive.notifications)).toEqual([]);
		expect(warned(inactive.notifications)).toEqual([]);
		expect(inactive.instance.runtime?.config.passive).toBe(false);
		expect(inactive.instance.runtime?.hostSecretsPause).toBeUndefined();
		await inactive.emit("session_shutdown");

		// A configured-passive session is marked paused too, so a later
		// `passive off` is an explicit override that warns.
		const passive = loadExtension({ systemPrompt: [notice], env: { OB_MEMORY_PASSIVE: "true" } });
		await passive.emit("session_start");
		expect(passive.instance.runtime?.hostSecretsPause).toBe("paused");
		expect(warned(passive.notifications)).toEqual([]);
		await passive.emit("session_shutdown");
	});

	test("with pauseOnHostSecrets false, bindSession only warns, and only when workers may run", async () => {
		const notice = "- `$$HASH$$`, `$$HASH:CASE$$`, `$$NAME_HASH:CASE$$` output tokens: opaque strings.";
		const warned = (messages: string[]) => messages.filter((message) => message.includes("'Hide Secrets' is on"));

		const active = loadExtension({ systemPrompt: [notice], env: { OB_MEMORY_PAUSE_ON_HOST_SECRETS: "false" } });
		await active.emit("session_start");
		expect(warned(active.notifications)).toHaveLength(1);
		expect(active.instance.runtime?.config.passive).toBe(false);
		expect(active.instance.runtime?.hostSecretsPause).toBeUndefined();
		await active.emit("session_shutdown");

		// Passive mode sends nothing to a worker, so there is nothing to warn about yet.
		const passive = loadExtension({
			systemPrompt: [notice],
			env: { OB_MEMORY_PASSIVE: "true", OB_MEMORY_PAUSE_ON_HOST_SECRETS: "false" },
		});
		await passive.emit("session_start");
		expect(warned(passive.notifications)).toEqual([]);
		await passive.emit("session_shutdown");
	});

	test("agentMaxTokens is clamped to the worker output ceiling from model.ts", async () => {
		const cwd = tempDir("ob-memory-cwd-");
		const agentDir = tempDir("ob-memory-agent-");
		const over = loadConfig({ cwd, agentDir, env: { OB_MEMORY_AGENT_MAX_TOKENS: String(MAX_WORKER_OUTPUT_TOKENS + 1) } });
		expect(over.config.agentMaxTokens).toBe(MAX_WORKER_OUTPUT_TOKENS);
		expect(over.warnings).toEqual([
			`environment: agentMaxTokens (${MAX_WORKER_OUTPUT_TOKENS + 1}) exceeds the supported maximum; clamped to ${MAX_WORKER_OUTPUT_TOKENS}`,
		]);
		const atCap = loadConfig({ cwd, agentDir, env: { OB_MEMORY_AGENT_MAX_TOKENS: String(MAX_WORKER_OUTPUT_TOKENS) } });
		expect(atCap.config.agentMaxTokens).toBe(MAX_WORKER_OUTPUT_TOKENS);
		expect(atCap.warnings).toEqual([]);

		// The clamp matches the per-request ceiling the resolver applies.
		const { ctx } = makeHarness();
		const big = makeModel({ maxTokens: 128_000 });
		Object.assign(ctx, { models: { current: () => big, resolve: () => big } });
		const worker = await resolveWorkerModel(ctx, over.config, new AbortController().signal);
		expect(worker.ok && worker.value.maxTokens).toBe(over.config.agentMaxTokens);
	});
});

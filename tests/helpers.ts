import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	AssistantMessage,
	Model,
	StopReason,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";
import { DEFAULT_CONFIG, type ObMemoryConfig } from "../src/config-types";
import type { LedgerEntry, Observation } from "../src/ledger/types";
import { SessionRuntime } from "../src/runtime";
import { estimateTextTokens } from "../src/constants";

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function makeAssistant(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: { ...ZERO_USAGE },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

export function makeToolCall(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

export function text(value: string) {
	return { type: "text" as const, text: value };
}

export function makeModel(overrides: Partial<Model> = {}): Model {
	return {
		provider: "test",
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	} as Model;
}

export interface Harness {
	runtime: SessionRuntime;
	entries: LedgerEntry[];
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}

export function makeHarness(config: Partial<ObMemoryConfig> = {}): Harness {
	const entries: LedgerEntry[] = [];
	let sequence = 0;
	const model = makeModel();
	const pi = {
		appendEntry(customType: string, data?: unknown) {
			entries.push({
				type: "custom",
				id: `e${++sequence}`,
				customType,
				data,
				timestamp: new Date().toISOString(),
			});
		},
		setLabel() {},
		on() {},
		registerTool() {},
		registerCommand() {},
		logger: { info() {}, warn() {}, error() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp/ob-memory-test",
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		hasUI: false,
		mode: "print",
		model,
		models: {
			current: () => model,
			resolve: () => model,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
			resolveModelHeaders: async () => ({}),
		},
		sessionManager: {
			getSessionId: () => "session-test",
			getBranch: () => entries,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
		},
		isIdle: () => true,
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimer: (timer: Timer) => clearTimeout(timer),
		ui: {
			notify() {},
			editor: async () => undefined,
		},
	} as unknown as ExtensionContext;
	const runtime = new SessionRuntime(
		pi,
		ctx,
		{ ...DEFAULT_CONFIG, debugLog: false, ...config },
		"/tmp/ob-memory-test-agent",
	);
	return { runtime, entries, ctx, pi };
}

export function messageEntry(id: string, role: "user" | "assistant", content: string): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: new Date("2026-10-29T10:00:00Z").toISOString(),
		message: {
			role,
			content: [{ type: "text", text: content }],
			timestamp: Date.parse("2026-10-29T10:00:00Z"),
		},
	};
}

export function observationRecord(
	id: string,
	sourceEntryIds: string[],
	coversUpToId: string,
	content = "User stated the project uses Postgres.",
): Observation {
	return {
		id,
		content,
		timestamp: "2026-10-29 10:00",
		relevance: "medium" as const,
		sourceEntryIds,
		tokenCount: estimateTextTokens(content),
	};
}

export function observationEntry(
	id: string,
	observations: Observation[],
	coversUpToId: string,
): LedgerEntry {
	return {
		type: "custom",
		id,
		customType: "ob-memory.observations.recorded",
		timestamp: new Date().toISOString(),
		data: { observations, coversUpToId, createdAt: new Date().toISOString() },
	};
}

export function scriptedComplete(scripts: AssistantMessage[]): typeof import("@oh-my-pi/pi-ai").completeSimple {
	let index = 0;
	return (async () => {
		const message = scripts[Math.min(index, scripts.length - 1)];
		index++;
		if (!message) throw new Error("scriptedComplete has no messages");
		return message;
	}) as typeof import("@oh-my-pi/pi-ai").completeSimple;
}

/**
 * Observer stand-in for multi-pass tests: each run records one observation
 * citing the first source entry of the chunk in its prompt, then stops after
 * the tool result. `hold(call)` can delay a call (1-based) to keep a pass in
 * flight; `prompts` keeps every prompt it was sent.
 */
export function citingObserverComplete(hold?: (call: number) => Promise<void>): {
	complete: typeof import("@oh-my-pi/pi-ai").completeSimple;
	calls: () => number;
	prompts: string[];
} {
	let calls = 0;
	const prompts: string[] = [];
	const complete = (async (_model: unknown, context: { messages: Array<{ role?: string }> }) => {
		const call = ++calls;
		const prompt = JSON.stringify(context.messages);
		prompts.push(prompt);
		if (hold) await hold(call);
		if (context.messages.at(-1)?.role === "toolResult") return makeAssistant([text("Done.")]);
		const chunk = prompt.split("NEW CONVERSATION CHUNK:").at(-1) ?? "";
		const id = /\[Source entry id: ([^\]]+)\]/.exec(chunk)?.[1] ?? "missing";
		return makeAssistant(
			[
				makeToolCall("record_observations", {
					observations: [
						{
							timestamp: "2026-10-29 10:00",
							content: `Billing migration step ${id} uses Postgres 16 with its own pool size.`,
							relevance: "high",
							sourceEntryIds: [id],
						},
					],
				}),
			],
			"toolUse",
		);
	}) as unknown as typeof import("@oh-my-pi/pi-ai").completeSimple;
	return { complete, calls: () => calls, prompts };
}

/** `count` alternating user/assistant source entries `m1`… of roughly 180 tokens each. */
export function backlogEntries(count: number): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	for (let i = 1; i <= count; i++) {
		entries.push(
			messageEntry(
				`m${i}`,
				i % 2 ? "user" : "assistant",
				`Turn ${i}: the billing service migration step ${i} uses Postgres 16, connection pool size ${i * 10}, and a retry budget of ${i} attempts. `.repeat(6),
			),
		);
	}
	return entries;
}

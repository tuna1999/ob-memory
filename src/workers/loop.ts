import {
	completeSimple,
	type AssistantMessage,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TJsonSchema,
	type Tool,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "../config-types";
import type { WorkerAuth } from "./model";

export class WorkerModelError extends Error {
	readonly stopReason: string;
	constructor(stage: string, stopReason: string, message?: string) {
		super(`${stage} model call ended with ${stopReason}${message ? `: ${message}` : ""}`);
		this.name = "WorkerModelError";
		this.stopReason = stopReason;
	}
}

export interface WorkerToolResult {
	text: string;
	details?: unknown;
	isError?: boolean;
}

export interface WorkerTool {
	name: string;
	description: string;
	parameters: TJsonSchema;
	execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<WorkerToolResult>;
}

export interface WorkerLoopOptions {
	stage: string;
	model: Model;
	auth: WorkerAuth;
	thinking: ThinkingLevel;
	maxTokens: number;
	maxTurns: number;
	system: string;
	user: string;
	tool: WorkerTool;
	signal: AbortSignal;
	sessionId?: string;
	onUsage?: (usage: Usage, message: AssistantMessage) => void;
	complete?: typeof completeSimple;
	/**
	 * Called when a provider call fails (an error stop or a thrown call). When
	 * it returns true the loop returns the partial result with `failed` set
	 * instead of throwing, so records the stage already accepted on earlier
	 * turns are kept. Never consulted once `signal` is aborted.
	 */
	keepPartialOnError?: () => boolean;
	/**
	 * Called before every provider call. Each turn resends the whole request,
	 * so the Hide Secrets guard runs here too; it aborts `signal` to stop.
	 */
	beforeTurn?: () => void;
}

export interface WorkerLoopResult {
	records: WorkerToolResult[];
	toolCallCount: number;
	usage: Usage[];
	stopReason: string;
	finalText: string;
	turns: number;
	/** The model still had tool calls when maxTurns stopped the loop. */
	exhausted: boolean;
	/** At least one assistant response ended with `stopReason: "length"`. */
	truncated: boolean;
	/** A later provider call failed and `keepPartialOnError` kept the earlier results. */
	failed?: boolean;
	/** The failure that ended a `failed` loop. */
	errorMessage?: string;
}

const LENGTH_STOP_NOTE =
	"This response hit the output token limit, so the call may be incomplete: send fewer, shorter items per call.";

function hasParseError(args: unknown): boolean {
	return !!args && typeof args === "object" && "__parseError" in args;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const MAX_LISTED_REJECTIONS = 5;

/**
 * Per-item rejection reasons for a tool result, capped so a large bad batch
 * cannot flood the worker context. Reasons are local fixed strings, never
 * echoed model content.
 */
export function formatRejections(reasons: readonly string[]): string {
	const listed = reasons.slice(0, MAX_LISTED_REJECTIONS).join("; ");
	const more = reasons.length - MAX_LISTED_REJECTIONS;
	return more > 0 ? `${listed}; and ${more} more` : listed;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}

/**
 * One provider call plus our own tool loop. Tools are executed locally and
 * validated by the stage, so a malformed model proposal is returned as an
 * error result instead of being trusted.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<WorkerLoopResult> {
	const messages: Message[] = [
		{ role: "user", content: options.user, timestamp: Date.now() },
	];
	const tool: Tool = {
		name: options.tool.name,
		description: options.tool.description,
		parameters: options.tool.parameters,
		strict: true,
	};
	const reasoning = options.thinking === "off" ? undefined : (options.thinking as NonNullable<SimpleStreamOptions["reasoning"]>);
	const records: WorkerToolResult[] = [];
	const usage: Usage[] = [];
	let toolCallCount = 0;
	let stopReason = "stop";
	let finalText = "";
	let turns = 0;
	let exhausted = false;
	let truncated = false;
	let failed = false;
	let errorMessage: string | undefined;
	const maxTurns = Math.max(1, options.maxTurns);

	for (let turn = 0; turn < maxTurns; turn++) {
		options.signal.throwIfAborted();
		options.beforeTurn?.();
		options.signal.throwIfAborted();
		turns++;
		const complete = options.complete ?? completeSimple;
		let assistant: AssistantMessage;
		try {
			assistant = await complete(
				options.model,
				{ systemPrompt: [options.system], messages, tools: [tool] },
				{
					apiKey: options.auth.apiKey,
					headers: options.auth.headers,
					maxTokens: options.maxTokens,
					signal: options.signal,
					sessionId: options.sessionId,
					...(reasoning ? { reasoning } : { disableReasoning: true }),
				},
			);
		} catch (error) {
			options.signal.throwIfAborted();
			if (!options.keepPartialOnError?.()) throw error;
			stopReason = "error";
			failed = true;
			errorMessage = errorText(error);
			break;
		}
		stopReason = assistant.stopReason;
		if (assistant.stopReason === "length") truncated = true;
		finalText = assistantText(assistant);
		usage.push(assistant.usage);
		options.onUsage?.(assistant.usage, assistant);
		options.signal.throwIfAborted();
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			const error = new WorkerModelError(options.stage, assistant.stopReason, assistant.errorMessage);
			if (!options.keepPartialOnError?.()) throw error;
			failed = true;
			errorMessage = error.message;
			break;
		}
		messages.push(assistant);

		const calls = assistant.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) break;
		for (const call of calls) {
			options.signal.throwIfAborted();
			toolCallCount++;
			let result: WorkerToolResult;
			if (call.name !== options.tool.name) {
				result = {
					text: `Unknown tool ${call.name}; only ${options.tool.name} is available.`,
					isError: true,
				};
			} else {
				const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
				if (hasParseError(args)) {
					// pi-ai substitutes `{__parseError, __rawJson}` for arguments that
					// are not valid JSON, typically a call cut off by the output limit.
					result = {
						text:
							assistant.stopReason === "length"
								? `Tool call arguments were cut off by the output token limit and are not valid JSON; nothing was recorded. Send fewer, shorter items per call.`
								: `Tool call arguments are not valid JSON; nothing was recorded. Resend a smaller, well-formed call.`,
						isError: true,
					};
				} else {
					try {
						result = await options.tool.execute(args, options.signal);
					} catch (error) {
						result = {
							text: `Tool rejected the call: ${errorText(error)}`,
							isError: true,
						};
					}
					if (assistant.stopReason === "length") result = { ...result, text: `${result.text} ${LENGTH_STOP_NOTE}` };
				}
			}
			records.push(result);
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: result.text }],
				details: result.details,
				isError: result.isError === true,
				timestamp: Date.now(),
			};
			messages.push(toolResult);
		}
		if (turn + 1 >= maxTurns) exhausted = true;
	}

	return {
		records,
		toolCallCount,
		usage,
		stopReason,
		finalText,
		turns,
		exhausted,
		truncated,
		...(failed ? { failed, errorMessage } : {}),
	};
}

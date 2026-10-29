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
	const maxTurns = Math.max(1, options.maxTurns);

	for (let turn = 0; turn < maxTurns; turn++) {
		options.signal.throwIfAborted();
		turns++;
		const complete = options.complete ?? completeSimple;
		const assistant = await complete(
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
		stopReason = assistant.stopReason;
		if (assistant.stopReason === "length") truncated = true;
		finalText = assistantText(assistant);
		usage.push(assistant.usage);
		options.onUsage?.(assistant.usage, assistant);
		options.signal.throwIfAborted();
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			throw new WorkerModelError(options.stage, assistant.stopReason, assistant.errorMessage);
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
				try {
					const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
					result = await options.tool.execute(args, options.signal);
				} catch (error) {
					result = {
						text: `Tool rejected the call: ${error instanceof Error ? error.message : String(error)}`,
						isError: true,
					};
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

	return { records, toolCallCount, usage, stopReason, finalText, turns, exhausted, truncated };
}

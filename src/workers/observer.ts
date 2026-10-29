import { completeSimple, type TJsonSchema, type Usage } from "@oh-my-pi/pi-ai";
import { OBSERVATION_TIMESTAMP_PATTERN } from "../constants";
import { hashMemoryId, normalizeRecordContent } from "../util/ids";
import { formatLocalTimestamp } from "../util/time";
import { observationLineTokens, type Observation, type Reflection } from "../ledger/types";
import { isLowValueRecordContent } from "../ledger/quality";
import { renderMemory } from "../ledger/render";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { OBSERVER_SYSTEM } from "./prompts";

const OBSERVATIONS_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["observations"],
	properties: {
		observations: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["timestamp", "content", "relevance", "sourceEntryIds"],
				properties: {
					timestamp: {
						type: "string",
						pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$",
						description: "Observation time in local YYYY-MM-DD HH:MM format.",
					},
					content: {
						type: "string",
						minLength: 1,
						description: "One line of plain prose. No markdown, timestamp, or relevance field.",
					},
					relevance: { type: "string", enum: ["low", "medium", "high", "critical"] },
					sourceEntryIds: {
						type: "array",
						minItems: 1,
						items: { type: "string", minLength: 1 },
						description: "Exact source entry ids from the chunk that support this observation.",
					},
				},
			},
		},
	},
};

export interface RunObserverOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	reflections: readonly Reflection[];
	observations: readonly Observation[];
	chunk: string;
	allowedSourceEntryIds: readonly string[];
	existingObservationIds?: readonly string[];
	signal: AbortSignal;
	complete?: typeof completeSimple;
}

interface RawObservation {
	timestamp?: unknown;
	content?: unknown;
	relevance?: unknown;
	sourceEntryIds?: unknown;
}

function isRawObservation(value: unknown): value is RawObservation {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceIds(value: unknown, allowed: readonly string[]): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const allowedSet = new Set(allowed);
	const order = new Map(allowed.map((id, index) => [id, index]));
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || !allowedSet.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function makeRecord(
	raw: RawObservation,
	allowedSourceIds: readonly string[],
	existingIds: ReadonlySet<string>,
	redact: boolean,
): { observation?: Observation; reason?: string } {
	if (typeof raw.timestamp !== "string" || !OBSERVATION_TIMESTAMP_PATTERN.test(raw.timestamp)) {
		return { reason: "invalid timestamp; use YYYY-MM-DD HH:MM" };
	}
	if (typeof raw.content !== "string" || !raw.content.trim()) return { reason: "empty content" };
	if (
		raw.relevance !== "low" &&
		raw.relevance !== "medium" &&
		raw.relevance !== "high" &&
		raw.relevance !== "critical"
	) {
		return { reason: "invalid relevance" };
	}
	const sourceEntryIds = normalizeSourceIds(raw.sourceEntryIds, allowedSourceIds);
	if (!sourceEntryIds) return { reason: "invalid sourceEntryIds; cite only ids shown in the chunk" };
	const normalized = normalizeRecordContent(raw.content);
	const content = redact ? redactText(normalized) : normalized;
	if (!content) return { reason: "empty content" };
	if (isLowValueRecordContent(content)) return { reason: "content is empty filler" };
	const id = hashMemoryId(content, raw.timestamp, sourceEntryIds, existingIds);
	return {
		observation: {
			id,
			content,
			timestamp: raw.timestamp,
			relevance: raw.relevance,
			sourceEntryIds,
			tokenCount: observationLineTokens({ id, content, timestamp: raw.timestamp, relevance: raw.relevance }),
		},
	};
}

/**
 * Distill one source chunk into observations. The model never controls ids or
 * token counts, and every proposal is validated against the exact source ids
 * that were sent in this chunk.
 */
export async function runObserver(options: RunObserverOptions): Promise<Observation[] | undefined> {
	const { runtime, resolved, reflections, observations, chunk, allowedSourceEntryIds, signal } = options;
	const priorMemory = renderMemory(reflections, observations, {
		maxTokens: runtime.config.workerMemoryMaxTokens,
		estimate: runtime.estimator,
	}).text;
	const accepted = new Map<string, Observation>();
	const existingIds = new Set([
		...observations.map((observation) => observation.id),
		...(options.existingObservationIds ?? []),
	]);
	const currentTime = formatLocalTimestamp();
	let rejected = 0;
	let duplicates = 0;

	const tool = {
		name: "record_observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk. Call again if content remains uncovered; stop calling and reply briefly when the chunk is covered.",
		parameters: OBSERVATIONS_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const rawList = args.observations;
			if (!Array.isArray(rawList)) {
				return { text: "Invalid arguments: observations must be an array.", isError: true };
			}
			let added = 0;
			for (const raw of rawList) {
				if (!isRawObservation(raw)) {
					rejected++;
					continue;
				}
				const result = makeRecord(
					raw,
					allowedSourceEntryIds,
					new Set([...existingIds, ...accepted.keys()]),
					runtime.config.redactSecrets,
				);
				if (!result.observation) {
					rejected++;
					continue;
				}
				if (accepted.has(result.observation.id) || existingIds.has(result.observation.id)) {
					duplicates++;
					continue;
				}
				accepted.set(result.observation.id, result.observation);
				added++;
			}
			return {
				text:
					`Recorded ${added} new observation${added === 1 ? "" : "s"}` +
					(duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "") +
					(rejected > 0 ? `; ${rejected} rejected for invalid fields` : "") +
					`. Total this run: ${accepted.size}. Continue if content remains; otherwise reply briefly and stop.`,
				details: { added, duplicates, rejected, total: accepted.size },
			};
		},
	};

	const rawUser = `Current local time: ${currentTime}

CURRENT MEMORY:
${priorMemory || "(none yet)"}

NEW CONVERSATION CHUNK:
${chunk}`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	let usage: Usage[] = [];
	const result = await runWorkerLoop({
		stage: "observer",
		model: resolved.model,
		auth: resolved.auth,
		thinking: resolved.thinking,
		maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
		maxTurns: runtime.config.agentMaxTurns,
		system: OBSERVER_SYSTEM,
		user,
		tool,
		signal,
		sessionId: runtime.sessionId,
		complete: options.complete,
		onUsage: (item) => {
			usage.push(item);
		},
	});
	for (const item of usage) runtime.debug.usage("observer", resolved.label, item);
	const values = Array.from(accepted.values());
	if (values.length === 0) {
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(`observer ended with ${result.stopReason}`);
		}
		runtime.debug.record("observer", "empty", { toolCalls: result.toolCallCount, rejected, duplicates });
		return undefined;
	}
	runtime.debug.record("observer", "recorded", {
		count: values.length,
		tokens: values.reduce((total, observation) => total + observation.tokenCount, 0),
		turns: result.turns,
	});
	return values;
}

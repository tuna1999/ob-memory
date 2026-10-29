import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../constants";
import { hashMemoryId, normalizeRecordContentStrict } from "../util/ids";
import { observationLine, reflectionLine, type Observation, type Reflection } from "../ledger/types";
import { isLowValueRecordContent } from "../ledger/quality";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { REFLECTOR_SYSTEM } from "./prompts";

const REFLECTIONS_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["reflections"],
	properties: {
		reflections: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["content", "supportingObservationIds"],
				properties: {
					content: {
						type: "string",
						minLength: 1,
						description: "One durable fact or pattern in plain prose.",
					},
					supportingObservationIds: {
						type: "array",
						minItems: 1,
						items: { type: "string", minLength: 1 },
						description: "Exact active observation ids whose durable meaning this reflection preserves.",
					},
				},
			},
		},
	},
};

export interface RunReflectorOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	reflections: readonly Reflection[];
	observations: readonly Observation[];
	signal: AbortSignal;
	complete?: typeof completeSimple;
}

function coverageTier(observationId: string, reflections: readonly Reflection[]): "none" | "partial" | "strong" {
	let count = 0;
	for (const reflection of reflections) {
		if (reflection.supportingObservationIds.includes(observationId)) count++;
		if (count >= 2) return "strong";
	}
	return count === 1 ? "partial" : "none";
}

function boundedContext(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	maxTokens: number,
): string {
	const reflectionLines = reflections.map(reflectionLine);
	const observationLines = observations.map(
		(observation) => `${observationLine(observation)} [coverage: ${coverageTier(observation.id, reflections)}]`,
	);
	let tokens = estimateTextTokens("CURRENT REFLECTIONS:\nCURRENT OBSERVATIONS:\n(none yet)");
	const selectedReflections: string[] = [];
	for (const line of reflectionLines) {
		const cost = estimateTextTokens(line) + 1;
		if (tokens + cost > maxTokens) break;
		selectedReflections.push(line);
		tokens += cost;
	}
	const selectedObservations: string[] = [];
	for (let i = observationLines.length - 1; i >= 0; i--) {
		const line = observationLines[i]!;
		const cost = estimateTextTokens(line) + 1;
		if (tokens + cost > maxTokens) continue;
		selectedObservations.unshift(line);
		tokens += cost;
	}
	return `CURRENT REFLECTIONS:\n${selectedReflections.length > 0 ? selectedReflections.join("\n") : "(none yet)"}\n\nCURRENT OBSERVATIONS:\n${selectedObservations.length > 0 ? selectedObservations.join("\n") : "(none yet)"}`;
}

function normalizeSupportIds(value: unknown, observations: readonly Observation[]): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const order = new Map(observations.map((observation, index) => [observation.id, index]));
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || !order.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Crystallize durable reflections from active observations. Zero reflections
 * is a valid outcome; a run that proposes none appends nothing.
 */
export async function runReflector(options: RunReflectorOptions): Promise<Reflection[] | undefined> {
	const { runtime, resolved, reflections: priorReflections, observations, signal } = options;
	if (observations.length === 0) return undefined;

	const existing = new Map(priorReflections.map((reflection) => [reflection.id, reflection]));
	const accepted = new Map<string, Reflection>();
	let rejected = 0;
	let duplicates = 0;

	const tool = {
		name: "record_reflections",
		description:
			"Record new durable reflections with supporting active observation ids. Do not call this tool when no new durable fact is justified.",
		parameters: REFLECTIONS_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const rawList = args.reflections;
			if (!Array.isArray(rawList)) {
				return { text: "Invalid arguments: reflections must be an array.", isError: true };
			}
			let added = 0;
			for (const raw of rawList) {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					rejected++;
					continue;
				}
				const record = raw as Record<string, unknown>;
				const rawContent = typeof record.content === "string" ? normalizeRecordContentStrict(record.content) : undefined;
				const content = rawContent && runtime.config.redactSecrets ? redactText(rawContent) : rawContent;
				const supportingObservationIds = normalizeSupportIds(record.supportingObservationIds, observations);
				if (!content || isLowValueRecordContent(content) || !supportingObservationIds) {
					rejected++;
					continue;
				}
				const id = hashMemoryId(content, "", supportingObservationIds, new Set([...existing.keys(), ...accepted.keys()]));
				if (existing.has(id) || accepted.has(id)) {
					duplicates++;
					continue;
				}
				accepted.set(id, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateTextTokens(content),
				});
				added++;
			}
			return {
				text:
					`Recorded ${added} new reflection${added === 1 ? "" : "s"}` +
					(duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "") +
					(rejected > 0 ? `; ${rejected} rejected for invalid fields` : "") +
					`. Total this run: ${accepted.size}.`,
				details: { added, duplicates, rejected, total: accepted.size },
			};
		},
	};

	const rawUser = `${boundedContext(priorReflections, observations, runtime.config.workerMemoryMaxTokens)}

Crystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	const result = await runWorkerLoop({
		stage: "reflector",
		model: resolved.model,
		auth: resolved.auth,
		thinking: resolved.thinking,
		maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
		maxTurns: runtime.config.agentMaxTurns,
		system: REFLECTOR_SYSTEM,
		user,
		tool,
		signal,
		sessionId: runtime.sessionId,
		complete: options.complete,
		onUsage: (usage) => runtime.debug.usage("reflector", resolved.label, usage),
	});
	const values = Array.from(accepted.values());
	if (values.length === 0) {
		runtime.debug.record("reflector", "empty", { toolCalls: result.toolCallCount, rejected, duplicates });
		return undefined;
	}
	runtime.debug.record("reflector", "recorded", { count: values.length, turns: result.turns });
	return values;
}

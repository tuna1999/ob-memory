import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { WORKER_OBSERVATIONS_MIN_SHARE, estimateTextTokens } from "../constants";
import { hashMemoryId, normalizeRecordContentStrict } from "../util/ids";
import { observationLine, reflectionLine, type Observation, type Reflection } from "../ledger/types";
import { isLowValueRecordContent } from "../ledger/quality";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { formatRejections, runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { REFLECTOR_SYSTEM } from "./prompts";
import { resolveWorkerMemoryMaxTokens } from "../config";

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

interface BoundedContext {
	text: string;
	observationIds: ReadonlySet<string>;
}

/** Newest-first selection within `budget`; a line that does not fit is skipped, not a stop marker. */
function selectNewestWithinBudget(lines: readonly string[], budget: number): { indexes: number[]; tokens: number } {
	const indexes: number[] = [];
	let tokens = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const cost = estimateTextTokens(lines[i]!) + 1;
		if (tokens + cost > budget) continue;
		indexes.unshift(i);
		tokens += cost;
	}
	return { indexes, tokens };
}

/**
 * Fit reflections and observations into `maxTokens`. Observations are the
 * records the reflector cites, so they keep at least
 * WORKER_OBSERVATIONS_MIN_SHARE of the budget; reflections take the rest and
 * either side reclaims what the other leaves unused. Newest records win.
 */
function boundedContext(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	maxTokens: number,
): BoundedContext {
	const reflectionLines = reflections.map(reflectionLine);
	const observationLines = observations.map(
		(observation) => `${observationLine(observation)} [coverage: ${coverageTier(observation.id, reflections)}]`,
	);
	const available = Math.max(
		0,
		maxTokens - estimateTextTokens("CURRENT REFLECTIONS:\nCURRENT OBSERVATIONS:\n(none yet)"),
	);
	const reserved = selectNewestWithinBudget(observationLines, Math.floor(available * WORKER_OBSERVATIONS_MIN_SHARE));
	const pickedReflections = selectNewestWithinBudget(reflectionLines, available - reserved.tokens);
	const pickedObservations = selectNewestWithinBudget(observationLines, available - pickedReflections.tokens);
	const selectedReflections = pickedReflections.indexes.map((index) => reflectionLines[index]!);
	const selectedObservations = pickedObservations.indexes.map((index) => observationLines[index]!);
	const observationIds = new Set(pickedObservations.indexes.map((index) => observations[index]!.id));
	return {
		text: `CURRENT REFLECTIONS:\n${selectedReflections.length > 0 ? selectedReflections.join("\n") : "(none yet)"}\n\nCURRENT OBSERVATIONS:\n${selectedObservations.length > 0 ? selectedObservations.join("\n") : "(none yet)"}`,
		observationIds,
	};
}

function reflectionSignature(content: string, supportingObservationIds: readonly string[]): string {
	return `${content}\u0000${supportingObservationIds.join(",")}`;
}

function normalizeSupportIds(
	value: unknown,
	observations: readonly Observation[],
	allowedIds: ReadonlySet<string>,
): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const order = new Map(observations.map((observation, index) => [observation.id, index]));
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || !allowedIds.has(id) || !order.has(id)) return undefined;
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
	const seenSignatures = new Set(
		priorReflections.map((reflection) => reflectionSignature(reflection.content, reflection.supportingObservationIds)),
	);
	const context = boundedContext(
		priorReflections,
		observations,
		resolveWorkerMemoryMaxTokens(runtime.config, resolved.model.contextWindow),
	);
	// Run totals feed diagnostics; each tool result reports only its own call.
	let runRejected = 0;
	let runDuplicates = 0;

	const tool = {
		name: "record_reflections",
		description:
			"Record new durable reflections with supporting active observation ids. Do not call this tool when no new durable fact is justified.",
		parameters: REFLECTIONS_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const rawList = args.reflections;
			if (!Array.isArray(rawList)) {
				runRejected++;
				return {
					text: "Invalid arguments: reflections must be an array of reflection objects. Nothing was recorded.",
					isError: true,
				};
			}
			let added = 0;
			let rejected = 0;
			let duplicates = 0;
			const reasons: string[] = [];
			for (let index = 0; index < rawList.length; index++) {
				const raw: unknown = rawList[index];
				const label = `#${index + 1}`;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					rejected++;
					reasons.push(`${label}: not a reflection object`);
					continue;
				}
				const record = raw as Record<string, unknown>;
				const rawContent = typeof record.content === "string" ? normalizeRecordContentStrict(record.content) : undefined;
				const content = rawContent && runtime.config.redactSecrets ? redactText(rawContent) : rawContent;
				if (!content) {
					rejected++;
					reasons.push(`${label}: content must be one non-empty line of plain prose`);
					continue;
				}
				if (isLowValueRecordContent(content)) {
					rejected++;
					reasons.push(`${label}: content is empty filler`);
					continue;
				}
				const supportingObservationIds = normalizeSupportIds(
					record.supportingObservationIds,
					observations,
					context.observationIds,
				);
				if (!supportingObservationIds) {
					rejected++;
					reasons.push(`${label}: every supportingObservationIds entry must be an id listed under CURRENT OBSERVATIONS`);
					continue;
				}
				const signature = reflectionSignature(content, supportingObservationIds);
				if (seenSignatures.has(signature)) {
					duplicates++;
					continue;
				}
				seenSignatures.add(signature);
				const id = hashMemoryId(content, "", supportingObservationIds, new Set([...existing.keys(), ...accepted.keys()]));
				accepted.set(id, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateTextTokens(content),
				});
				added++;
			}
			runRejected += rejected;
			runDuplicates += duplicates;
			const nothingAccepted = added === 0 && rejected > 0;
			return {
				text:
					`Recorded ${added} new reflection${added === 1 ? "" : "s"}` +
					(duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "") +
					(rejected > 0 ? `; ${rejected} rejected: ${formatRejections(reasons)}` : "") +
					`. Total this run: ${accepted.size}.`,
				details: { added, duplicates, rejected, total: accepted.size },
				...(nothingAccepted ? { isError: true } : {}),
			};
		},
	};

	const rawUser = `${context.text}

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
		beforeTurn: runtime.beforePass,
		complete: options.complete,
		onUsage: (usage) => runtime.debug.usage("reflector", resolved.label, usage),
		// A later turn failing must not discard reflections already accepted.
		keepPartialOnError: () => accepted.size > 0,
	});
	if (result.failed) {
		runtime.debug.record("reflector", "partial_after_error", { turns: result.turns, error: result.errorMessage });
	}
	const values = Array.from(accepted.values());
	if (values.length === 0) {
		runtime.debug.record("reflector", "empty", {
			toolCalls: result.toolCallCount,
			rejected: runRejected,
			duplicates: runDuplicates,
		});
		return undefined;
	}
	runtime.debug.record("reflector", "recorded", { count: values.length, turns: result.turns });
	return values;
}

import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../constants";
import { observationLine, reflectionLine, type Observation, type Reflection } from "../ledger/types";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { DROPPER_SYSTEM } from "./prompts";
import { resolveWorkerMemoryMaxTokens } from "../config";

const DROP_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["ids"],
	properties: {
		ids: {
			type: "array",
			minItems: 1,
			items: { type: "string", minLength: 1 },
			description: "Active observation ids that are safe to remove from compressed memory.",
		},
		reason: { type: "string" },
	},
};

export interface ObservationPoolMetrics {
	observationTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	fullness: number;
	maxDropsAllowed: number;
	averageObservationTokens: number;
}

export function observationPoolMetrics(observations: readonly Observation[], targetTokens: number): ObservationPoolMetrics {
	const observationTokens = observations.reduce((total, observation) => total + observation.tokenCount, 0);
	const tokensOverTarget = Math.max(0, observationTokens - targetTokens);
	const averageObservationTokens = observations.length > 0 ? observationTokens / observations.length : 0;
	const maxDropsAllowed =
		tokensOverTarget <= 0 || averageObservationTokens <= 0
			? 0
			: Math.min(observations.length, Math.max(1, Math.ceil(tokensOverTarget / averageObservationTokens)));
	return {
		observationTokens,
		targetTokens,
		tokensOverTarget,
		fullness: targetTokens > 0 ? observationTokens / targetTokens : 0,
		maxDropsAllowed,
		averageObservationTokens,
	};
}

export interface RunDropperOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	reflections: readonly Reflection[];
	observations: readonly Observation[];
	targetTokens: number;
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

function isCovered(observationId: string, reflections: readonly Reflection[]): boolean {
	return reflections.some((reflection) => reflection.supportingObservationIds.includes(observationId));
}

interface BoundedDropperContext {
	text: string;
	observations: Observation[];
	omitted: number;
}

/**
 * Keep the worker request inside `workerMemoryMaxTokens`. Oldest observations
 * are the primary drop candidates, so the window is oldest-first; newer ones
 * are omitted and cannot be selected.
 */
function boundedContext(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	maxTokens: number,
): BoundedDropperContext {
	const reflectionLines = reflections.map(reflectionLine);
	let tokens = estimateTextTokens("CURRENT REFLECTIONS:\nCURRENT OBSERVATIONS:\n(none yet)");
	const selectedReflections: string[] = [];
	for (let i = reflectionLines.length - 1; i >= 0; i--) {
		const line = reflectionLines[i]!;
		const cost = estimateTextTokens(line) + 1;
		if (tokens + cost > maxTokens) continue;
		selectedReflections.unshift(line);
		tokens += cost;
	}
	const selectedLines: string[] = [];
	const included: Observation[] = [];
	for (const observation of observations) {
		const line = `${observationLine(observation)} [coverage: ${coverageTier(observation.id, reflections)}]`;
		const cost = estimateTextTokens(line) + 1;
		if (tokens + cost > maxTokens) break;
		selectedLines.push(line);
		included.push(observation);
		tokens += cost;
	}
	const omitted = observations.length - included.length;
	const omittedNote = omitted > 0 ? `\n(${omitted} newer observation${omitted === 1 ? "" : "s"} omitted to fit the worker memory budget.)` : "";
	return {
		text: `CURRENT REFLECTIONS:
${selectedReflections.length > 0 ? selectedReflections.join("\n") : "(none yet)"}

CURRENT OBSERVATIONS:
${selectedLines.length > 0 ? selectedLines.join("\n") : "(none yet)"}${omittedNote}`,
		observations: included,
		omitted,
	};
}

/**
 * Retire only active observations whose loss is demonstrably safe. Critical
 * records are never drop candidates; high-relevance records need reflection
 * coverage. A drop is a ledger tombstone, not a history deletion.
 */
export async function runDropper(options: RunDropperOptions): Promise<string[] | undefined> {
	const { runtime, resolved, reflections, observations, targetTokens, signal } = options;
	if (observations.length === 0) return undefined;
	const metrics = observationPoolMetrics(observations, targetTokens);
	if (metrics.maxDropsAllowed <= 0) return undefined;

	const context = boundedContext(
		reflections,
		observations,
		resolveWorkerMemoryMaxTokens(runtime.config, resolved.model.contextWindow),
	);
	if (context.observations.length === 0) return undefined;
	const allowed = new Map(context.observations.map((observation) => [observation.id, observation]));
	const selected = new Set<string>();
	let rejected = 0;
	let duplicates = 0;

	const tool = {
		name: "drop_observations",
		description:
			"Propose active observation ids that are safe to remove from compressed memory. The hard maximum is enforced locally; dropping fewer is encouraged.",
		parameters: DROP_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const ids = args.ids;
			if (!Array.isArray(ids)) return { text: "Invalid arguments: ids must be an array.", isError: true };
			let added = 0;
			for (const id of ids) {
				if (typeof id !== "string" || !allowed.has(id)) {
					rejected++;
					continue;
				}
				const observation = allowed.get(id)!;
				if (observation.relevance === "critical" || (observation.relevance === "high" && !isCovered(id, reflections))) {
					rejected++;
					continue;
				}
				if (selected.has(id)) {
					duplicates++;
					continue;
				}
				if (selected.size >= metrics.maxDropsAllowed) {
					rejected++;
					continue;
				}
				selected.add(id);
				added++;
			}
			return {
				text:
					`Queued ${added} drop candidate${added === 1 ? "" : "s"}; ${rejected} rejected; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}. ` +
					`Selected this run: ${selected.size}/${metrics.maxDropsAllowed}.`,
				details: { added, rejected, duplicates, selected: selected.size, maxDropsAllowed: metrics.maxDropsAllowed },
			};
		},
	};

	if (
		!context.observations.some(
			(observation) =>
				observation.relevance !== "critical" &&
				(observation.relevance !== "high" || isCovered(observation.id, reflections)),
		)
	) {
		return undefined;
	}

	const rawUser = `${context.text}

Active pool: ~${metrics.observationTokens.toLocaleString()} tokens; target: ~${metrics.targetTokens.toLocaleString()}; over target by ~${metrics.tokensOverTarget.toLocaleString()}.
Hard maximum drops this run: ${metrics.maxDropsAllowed}. The maximum is an upper bound, not a target. Drop only clearly safe observations; critical records are never accepted and high records need reflection coverage. Only ids listed above are valid.`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	const result = await runWorkerLoop({
		stage: "dropper",
		model: resolved.model,
		auth: resolved.auth,
		thinking: resolved.thinking,
		maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
		maxTurns: runtime.config.agentMaxTurns,
		system: DROPPER_SYSTEM,
		user,
		tool,
		signal,
		sessionId: runtime.sessionId,
		complete: options.complete,
		onUsage: (usage) => runtime.debug.usage("dropper", resolved.label, usage),
	});
	const ids = Array.from(selected);
	if (ids.length === 0) {
		runtime.debug.record("dropper", "empty", { toolCalls: result.toolCallCount, rejected, duplicates });
		return undefined;
	}
	runtime.debug.record("dropper", "recorded", { count: ids.length, tokens: ids.reduce((total, id) => total + (allowed.get(id)?.tokenCount ?? 0), 0) });
	return ids;
}

import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { WORKER_OBSERVATIONS_MIN_SHARE, estimateTextTokens } from "../constants";
import { observationLine, reflectionLine, type Observation, type Reflection } from "../ledger/types";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { formatRejections, runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { DROPPER_SYSTEM } from "./prompts";
import { resolveWorkerMemoryMaxTokens } from "../config";

/**
 * Observation tokens listed as drop candidates in one dropper request, oldest
 * first. Reasoning models think longer about more candidates: with the whole
 * pool listed (about 20,000 prompt tokens), most calls spent an 8,192-token
 * output limit on reasoning and answered nothing.
 */
export const DROPPER_BATCH_MAX_TOKENS = 3_000;
/** Smallest batch an output-limit failure shrinks the dropper batch to. */
export const DROPPER_MIN_BATCH_TOKENS = 500;

/**
 * Halve the session's dropper batch after an output-limit failure, so the
 * next call lists fewer candidates. Returns false once the batch is at its minimum.
 */
export function shrinkDropperBatch(runtime: SessionRuntime): boolean {
	const current = runtime.dropperBatchTokens ?? DROPPER_BATCH_MAX_TOKENS;
	if (current <= DROPPER_MIN_BATCH_TOKENS) return false;
	runtime.dropperBatchTokens = Math.max(DROPPER_MIN_BATCH_TOKENS, Math.floor(current / 2));
	runtime.debug.record("dropper", "batch_shrunk", { from: current, to: runtime.dropperBatchTokens });
	return true;
}

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
 * Select records within `budget` in the given index order; a record that does
 * not fit is skipped, not a stop marker, so one long record cannot hide the rest.
 */
function selectWithinBudget(lines: readonly string[], order: readonly number[], budget: number): { indexes: number[]; tokens: number } {
	const indexes: number[] = [];
	let tokens = 0;
	for (const index of order) {
		const cost = estimateTextTokens(lines[index]!) + 1;
		if (tokens + cost > budget) continue;
		indexes.push(index);
		tokens += cost;
	}
	indexes.sort((a, b) => a - b);
	return { indexes, tokens };
}

/**
 * Keep the worker request inside `workerMemoryMaxTokens`. Oldest observations
 * are the primary drop candidates, so they are selected oldest-first, up to
 * `batchTokens`, and they keep at least WORKER_OBSERVATIONS_MIN_SHARE of the
 * budget: reflections are never pruned and would otherwise leave the dropper
 * nothing to act on. Reflections take the rest, newest first, and either side
 * reclaims what the other leaves unused. Omitted observations cannot be selected.
 */
function boundedContext(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	maxTokens: number,
	batchTokens: number,
): BoundedDropperContext {
	const reflectionLines = reflections.map(reflectionLine);
	const observationLines = observations.map(
		(observation) => `${observationLine(observation)} [coverage: ${coverageTier(observation.id, reflections)}]`,
	);
	const available = Math.max(
		0,
		maxTokens - estimateTextTokens("CURRENT REFLECTIONS:\nCURRENT OBSERVATIONS:\n(none yet)"),
	);
	const oldestFirst = observationLines.map((_, index) => index);
	const newestFirst = reflectionLines.map((_, index) => reflectionLines.length - 1 - index);
	const reserved = selectWithinBudget(
		observationLines,
		oldestFirst,
		Math.min(batchTokens, Math.floor(available * WORKER_OBSERVATIONS_MIN_SHARE)),
	);
	const pickedReflections = selectWithinBudget(reflectionLines, newestFirst, available - reserved.tokens);
	const pickedObservations = selectWithinBudget(
		observationLines,
		oldestFirst,
		Math.min(batchTokens, available - pickedReflections.tokens),
	);
	const selectedReflections = pickedReflections.indexes.map((index) => reflectionLines[index]!);
	const selectedLines = pickedObservations.indexes.map((index) => observationLines[index]!);
	const included = pickedObservations.indexes.map((index) => observations[index]!);
	const omitted = observations.length - included.length;
	const omittedNote =
		omitted > 0 ? `\n(${omitted} newer observation${omitted === 1 ? " is" : "s are"} not listed in this batch; later passes handle them.)` : "";
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

	// Critical records and uncovered high records are never accepted, so they
	// would only take up the batch and the model's reasoning.
	const droppable = observations.filter(
		(observation) =>
			observation.relevance !== "critical" && (observation.relevance !== "high" || isCovered(observation.id, reflections)),
	);
	if (droppable.length === 0) return undefined;
	const context = boundedContext(
		reflections,
		droppable,
		resolveWorkerMemoryMaxTokens(runtime.config, resolved.model.contextWindow),
		runtime.dropperBatchTokens ?? DROPPER_BATCH_MAX_TOKENS,
	);
	if (context.observations.length === 0) return undefined;
	const allowed = new Map(context.observations.map((observation) => [observation.id, observation]));
	// Protected records are not listed; their ids still get the protection reason.
	const pool = new Map(observations.map((observation) => [observation.id, observation]));
	const selected = new Set<string>();
	// Run totals feed diagnostics; each tool result reports only its own call.
	let runRejected = 0;
	let runDuplicates = 0;

	const tool = {
		name: "drop_observations",
		description:
			"Propose active observation ids that are safe to remove from compressed memory. The hard maximum is enforced locally; dropping fewer is encouraged.",
		parameters: DROP_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const ids = args.ids;
			if (!Array.isArray(ids)) {
				runRejected++;
				return { text: "Invalid arguments: ids must be an array of observation ids. Nothing was queued.", isError: true };
			}
			let added = 0;
			let rejected = 0;
			let duplicates = 0;
			const reasons: string[] = [];
			for (let index = 0; index < ids.length; index++) {
				const id: unknown = ids[index];
				const label = `#${index + 1}`;
				const observation = typeof id === "string" ? pool.get(id) : undefined;
				if (!observation) {
					rejected++;
					reasons.push(`${label}: not an id listed under CURRENT OBSERVATIONS`);
					continue;
				}
				if (observation.relevance === "critical") {
					rejected++;
					reasons.push(`${label}: critical observations are never dropped`);
					continue;
				}
				if (observation.relevance === "high" && !isCovered(observation.id, reflections)) {
					rejected++;
					reasons.push(`${label}: high observations need reflection coverage before they can be dropped`);
					continue;
				}
				if (!allowed.has(observation.id)) {
					rejected++;
					reasons.push(`${label}: not an id listed under CURRENT OBSERVATIONS`);
					continue;
				}
				if (selected.has(observation.id)) {
					duplicates++;
					continue;
				}
				if (selected.size >= metrics.maxDropsAllowed) {
					rejected++;
					reasons.push(`${label}: the hard maximum of ${metrics.maxDropsAllowed} drops is reached`);
					continue;
				}
				selected.add(observation.id);
				added++;
			}
			runRejected += rejected;
			runDuplicates += duplicates;
			const nothingAccepted = added === 0 && rejected > 0;
			return {
				text:
					`Queued ${added} drop candidate${added === 1 ? "" : "s"}` +
					(duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "") +
					(rejected > 0 ? `; ${rejected} rejected: ${formatRejections(reasons)}` : "") +
					`. Selected this run: ${selected.size}/${metrics.maxDropsAllowed}.`,
				details: { added, rejected, duplicates, selected: selected.size, maxDropsAllowed: metrics.maxDropsAllowed },
				...(nothingAccepted ? { isError: true } : {}),
			};
		},
	};

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
		beforeTurn: runtime.beforePass,
		complete: options.complete,
		onUsage: (usage) => runtime.debug.usage("dropper", resolved.label, usage),
		// A later turn failing must not discard drops already validated.
		keepPartialOnError: () => selected.size > 0,
	});
	if (result.failed) {
		runtime.debug.record("dropper", "partial_after_error", { turns: result.turns, error: result.errorMessage });
	}
	if (result.truncated && selected.size === 0) {
		throw new Error("dropper reply hit its output token limit before proposing any drop");
	}
	const ids = Array.from(selected);
	if (ids.length === 0) {
		runtime.debug.record("dropper", "empty", {
			toolCalls: result.toolCallCount,
			rejected: runRejected,
			duplicates: runDuplicates,
		});
		return undefined;
	}
	runtime.debug.record("dropper", "recorded", { count: ids.length, tokens: ids.reduce((total, id) => total + (allowed.get(id)?.tokenCount ?? 0), 0) });
	return ids;
}

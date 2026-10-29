import { estimateTextTokens } from "../constants";
import type { TokenEstimator } from "../util/tokens";
import { observationLine, reflectionLine, type Observation, type Reflection } from "./types";

export const MEMORY_HEADER = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints.
- Observations: timestamped events from the conversation history, in chronological order.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the ob_recall tool with the relevant observation or reflection id. Do not use recall as broad search or inject raw source unless it is needed.`;

export const SUMMARY_OBSERVATIONS_MIN_SHARE = 0.5;

export interface RenderOptions {
	maxTokens?: number;
	estimate?: TokenEstimator;
}

export interface RenderedMemory {
	text: string;
	reflections: Reflection[];
	observations: Observation[];
	omittedReflections: number;
	omittedObservations: number;
	tokens: number;
}

function selectWithinBudget<T>(
	records: readonly T[],
	line: (record: T) => string,
	budget: number,
	estimate: TokenEstimator,
): { kept: T[]; tokens: number } {
	const keptIndexes: number[] = [];
	let tokens = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (!record) continue;
		const cost = estimate(line(record)) + 1;
		if (cost > budget - tokens) continue;
		tokens += cost;
		keptIndexes.push(i);
	}
	keptIndexes.reverse();
	return { kept: keptIndexes.flatMap((index) => (records[index] === undefined ? [] : [records[index]!])), tokens };
}

/**
 * Render the memory ledger deterministically. Observations get at least half
 * the variable budget, reflections take the remainder, and either side may
 * reclaim what the other leaves unused. A record that does not fit is skipped,
 * not treated as a stop marker, so a single long newest line cannot hide all
 * shorter older lines.
 */
export function renderMemory(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	options: RenderOptions = {},
): RenderedMemory {
	const estimate = options.estimate ?? estimateTextTokens;
	if (reflections.length === 0 && observations.length === 0) {
		return { text: "", reflections: [], observations: [], omittedReflections: 0, omittedObservations: 0, tokens: 0 };
	}

	let keptReflections = [...reflections];
	let keptObservations = [...observations];
	const maxTokens = options.maxTokens;
	if (maxTokens !== undefined && Number.isFinite(maxTokens)) {
		if (maxTokens <= 0) {
			return {
				text: "",
				reflections: [],
				observations: [],
				omittedReflections: reflections.length,
				omittedObservations: observations.length,
				tokens: 0,
			};
		}
		const fixed = estimate(MEMORY_HEADER) + estimate("## Reflections\n## Observations\n\n\n\n") + 40;
		const variable = Math.max(0, maxTokens - fixed);
		const observationShare = Math.floor(variable * SUMMARY_OBSERVATIONS_MIN_SHARE);
		const reserved = selectWithinBudget(observations, observationLine, observationShare, estimate);
		const pickedReflections = selectWithinBudget(
			reflections,
			reflectionLine,
			variable - reserved.tokens,
			estimate,
		);
		keptReflections = pickedReflections.kept;
		keptObservations = selectWithinBudget(
			observations,
			observationLine,
			variable - pickedReflections.tokens,
			estimate,
		).kept;
	}

	const omittedReflections = reflections.length - keptReflections.length;
	const omittedObservations = observations.length - keptObservations.length;
	const parts: string[] = [MEMORY_HEADER];
	if (keptReflections.length > 0) {
		parts.push(`## Reflections\n${keptReflections.map(reflectionLine).join("\n")}`);
	}
	if (keptObservations.length > 0) {
		parts.push(`## Observations\n${keptObservations.map(observationLine).join("\n")}`);
	}
	if (keptReflections.length === 0 && keptObservations.length === 0) {
		return {
			text: "",
			reflections: [],
			observations: [],
			omittedReflections,
			omittedObservations,
			tokens: 0,
		};
	}
	if (omittedReflections > 0 || omittedObservations > 0) {
		const omitted: string[] = [];
		if (omittedReflections > 0) {
			omitted.push(`${omittedReflections} older reflection${omittedReflections === 1 ? "" : "s"}`);
		}
		if (omittedObservations > 0) {
			omitted.push(`${omittedObservations} older observation${omittedObservations === 1 ? "" : "s"}`);
		}
		parts.push(
			`(${omitted.join(" and ")} omitted to fit the summary budget; they remain in the session memory ledger, see /ob-memory view full.)`,
		);
	}
	const text = parts.join("\n\n");
	return {
		text,
		reflections: keptReflections,
		observations: keptObservations,
		omittedReflections,
		omittedObservations,
		tokens: estimate(text),
	};
}

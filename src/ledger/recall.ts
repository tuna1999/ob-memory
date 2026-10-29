import { estimateTextTokens } from "../constants";
import { redactText } from "../security/redact";
import { serializeEntry } from "./serialize";
import {
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	type LedgerEntry,
	type Observation,
	type Reflection,
} from "./types";

export interface RecallResult {
	found: boolean;
	kind?: "observation" | "reflection" | "mixed";
	memoryId: string;
	text: string;
	observationIds: string[];
	reflectionIds: string[];
	sourceEntryIds: string[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	missingSupportingObservationIds: string[];
	collision: boolean;
	partial: boolean;
	details: Record<string, unknown>;
}

interface IndexedObservation {
	observation: Observation;
	entryId: string;
	recordIndex: number;
}

interface IndexedReflection {
	reflection: Reflection;
	entryId: string;
	recordIndex: number;
}

function indexLedger(entries: readonly LedgerEntry[]): {
	observations: IndexedObservation[];
	reflections: IndexedReflection[];
	dropped: Set<string>;
} {
	const observations: IndexedObservation[] = [];
	const reflections: IndexedReflection[] = [];
	const dropped = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "ob-memory.observations.recorded") {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (let i = 0; i < entry.data.observations.length; i++) {
				observations.push({ observation: entry.data.observations[i]!, entryId: entry.id, recordIndex: i });
			}
			continue;
		}
		if (entry.customType === "ob-memory.reflections.recorded") {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (let i = 0; i < entry.data.reflections.length; i++) {
				reflections.push({ reflection: entry.data.reflections[i]!, entryId: entry.id, recordIndex: i });
			}
			continue;
		}
		if (entry.customType === "ob-memory.observations.dropped") {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const id of entry.data.observationIds) dropped.add(id);
		}
	}
	return { observations, reflections, dropped };
}

function unique<T>(values: readonly T[]): T[] {
	return Array.from(new Set(values));
}

export interface RecallOptions {
	maxSourceTokens?: number;
	redact?: boolean;
	lookupEntry?: (id: string) => LedgerEntry | undefined;
}

/**
 * Resolve an exact memory id to its record, supporting observations, and the
 * original source entries. Recall is deliberately exact-id only: it is a
 * provenance tool, not a semantic search layer.
 */
export function recallMemory(
	entries: readonly LedgerEntry[],
	memoryId: string,
	options: RecallOptions = {},
): RecallResult {
	const { observations, reflections, dropped } = indexLedger(entries);
	const directObservations = observations.filter((item) => item.observation.id === memoryId);
	const directReflections = reflections.filter((item) => item.reflection.id === memoryId);
	if (directObservations.length === 0 && directReflections.length === 0) {
		return {
			found: false,
			memoryId,
			text: `No memory record with id ${memoryId}. Use /ob-memory view or /ob-memory view full to list ids.`,
			observationIds: [],
			reflectionIds: [],
			sourceEntryIds: [],
			missingSourceEntryIds: [],
			nonSourceEntryIds: [],
			missingSupportingObservationIds: [],
			collision: false,
			partial: false,
			details: { memoryId, found: false },
		};
	}

	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const observationsById = new Map<string, IndexedObservation>();
	for (const item of observations) {
		if (!observationsById.has(item.observation.id)) observationsById.set(item.observation.id, item);
	}

	const selectedObservations = new Map<string, IndexedObservation>();
	const missingSupportingObservationIds: string[] = [];
	const addObservation = (item: IndexedObservation): void => {
		selectedObservations.set(item.observation.id, item);
	};
	for (const item of directObservations) addObservation(item);
	for (const { reflection } of directReflections) {
		for (const id of unique(reflection.supportingObservationIds)) {
			const item = observationsById.get(id);
			if (!item) {
				missingSupportingObservationIds.push(id);
				continue;
			}
			addObservation(item);
		}
	}

	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];
	const sourceEntries: LedgerEntry[] = [];
	const sourceIds: string[] = [];
	for (const { observation } of selectedObservations.values()) {
		for (const id of observation.sourceEntryIds) {
			if (sourceIds.includes(id)) continue;
			sourceIds.push(id);
			const entry = entriesById.get(id) ?? options.lookupEntry?.(id);
			if (!entry) {
				missingSourceEntryIds.push(id);
				continue;
			}
			if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary") {
				nonSourceEntryIds.push(id);
				continue;
			}
			sourceEntries.push(entry);
		}
	}

	const observationIds = Array.from(selectedObservations.keys());
	const reflectionIds = directReflections.map((item) => item.reflection.id);
	const kind =
		observationIds.length > 0 && reflectionIds.length > 0
			? "mixed"
			: reflectionIds.length > 0
				? "reflection"
				: "observation";
	const collision = directObservations.length + directReflections.length > 1;
	const partial = missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || missingSupportingObservationIds.length > 0;

	const lines: string[] = [`Memory ${memoryId} (${kind})`];
	if (directObservations.length > 0) {
		for (const item of directObservations) {
			const status = dropped.has(item.observation.id) ? "dropped" : "active";
			lines.push(
				`Observation [${item.observation.id}] ${item.observation.timestamp} [${item.observation.relevance}] [${status}] ${item.observation.content}`,
			);
		}
	}
	if (directReflections.length > 0) {
		for (const item of directReflections) {
			lines.push(`Reflection [${item.reflection.id}] ${item.reflection.content}`);
			lines.push(`  support: ${item.reflection.supportingObservationIds.join(", ")}`);
		}
	}
	if (selectedObservations.size > 0 && directObservations.length === 0) {
		lines.push("Supporting observations:");
		for (const item of selectedObservations.values()) {
			const status = dropped.has(item.observation.id) ? "dropped" : "active";
			lines.push(
				`  [${item.observation.id}] ${item.observation.timestamp} [${item.observation.relevance}] [${status}] ${item.observation.content}`,
			);
		}
	}

	const maxSourceTokens = options.maxSourceTokens ?? 4_000;
	const sourceChunks: string[] = [];
	const includedSourceIds: string[] = [];
	let sourceTokens = 0;
	for (const entry of sourceEntries) {
		const rendered = `[Source entry id: ${entry.id}]\n${serializeEntry(entry)}`;
		const tokens = estimateTextTokens(rendered);
		if (sourceTokens + tokens > maxSourceTokens && includedSourceIds.length > 0) break;
		sourceChunks.push(rendered);
		includedSourceIds.push(entry.id);
		sourceTokens += tokens;
	}
	if (sourceChunks.length > 0) {
		lines.push("", "Source evidence:", sourceChunks.join("\n\n"));
	}
	if (missingSourceEntryIds.length > 0) {
		lines.push("", `Missing source entries: ${unique(missingSourceEntryIds).join(", ")}`);
	}
	if (nonSourceEntryIds.length > 0) {
		lines.push("", `Ids that are not source entries: ${unique(nonSourceEntryIds).join(", ")}`);
	}
	if (missingSupportingObservationIds.length > 0) {
		lines.push("", `Missing supporting observations: ${unique(missingSupportingObservationIds).join(", ")}`);
	}
	if (sourceEntries.length > includedSourceIds.length) {
		lines.push("", `(${sourceEntries.length - includedSourceIds.length} more source entries omitted to fit the recall budget.)`);
	}

	const text = lines.join("\n");
	return {
		found: true,
		kind,
		memoryId,
		text: options.redact ? redactText(text) : text,
		observationIds,
		reflectionIds,
		sourceEntryIds: includedSourceIds,
		missingSourceEntryIds: unique(missingSourceEntryIds),
		nonSourceEntryIds: unique(nonSourceEntryIds),
		missingSupportingObservationIds: unique(missingSupportingObservationIds),
		collision,
		partial,
		details: {
			memoryId,
			found: true,
			kind,
			observationIds,
			reflectionIds,
			sourceEntryIds: includedSourceIds,
			missingSourceEntryIds: unique(missingSourceEntryIds),
			nonSourceEntryIds: unique(nonSourceEntryIds),
			missingSupportingObservationIds: unique(missingSupportingObservationIds),
			collision,
			partial,
		},
	};
}

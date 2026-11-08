import { estimateTextTokens } from "../constants";
import { redactText } from "../security/redact";
import { reflectionSurvivesReset, resetView, type ResetView } from "./fold";
import { serializeSourceEntries } from "./serialize";
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
	omittedSourceEntryIds: string[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	missingSupportingObservationIds: string[];
	/** Supporting observations cleared by the latest `/clear`; never shown. */
	clearedSupportingObservationIds: string[];
	/** Cited source entries at or before the latest `/clear`; never shown. */
	clearedSourceEntryIds: string[];
	/** True when the id exists only in records cleared by the latest `/clear`. */
	cleared?: boolean;
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

/**
 * Index recallable records. Records cleared by the latest `/clear` (see
 * `ResetView` in fold.ts) are kept out: recall output goes to the model, and
 * cleared conversation must not re-enter its context. Their ids are returned
 * so recall can say why an id is not available.
 */
function indexLedger(entries: readonly LedgerEntry[], reset: ResetView): {
	observations: IndexedObservation[];
	reflections: IndexedReflection[];
	dropped: Set<string>;
	clearedObservationIds: Set<string>;
	clearedReflectionIds: Set<string>;
} {
	const observations: IndexedObservation[] = [];
	const candidates: IndexedReflection[] = [];
	const dropped = new Set<string>();
	const clearedObservationIds = new Set<string>();
	const clearedReflectionIds = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type !== "custom") continue;
		if (entry.customType === "ob-memory.observations.recorded") {
			if (!isObservationsRecordedData(entry.data)) continue;
			const keepsRecord = reset.keepsRecord(index, entry.data);
			for (let i = 0; i < entry.data.observations.length; i++) {
				const observation = entry.data.observations[i]!;
				if (!keepsRecord || !reset.keepsObservation(observation)) {
					clearedObservationIds.add(observation.id);
					continue;
				}
				observations.push({ observation, entryId: entry.id, recordIndex: i });
			}
			continue;
		}
		if (entry.customType === "ob-memory.reflections.recorded") {
			if (!isReflectionsRecordedData(entry.data)) continue;
			const keepsRecord = reset.keepsRecord(index, entry.data);
			for (let i = 0; i < entry.data.reflections.length; i++) {
				const reflection = entry.data.reflections[i]!;
				if (!keepsRecord) {
					clearedReflectionIds.add(reflection.id);
					continue;
				}
				candidates.push({ reflection, entryId: entry.id, recordIndex: i });
			}
			continue;
		}
		if (entry.customType === "ob-memory.observations.dropped") {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const id of entry.data.observationIds) dropped.add(id);
		}
	}
	const keptObservationIds = new Set(observations.map((item) => item.observation.id));
	const reflections = candidates.filter((item) => {
		if (reflectionSurvivesReset(item.reflection, clearedObservationIds, keptObservationIds)) return true;
		clearedReflectionIds.add(item.reflection.id);
		return false;
	});
	return { observations, reflections, dropped, clearedObservationIds, clearedReflectionIds };
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
	const reset = resetView(entries);
	const { observations, reflections, dropped, clearedObservationIds, clearedReflectionIds } = indexLedger(entries, reset);
	const directObservations = observations.filter((item) => item.observation.id === memoryId);
	const directReflections = reflections.filter((item) => item.reflection.id === memoryId);
	if (directObservations.length === 0 && directReflections.length === 0) {
		const cleared = clearedObservationIds.has(memoryId) || clearedReflectionIds.has(memoryId);
		return {
			found: false,
			memoryId,
			text: cleared
				? `Memory ${memoryId} describes conversation that was cleared with /clear. It stays in the session ledger for audit (/ob-memory view full) but is not recalled into context.`
				: `No memory record with id ${memoryId}. Use /ob-memory view or /ob-memory view full to list ids.`,
			observationIds: [],
			reflectionIds: [],
			sourceEntryIds: [],
			omittedSourceEntryIds: [],
			missingSourceEntryIds: [],
			nonSourceEntryIds: [],
			missingSupportingObservationIds: [],
			clearedSupportingObservationIds: [],
			clearedSourceEntryIds: [],
			...(cleared ? { cleared: true } : {}),
			collision: false,
			partial: false,
			details: { memoryId, found: false, ...(cleared ? { cleared: true } : {}) },
		};
	}

	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const observationsById = new Map<string, IndexedObservation>();
	for (const item of observations) {
		if (!observationsById.has(item.observation.id)) observationsById.set(item.observation.id, item);
	}

	const selectedObservations = new Map<string, IndexedObservation>();
	const missingSupportingObservationIds: string[] = [];
	const clearedSupportingObservationIds: string[] = [];
	const addObservation = (item: IndexedObservation): void => {
		selectedObservations.set(item.observation.id, item);
	};
	for (const item of directObservations) addObservation(item);
	for (const { reflection } of directReflections) {
		for (const id of unique(reflection.supportingObservationIds)) {
			const item = observationsById.get(id);
			if (!item) {
				if (clearedObservationIds.has(id)) clearedSupportingObservationIds.push(id);
				else missingSupportingObservationIds.push(id);
				continue;
			}
			addObservation(item);
		}
	}

	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];
	const clearedSourceEntryIds: string[] = [];
	const sourceEntries: LedgerEntry[] = [];
	const sourceIds: string[] = [];
	for (const { observation } of selectedObservations.values()) {
		for (const id of observation.sourceEntryIds) {
			if (sourceIds.includes(id)) continue;
			sourceIds.push(id);
			if (reset.isClearedEntry(id)) {
				clearedSourceEntryIds.push(id);
				continue;
			}
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
	// "mixed" means the id itself matched both an observation and a
	// reflection; a reflection's supporting observations do not count.
	const kind =
		directObservations.length > 0 && directReflections.length > 0
			? "mixed"
			: directReflections.length > 0
				? "reflection"
				: "observation";
	const collision = directObservations.length + directReflections.length > 1;
	const partial =
		missingSourceEntryIds.length > 0 ||
		nonSourceEntryIds.length > 0 ||
		missingSupportingObservationIds.length > 0 ||
		clearedSupportingObservationIds.length > 0 ||
		clearedSourceEntryIds.length > 0;
	const redact = options.redact ?? true;

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
		const remaining = Math.max(256, maxSourceTokens - sourceTokens);
		// Redact each source before it is truncated to the budget, so a cut
		// cannot split a secret into halves the patterns no longer match.
		const rendered = serializeSourceEntries([entry], { maxTokens: remaining, redact }).text;
		if (!rendered) continue;
		const tokens = estimateTextTokens(rendered);
		if (sourceTokens + tokens > maxSourceTokens && includedSourceIds.length > 0) break;
		sourceChunks.push(rendered);
		includedSourceIds.push(entry.id);
		sourceTokens += tokens;
	}
	if (sourceChunks.length > 0) {
		lines.push("", "Source evidence:", sourceChunks.join("\n\n"));
	}
	const includedSourceIdSet = new Set(includedSourceIds);
	const omittedSourceEntryIds = unique(
		sourceEntries.map((entry) => entry.id).filter((id) => !includedSourceIdSet.has(id)),
	);
	if (missingSourceEntryIds.length > 0) {
		lines.push("", `Missing source entries: ${unique(missingSourceEntryIds).join(", ")}`);
	}
	if (nonSourceEntryIds.length > 0) {
		lines.push("", `Ids that are not source entries: ${unique(nonSourceEntryIds).join(", ")}`);
	}
	if (missingSupportingObservationIds.length > 0) {
		lines.push("", `Missing supporting observations: ${unique(missingSupportingObservationIds).join(", ")}`);
	}
	if (clearedSupportingObservationIds.length > 0) {
		lines.push("", `Supporting observations cleared with /clear (not shown): ${unique(clearedSupportingObservationIds).join(", ")}`);
	}
	if (clearedSourceEntryIds.length > 0) {
		lines.push("", `Source entries cleared with /clear (not shown): ${unique(clearedSourceEntryIds).join(", ")}`);
	}
	if (sourceEntries.length > includedSourceIds.length) {
		lines.push("", `(${sourceEntries.length - includedSourceIds.length} more source entries omitted to fit the recall budget.)`);
	}

	const text = lines.join("\n");
	return {
		found: true,
		kind,
		memoryId,
		text: redact ? redactText(text) : text,
		observationIds,
		reflectionIds,
		sourceEntryIds: includedSourceIds,
		omittedSourceEntryIds,
		missingSourceEntryIds: unique(missingSourceEntryIds),
		nonSourceEntryIds: unique(nonSourceEntryIds),
		missingSupportingObservationIds: unique(missingSupportingObservationIds),
		clearedSupportingObservationIds: unique(clearedSupportingObservationIds),
		clearedSourceEntryIds: unique(clearedSourceEntryIds),
		collision,
		partial,
		details: {
			memoryId,
			found: true,
			kind,
			observationIds,
			reflectionIds,
			sourceEntryIds: includedSourceIds,
			omittedSourceEntryIds,
			missingSourceEntryIds: unique(missingSourceEntryIds),
			nonSourceEntryIds: unique(nonSourceEntryIds),
			missingSupportingObservationIds: unique(missingSupportingObservationIds),
			clearedSupportingObservationIds: unique(clearedSupportingObservationIds),
			clearedSourceEntryIds: unique(clearedSourceEntryIds),
			collision,
			partial,
		},
	};
}

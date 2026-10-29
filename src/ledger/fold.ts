import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	isMemoryDetails,
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	type LedgerEntry,
	type MemoryDetails,
	type Observation,
	type Reflection,
} from "./types";

export interface FoldedLedger {
	observations: Observation[];
	activeObservations: Observation[];
	reflections: Reflection[];
	droppedObservationIds: Set<string>;
	observationsById: Map<string, Observation>;
	reflectionsById: Map<string, Reflection>;
}

export interface Projection {
	observations: Observation[];
	reflections: Reflection[];
	droppedObservationIds: string[];
}

export interface CompactionProjection extends Projection {
	details: MemoryDetails;
}

export interface UnobservedSourceSpan {
	firstIndex: number;
	lastIndex: number;
	entryCount: number;
	entryIds: string[];
}

function boundaryIndex(entries: readonly LedgerEntry[], upToEntryId?: string): number {
	if (!upToEntryId) return entries.length - 1;
	return entries.findIndex((entry) => entry.id === upToEntryId);
}

function entryIndexMap(entries: readonly LedgerEntry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i]!.id, i);
	return indexes;
}

function coverageId(data: unknown): string | undefined {
	if (!data || typeof data !== "object" || !("coversUpToId" in data)) return undefined;
	const id = data.coversUpToId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function coverageIndex(data: unknown, indexes: Map<string, number>): number {
	const id = coverageId(data);
	return id ? (indexes.get(id) ?? -1) : -1;
}

function isCoveredAtOrBefore(data: unknown, indexes: Map<string, number>, boundary: number): boolean {
	if (boundary < 0) return false;
	const index = coverageIndex(data, indexes);
	return index >= 0 && index <= boundary;
}

/**
 * Fold valid ledger records from the branch root through `upToEntryId`.
 * First valid record wins by id; drops are tombstones and are retained even
 * when the dropped observation has not been seen yet.
 */
export function foldLedger(entries: readonly LedgerEntry[], upToEntryId?: string): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();
	const end = boundaryIndex(entries, upToEntryId);

	for (let i = 0; i <= end; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type !== "custom") continue;
		if (entry.customType === OM_OBSERVATIONS_RECORDED) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) {
				if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation);
			}
			continue;
		}
		if (entry.customType === OM_REFLECTIONS_RECORDED) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) reflectionsById.set(reflection.id, reflection);
			}
			continue;
		}
		if (entry.customType === OM_OBSERVATIONS_DROPPED) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const id of entry.data.observationIds) droppedObservationIds.add(id);
		}
	}

	const observations = Array.from(observationsById.values());
	return {
		observations,
		activeObservations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections: Array.from(reflectionsById.values()),
		droppedObservationIds,
		observationsById,
		reflectionsById,
	};
}

function project(
	entries: readonly LedgerEntry[],
	observationsBoundary: number,
	reflectionsBoundary: number,
	dropsBoundary: number,
): Projection {
	const indexes = entryIndexMap(entries);
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (
			entry.customType === OM_OBSERVATIONS_RECORDED &&
			isObservationsRecordedData(entry.data) &&
			isCoveredAtOrBefore(entry.data, indexes, observationsBoundary)
		) {
			for (const observation of entry.data.observations) {
				if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation);
			}
			continue;
		}
		if (
			entry.customType === OM_REFLECTIONS_RECORDED &&
			isReflectionsRecordedData(entry.data) &&
			isCoveredAtOrBefore(entry.data, indexes, reflectionsBoundary)
		) {
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) reflectionsById.set(reflection.id, reflection);
			}
			continue;
		}
		if (
			entry.customType === OM_OBSERVATIONS_DROPPED &&
			isObservationsDroppedData(entry.data) &&
			isCoveredAtOrBefore(entry.data, indexes, dropsBoundary)
		) {
			for (const id of entry.data.observationIds) droppedObservationIds.add(id);
		}
	}

	return {
		observations: Array.from(observationsById.values()).filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections: Array.from(reflectionsById.values()),
		droppedObservationIds: Array.from(droppedObservationIds),
	};
}

export function fullProjection(entries: readonly LedgerEntry[], upToEntryId?: string): Projection {
	const boundary = boundaryIndex(entries, upToEntryId);
	return project(entries, boundary, boundary, boundary);
}

export function latestCompactionDetails(entries: readonly LedgerEntry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "compaction") continue;
		if (isMemoryDetails(entry.details)) return entry.details;
	}
	return undefined;
}

export function visibleProjection(entries: readonly LedgerEntry[]): Projection {
	const details = latestCompactionDetails(entries);
	if (!details) return fullProjection(entries);
	return {
		observations: details.observations.filter((observation) => !details.droppedObservationIds.includes(observation.id)),
		reflections: details.reflections,
		droppedObservationIds: details.droppedObservationIds,
	};
}

export function compactionProjection(entries: readonly LedgerEntry[], firstKeptEntryId: string): CompactionProjection {
	const boundary = boundaryIndex(entries, firstKeptEntryId);
	const projection = project(entries, boundary, boundary, boundary);
	return {
		...projection,
		details: {
			type: "ob-memory.folded",
			version: 1,
			fullFold: true,
			observations: projection.observations,
			reflections: projection.reflections,
			droppedObservationIds: projection.droppedObservationIds,
			foldThroughEntryId: firstKeptEntryId,
			createdAt: new Date().toISOString(),
		},
	};
}

/** Latest entry id through which the observer has covered source context. */
export function latestCoverageId(entries: readonly LedgerEntry[], customType: string): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== customType) continue;
		if (customType === OM_OBSERVATIONS_RECORDED && !isObservationsRecordedData(entry.data)) continue;
		if (customType === OM_REFLECTIONS_RECORDED && !isReflectionsRecordedData(entry.data)) continue;
		if (customType === OM_OBSERVATIONS_DROPPED && !isObservationsDroppedData(entry.data)) continue;
		const id = coverageId(entry.data);
		if (id) return id;
	}
	return undefined;
}

export function latestCoverageIndex(
	entries: readonly LedgerEntry[],
	customType: string,
	indexes = entryIndexMap(entries),
): number {
	const id = latestCoverageId(entries, customType);
	return id ? (indexes.get(id) ?? -1) : -1;
}

export function rawTokensAfterIndex(
	entries: readonly LedgerEntry[],
	index: number,
	estimate: (entry: LedgerEntry) => number,
): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		const entry = entries[i];
		if (entry && (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")) {
			total += estimate(entry);
		}
	}
	return total;
}

/** Last compaction boundary, so trigger accounting ignores history already summarized. */
export function compactionRangeStartIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") return i;
	}
	return -1;
}

export function unobservedSourceSpanBefore(
	entries: readonly LedgerEntry[],
	cutIndex: number,
	coverageIndex: number,
): UnobservedSourceSpan | undefined {
	const entryIds: string[] = [];
	let firstIndex = -1;
	let lastIndex = -1;
	for (let i = Math.max(0, coverageIndex + 1); i < cutIndex; i++) {
		const entry = entries[i];
		if (!entry || (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary")) {
			continue;
		}
		if (firstIndex === -1) firstIndex = i;
		lastIndex = i;
		entryIds.push(entry.id);
	}
	if (firstIndex === -1) return undefined;
	return { firstIndex, lastIndex, entryCount: entryIds.length, entryIds };
}

export function observationTokens(observations: readonly Observation[]): number {
	return observations.reduce((total, observation) => total + observation.tokenCount, 0);
}

export function reflectionTokens(reflections: readonly Reflection[]): number {
	return reflections.reduce((total, reflection) => total + reflection.tokenCount, 0);
}

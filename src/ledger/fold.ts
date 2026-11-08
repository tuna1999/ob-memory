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
 * Index of the latest host `/clear` boundary (`reset_boundary` entry) at or
 * before `end`, or -1. The host drops every earlier message from model
 * context, and only a compaction recorded after the boundary is emitted again
 * (host session-context.ts and prepareCompaction).
 */
export function latestResetBoundaryIndex(entries: readonly LedgerEntry[], end = entries.length - 1): number {
	for (let i = Math.min(end, entries.length - 1); i >= 0; i--) {
		if (entries[i]?.type === "reset_boundary") return i;
	}
	return -1;
}

/**
 * Classifies ledger records against the latest `/clear` boundary.
 *
 * Memory distilled from cleared conversation must never reach the model
 * again: not in an owned compaction summary, not in the native-compaction
 * fallback, not in worker prompts and not through `ob_recall`. A record
 * survives only when it was appended after the boundary AND its coverage
 * watermark lies after it (a watermark that is not on the branch cannot be
 * placed after it, so it counts as cleared). Ledgers written by 0.3.2 and
 * earlier could mix both sides of a boundary in one record, so the rule is
 * strict: an observation is cleared when ANY cited source entry on the branch
 * lies at or before the boundary, and a reflection is cleared when ANY of its
 * supporting observations is cleared. Such a mixed record loses its
 * post-boundary facts too; current workers never write one (the chunker
 * starts after the boundary and the reflector sees only surviving records).
 * Ids that are not on the branch neither keep nor clear a record. Drops are
 * tombstones and are unaffected. Cleared records stay in the session file for
 * audit (`fullProjection`).
 */
export interface ResetView {
	/** Index of the boundary in the entries, or -1 when there is none. */
	readonly resetIndex: number;
	/** True when a ledger record at `position` with this payload describes post-boundary source. */
	keepsRecord(position: number, data: unknown): boolean;
	/** False when any cited source id that is on the branch lies at or before the boundary. */
	keepsObservation(observation: Observation): boolean;
	/** True for a branch entry at or before the boundary (cleared source context). */
	isClearedEntry(id: string): boolean;
}

const NO_RESET: ResetView = {
	resetIndex: -1,
	keepsRecord: () => true,
	keepsObservation: () => true,
	isClearedEntry: () => false,
};

export function resetView(
	entries: readonly LedgerEntry[],
	end = entries.length - 1,
	indexes?: Map<string, number>,
): ResetView {
	const resetIndex = latestResetBoundaryIndex(entries, end);
	if (resetIndex < 0) return NO_RESET;
	const positions = indexes ?? entryIndexMap(entries);
	return {
		resetIndex,
		keepsRecord: (position, data) => position > resetIndex && coverageIndex(data, positions) > resetIndex,
		keepsObservation: (observation) =>
			observation.sourceEntryIds.every((id) => {
				const index = positions.get(id);
				return index === undefined || index > resetIndex;
			}),
		isClearedEntry: (id) => {
			const index = positions.get(id);
			return index !== undefined && index <= resetIndex;
		},
	};
}

/**
 * A reflection is cleared when any supporting observation was cleared by the
 * latest `/clear` (an id that also has a surviving record resolves to that
 * record). Unknown ids neither keep nor clear it.
 */
export function reflectionSurvivesReset(
	reflection: Reflection,
	clearedObservationIds: ReadonlySet<string>,
	keptObservationIds: { has(id: string): boolean },
): boolean {
	if (clearedObservationIds.size === 0) return true;
	return !reflection.supportingObservationIds.some((id) => clearedObservationIds.has(id) && !keptObservationIds.has(id));
}

/** Shared record selection for `foldLedger` and the projections. */
interface FoldInputs {
	observationsById: Map<string, Observation>;
	reflectionsById: Map<string, Reflection>;
	droppedObservationIds: Set<string>;
}

function selectRecords(
	entries: readonly LedgerEntry[],
	end: number,
	reset: ResetView,
	includeObservations: (index: number, data: unknown) => boolean,
	includeReflections: (index: number, data: unknown) => boolean,
	includeDrops: (index: number, data: unknown) => boolean,
): FoldInputs {
	const observationsById = new Map<string, Observation>();
	const reflectionCandidates: Reflection[] = [];
	const clearedObservationIds = new Set<string>();
	const droppedObservationIds = new Set<string>();
	for (let i = 0; i <= end; i++) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType === OM_OBSERVATIONS_RECORDED) {
			if (!isObservationsRecordedData(entry.data) || !includeObservations(i, entry.data)) continue;
			const keepsRecord = reset.keepsRecord(i, entry.data);
			for (const observation of entry.data.observations) {
				if (!keepsRecord || !reset.keepsObservation(observation)) {
					clearedObservationIds.add(observation.id);
					continue;
				}
				if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation);
			}
			continue;
		}
		if (entry.customType === OM_REFLECTIONS_RECORDED) {
			if (!isReflectionsRecordedData(entry.data) || !includeReflections(i, entry.data)) continue;
			if (reset.keepsRecord(i, entry.data)) reflectionCandidates.push(...entry.data.reflections);
			continue;
		}
		if (entry.customType === OM_OBSERVATIONS_DROPPED) {
			if (!isObservationsDroppedData(entry.data) || !includeDrops(i, entry.data)) continue;
			for (const id of entry.data.observationIds) droppedObservationIds.add(id);
		}
	}
	const reflectionsById = new Map<string, Reflection>();
	for (const reflection of reflectionCandidates) {
		if (reflectionsById.has(reflection.id)) continue;
		if (!reflectionSurvivesReset(reflection, clearedObservationIds, observationsById)) continue;
		reflectionsById.set(reflection.id, reflection);
	}
	return { observationsById, reflectionsById, droppedObservationIds };
}

const ALWAYS = (): boolean => true;

/**
 * Fold valid ledger records from the branch root through `upToEntryId`.
 * First valid record wins by id; drops are tombstones and are retained even
 * when the dropped observation has not been seen yet. Records cleared by the
 * latest `/clear` at or before the boundary are excluded (see `ResetView`):
 * this fold feeds worker prompts and the native-compaction fallback.
 */
export function foldLedger(entries: readonly LedgerEntry[], upToEntryId?: string): FoldedLedger {
	const end = boundaryIndex(entries, upToEntryId);
	const { observationsById, reflectionsById, droppedObservationIds } = selectRecords(
		entries,
		end,
		resetView(entries, end),
		ALWAYS,
		ALWAYS,
		ALWAYS,
	);
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
	excludeCleared: boolean,
): Projection {
	const indexes = entryIndexMap(entries);
	// A tombstone is a decision about a live observation, not source context.
	// At the tip every recorded drop applies, even when its coverage watermark
	// is ahead of the observation boundary (otherwise a drop recorded just
	// before compaction could be ignored and the observation resurrected).
	const applyAllDrops = dropsBoundary >= entries.length - 1;
	const { observationsById, reflectionsById, droppedObservationIds } = selectRecords(
		entries,
		entries.length - 1,
		excludeCleared ? resetView(entries, entries.length - 1, indexes) : NO_RESET,
		(_index, data) => isCoveredAtOrBefore(data, indexes, observationsBoundary),
		(_index, data) => isCoveredAtOrBefore(data, indexes, reflectionsBoundary),
		(_index, data) => applyAllDrops || isCoveredAtOrBefore(data, indexes, dropsBoundary),
	);
	return {
		observations: Array.from(observationsById.values()).filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections: Array.from(reflectionsById.values()),
		droppedObservationIds: Array.from(droppedObservationIds),
	};
}

/**
 * Every record on the branch through `upToEntryId`, for audit
 * (`/ob-memory view full`). Records cleared by `/clear` are deliberately kept
 * here: this projection is shown to the user, never to the model. Every
 * model-facing path (compaction, worker prompts, the fallback, recall)
 * excludes them.
 */
export function fullProjection(entries: readonly LedgerEntry[], upToEntryId?: string): Projection {
	const boundary = boundaryIndex(entries, upToEntryId);
	return project(entries, boundary, boundary, boundary, false);
}

function latestCompactionIndex(entries: readonly LedgerEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") return i;
	}
	return -1;
}

/** Details of the latest compaction only, and only when ob-memory supplied it. */
/**
 * omp's notes-backed rollover (compaction.experimentalContextManagement) stores
 * a hook result's details wrapped as `{ kind: "experimental-context-rollover",
 * hookDetails }` (session-maintenance.ts `#compactExperimentalContext`).
 */
export function unwrapCompactionDetails(details: unknown): unknown {
	if (
		details !== null &&
		typeof details === "object" &&
		(details as Record<string, unknown>).kind === "experimental-context-rollover" &&
		"hookDetails" in details
	) {
		return (details as Record<string, unknown>).hookDetails;
	}
	return details;
}

export function latestCompactionDetails(entries: readonly LedgerEntry[]): MemoryDetails | undefined {
	const index = latestCompactionIndex(entries);
	if (index < 0) return undefined;
	const details = unwrapCompactionDetails(entries[index]?.details);
	return isMemoryDetails(details) ? details : undefined;
}

export function visibleProjection(entries: readonly LedgerEntry[]): Projection {
	const compactionIndex = latestCompactionIndex(entries);
	// Without a compaction, or after a `/clear` newer than the latest one (the
	// host then drops that summary from context), current memory is the live
	// ledger minus the records the boundary cleared.
	if (compactionIndex < 0 || latestResetBoundaryIndex(entries) > compactionIndex) {
		const tip = entries.length - 1;
		return project(entries, tip, tip, tip, true);
	}
	// A newer native compaction replaces the visible memory context. Showing an
	// older ob-memory compaction would label records as visible when the model
	// can no longer see them.
	const details = latestCompactionDetails(entries);
	if (!details) return { observations: [], reflections: [], droppedObservationIds: [] };
	return {
		observations: details.observations.filter((observation) => !details.droppedObservationIds.includes(observation.id)),
		reflections: details.reflections,
		droppedObservationIds: details.droppedObservationIds,
	};
}

export function compactionProjection(entries: readonly LedgerEntry[], firstKeptEntryId: string): CompactionProjection {
	const boundary = boundaryIndex(entries, firstKeptEntryId);
	// Observations/reflections fold through the summary cut, but drops are
	// tombstones: every drop recorded in the journal must apply to the compacted
	// memory, even if the observer had already covered entries past the cut.
	// The summary is recorded after any `/clear`, so records cleared by the
	// latest boundary are excluded; otherwise cleared conversation would
	// re-enter model context as memory.
	const projection = project(entries, boundary, boundary, entries.length - 1, true);
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

/**
 * Estimated source tokens after `index`. Entries at or before the latest
 * `/clear` boundary are never counted: they left model context and are never
 * observed, so they are not an unobserved backlog.
 */
export function rawTokensAfterIndex(
	entries: readonly LedgerEntry[],
	index: number,
	estimate: (entry: LedgerEntry) => number,
): number {
	let total = 0;
	for (let i = Math.max(0, index + 1, latestResetBoundaryIndex(entries) + 1); i < entries.length; i++) {
		const entry = entries[i];
		if (entry && (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")) {
			total += estimate(entry);
		}
	}
	return total;
}

export function observationTokens(observations: readonly Observation[]): number {
	return observations.reduce((total, observation) => total + observation.tokenCount, 0);
}

export function reflectionTokens(reflections: readonly Reflection[]): number {
	return reflections.reduce((total, reflection) => total + reflection.tokenCount, 0);
}

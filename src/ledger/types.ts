import {
	MEMORY_ID_PATTERN,
	OBSERVATION_TIMESTAMP_PATTERN,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	RELEVANCE_VALUES,
	estimateTextTokens,
	type Relevance,
} from "../constants";

export {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../constants";
export type { Relevance };

export interface LedgerEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	summary?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
	fromId?: string;
	fromExtension?: boolean;
	preserveData?: Record<string, unknown>;
}

export interface Observation {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
	tokenCount: number;
}

export interface Reflection {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
}

export interface ObservationsRecordedData {
	observations: Observation[];
	coversUpToId: string;
	createdAt?: string;
}

export interface ReflectionsRecordedData {
	reflections: Reflection[];
	coversUpToId: string;
	createdAt?: string;
}

export interface ObservationsDroppedData {
	observationIds: string[];
	coversUpToId: string;
	createdAt?: string;
}

export interface MemoryDetails {
	type: "ob-memory.folded";
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	droppedObservationIds: string[];
	foldThroughEntryId?: string;
	createdAt?: string;
}

const SOURCE_ENTRY_TYPES: Readonly<Record<string, true>> = {
	message: true,
	custom_message: true,
	branch_summary: true,
};

export function isSourceEntry(entry: LedgerEntry): boolean {
	return Object.hasOwn(SOURCE_ENTRY_TYPES, entry.type) && SOURCE_ENTRY_TYPES[entry.type] === true;
}

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!value.content.includes("\n") &&
		typeof value.timestamp === "string" &&
		OBSERVATION_TIMESTAMP_PATTERN.test(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!value.content.includes("\n") &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedData {
	return (
		isPlainRecord(value) &&
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedData {
	return (
		isPlainRecord(value) &&
		Array.isArray(value.reflections) &&
		value.reflections.length > 0 &&
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedData {
	return (
		isPlainRecord(value) &&
		isNonEmptyStringArray(value.observationIds) &&
		value.observationIds.every(isMemoryId) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	return (
		isPlainRecord(value) &&
		value.type === "ob-memory.folded" &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		Array.isArray(value.droppedObservationIds) &&
		value.droppedObservationIds.every(isMemoryId) &&
		(value.foldThroughEntryId === undefined || typeof value.foldThroughEntryId === "string")
	);
}

export function isObservationsRecordedEntry(
	entry: LedgerEntry,
): entry is LedgerEntry & { customType: string; data: ObservationsRecordedData } {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isReflectionsRecordedEntry(
	entry: LedgerEntry,
): entry is LedgerEntry & { customType: string; data: ReflectionsRecordedData } {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(
	entry: LedgerEntry,
): entry is LedgerEntry & { customType: string; data: ObservationsDroppedData } {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedData | undefined {
	if (observations.length === 0 || !coversUpToId) return undefined;
	return { observations, coversUpToId, createdAt: new Date().toISOString() };
}

export function buildReflectionsRecordedData(
	reflections: Reflection[],
	coversUpToId: string,
): ReflectionsRecordedData | undefined {
	if (reflections.length === 0 || !coversUpToId) return undefined;
	return { reflections, coversUpToId, createdAt: new Date().toISOString() };
}

export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedData | undefined {
	if (observationIds.length === 0 || !coversUpToId) return undefined;
	return { observationIds, coversUpToId, createdAt: new Date().toISOString() };
}

export function observationLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function observationLineTokens(observation: Pick<Observation, "id" | "timestamp" | "relevance" | "content">): number {
	return estimateTextTokens(`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`);
}

export function reflectionLineTokens(reflection: Pick<Reflection, "id" | "content">): number {
	return estimateTextTokens(`[${reflection.id}] ${reflection.content}`);
}

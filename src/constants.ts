export const EXTENSION_NAME = "ob-memory";
export const EXTENSION_VERSION = "0.1.1";

export const OM_OBSERVATIONS_RECORDED = "ob-memory.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "ob-memory.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "ob-memory.observations.dropped";
export const OM_FOLDED = "ob-memory.folded";
export const OM_LIFECYCLE = "ob-memory.lifecycle";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
export const OBSERVATION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export const MAX_RECORD_CONTENT_CHARS = 2_000;
export const MAX_SOURCE_ENTRY_CHARS = 40_000;

/** Fallback estimate used before a model is available or when tokenizer setup fails. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

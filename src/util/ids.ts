import { createHash } from "node:crypto";
import { MAX_RECORD_CONTENT_CHARS } from "../constants";

export function normalizeRecordContent(value: string): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= MAX_RECORD_CONTENT_CHARS) return oneLine;
	return `${oneLine.slice(0, MAX_RECORD_CONTENT_CHARS)} … [truncated ${oneLine.length - MAX_RECORD_CONTENT_CHARS} chars]`;
}

export function normalizeRecordContentStrict(value: string): string | undefined {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	if (oneLine.length > MAX_RECORD_CONTENT_CHARS) return undefined;
	return oneLine;
}

export function hashMemoryId(
	content: string,
	timestamp: string,
	sourceIds: readonly string[],
	existingIds?: ReadonlySet<string>,
): string {
	const base = `${content}\u0000${timestamp}\u0000${sourceIds.join(",")}`;
	for (let nonce = 0; ; nonce++) {
		const input = nonce === 0 ? base : `${base}\u0000${nonce}`;
		const id = createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
		if (!existingIds?.has(id)) return id;
	}
}

const PLACEHOLDER_CONTENT = /^(?:placeholder|n\/?a|none|nothing|tbd|todo|unknown|reflection|observation|memory|ok)\.?$/i;
const MIN_RECORD_CONTENT_CHARS = 8;

/**
 * Reject schema-shaped filler and tiny non-facts. A model that returns
 * "placeholder" must not create a durable reflection or observation.
 */
export function isLowValueRecordContent(content: string): boolean {
	const stripped = content.replace(/[.!?]+$/g, "").trim();
	return stripped.length < MIN_RECORD_CONTENT_CHARS || PLACEHOLDER_CONTENT.test(stripped);
}

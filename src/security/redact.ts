const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
	[/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
	[/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"],
	[/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"],
	[/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED GOOGLE KEY]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
	[/\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"',;}]{4,}/gi, "[REDACTED CREDENTIAL]"],
];

export function redactText(text: string): string {
	let result = text;
	for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
	return result;
}

/**
 * Redact strings in a structured value before it reaches a log. Depth is
 * bounded because worker/tool details can contain arbitrary nested payloads.
 */
export function redactValue(value: unknown, depth = 0): unknown {
	if (depth > 6) return "[depth limit]";
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
		if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|cookie|credential|private[_-]?key)$/i.test(key)) {
			result[key] = "[REDACTED]";
		} else {
			result[key] = redactValue(item, depth + 1);
		}
	}
	return result;
}

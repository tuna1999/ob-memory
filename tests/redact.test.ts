import { describe, expect, test } from "bun:test";
import { redactText, redactValue } from "../src/security/redact";

describe("redaction", () => {
	test("redacts common credential shapes", () => {
		const text = [
			"key sk-abcdefghijklmnopqrstuvwx",
			"anthropic sk-ant-abcdefghijklmnopqrstuvwx",
			"github ghp_abcdefghijklmnopqrstuvwxyz",
			"aws AKIAIOSFODNN7EXAMPLE",
			"Bearer abcdefghijklmnopqrstuvwxyz123456",
			"password=hunter2",
		].join("\n");
		const redacted = redactText(text);
		expect(redacted).not.toContain("sk-abcdef");
		expect(redacted).not.toContain("ghp_abcdef");
		expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(redacted).not.toContain("hunter2");
		expect(redacted).toContain("REDACTED");
	});

	test("redacts sensitive object keys but keeps token counts", () => {
		const value = redactValue({
			apiKey: "secret",
			authorization: "Bearer secret",
			tokenCount: 42,
			observations: [{ id: "aaaaaaaaaaaa", tokenCount: 7 }],
		}) as Record<string, unknown>;
		expect(value.apiKey).toBe("[REDACTED]");
		expect(value.authorization).toBe("[REDACTED]");
		expect(value.tokenCount).toBe(42);
		expect((value.observations as Array<Record<string, unknown>>)[0]?.tokenCount).toBe(7);
	});
});

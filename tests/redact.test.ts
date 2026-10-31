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
			"password: \"correct horse battery staple\"",
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
			"STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop",
			"clientSecret: superdupersecretvalue",
		].join("\n");
		const redacted = redactText(text);
		expect(redacted).not.toContain("sk-abcdef");
		expect(redacted).not.toContain("ghp_abcdef");
		expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(redacted).not.toContain("hunter2");
		expect(redacted).not.toContain("correct horse");
		expect(redacted).not.toContain("wJalrXUtnFEMI");
		expect(redacted).not.toContain("sk_live_51H");
		expect(redacted).not.toContain("superdupersecretvalue");
		expect(redacted).toContain("REDACTED");
	});

	test("redacts unquoted authorization headers", () => {
		const text = [
			"Authorization: Basic dXNlcjpwYXNzd29yZA==",
			"Proxy-Authorization: Basic dXNlcjpwYXNz",
			"Authorization: Bearer abcdefghijklmnop",
			"X-Auth-Token: Bearer zyxwvutsrqponmlk",
		].join("\n");
		const redacted = redactText(text);
		expect(redacted).not.toContain("dXNlcjpwYXNz");
		expect(redacted).not.toContain("abcdefghijklmnop");
		expect(redacted).not.toContain("zyxwvutsrqponmlk");
		expect(redacted).toContain("REDACTED AUTHORIZATION HEADER");
	});

	test("redacts sensitive object keys but keeps token counts", () => {
		const value = redactValue({
			apiKey: "secret",
			authorization: "Bearer secret",
			AWS_SECRET_ACCESS_KEY: "secret",
			refreshToken: "secret",
			secretKey: "secret",
			"Set-Cookie": "session=secret",
			tokenCount: 42,
			observations: [{ id: "aaaaaaaaaaaa", tokenCount: 7 }],
		}) as Record<string, unknown>;
		expect(value.apiKey).toBe("[REDACTED]");
		expect(value.authorization).toBe("[REDACTED]");
		expect(value.AWS_SECRET_ACCESS_KEY).toBe("[REDACTED]");
		expect(value.refreshToken).toBe("[REDACTED]");
		expect(value.secretKey).toBe("[REDACTED]");
		expect(value["Set-Cookie"]).toBe("[REDACTED]");
		expect(value.tokenCount).toBe(42);
		expect((value.observations as Array<Record<string, unknown>>)[0]?.tokenCount).toBe(7);
	});

	test("redacts URL userinfo passwords and keeps the rest of the URL", () => {
		const redacted = redactText(
			"DATABASE_URL_HOST postgres://admin:hunter2pass@db:5432/app and redis://:s3cr3t@cache:6379",
		);
		expect(redacted).not.toContain("hunter2pass");
		expect(redacted).not.toContain("s3cr3t");
		expect(redacted).toContain("postgres://admin:[REDACTED]@db:5432/app");
		expect(redacted).toContain("@cache:6379");
	});

	test("redacts short values of sensitive keys", () => {
		const redacted = redactText("password=abc pwd: x1 token=42");
		expect(redacted).not.toContain("abc");
		expect(redacted).not.toContain("x1");
		expect(redacted).not.toMatch(/token=42/);
	});

	test("does not redact URLs without credentials or non-sensitive short values", () => {
		const text = "see https://example.com/path?q=1 and http://localhost:8080 with tokenCount: 42 port=80";
		expect(redactText(text)).toBe(text);
	});
});

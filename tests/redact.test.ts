import { describe, expect, test } from "bun:test";
import { serializeEntry, serializeSourceEntries } from "../src/ledger/serialize";
import type { LedgerEntry } from "../src/ledger/types";
import { redactText, redactValue } from "../src/security/redact";
import { makeToolCall, messageEntry } from "./helpers";

const TIMESTAMP = "2026-10-29T10:00:00Z";

function toolCallEntry(id: string, name: string, args: Record<string, unknown>): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: new Date(TIMESTAMP).toISOString(),
		message: { role: "assistant", content: [makeToolCall(name, args)], timestamp: Date.parse(TIMESTAMP) },
	};
}

function toolResultEntry(id: string, toolName: string, output: string): LedgerEntry {
	return {
		type: "message",
		id,
		timestamp: new Date(TIMESTAMP).toISOString(),
		message: {
			role: "toolResult",
			toolName,
			content: [{ type: "text", text: output }],
			timestamp: Date.parse(TIMESTAMP),
		},
	};
}

/** Fake base64 key lines; each starts with a unique 24-character prefix. */
const KEY_LINES = Array.from({ length: 26 }, (_, index) =>
	`MIIE${String(index).padStart(2, "0")}vQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj`.slice(0, 64),
);

function pemBlock(label = "PRIVATE KEY", lines: readonly string[] = KEY_LINES): string {
	return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
}

function logLines(count: number): string {
	return Array.from({ length: count }, (_, index) => `build step ${index} finished without errors`).join("\n");
}

function expectNoKeyMaterial(text: string): void {
	for (const line of KEY_LINES) expect(text).not.toContain(line.slice(0, 24));
}

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

describe("redaction inside non-sensitive values", () => {
	test("redacts assignments inside serialized tool-call arguments", () => {
		const bash = redactText(
			serializeEntry(
				toolCallEntry("a1", "bash", {
					command: "export DB_PASSWORD=hunter2hunter2 && GITHUB_TOKEN=abcdef0123456789 npm run migrate",
				}),
			),
		);
		expect(bash).not.toContain("hunter2hunter2");
		expect(bash).not.toContain("abcdef0123456789");
		expect(bash).toContain("npm run migrate");

		const env = redactText(
			serializeEntry(
				toolCallEntry("a2", "write", {
					path: ".env",
					content: "APP_NAME=demo\nDB_PASSWORD=pgS3cret\nSTRIPE_SECRET_KEY=xyz123\n",
				}),
			),
		);
		expect(env).not.toContain("pgS3cret");
		expect(env).not.toContain("xyz123");
		expect(env).toContain("APP_NAME=demo");

		const config = redactText(
			serializeEntry(
				toolCallEntry("a3", "write", {
					path: "config.json",
					content: JSON.stringify({ user: "bob", password: "hunter2json" }, null, 2),
				}),
			),
		);
		expect(config).not.toContain("hunter2json");
		expect(config).toContain('\\"user\\": \\"bob\\"');
	});

	test("redacts assignments nested in JSON strings and after other keys", () => {
		const cases = [
			['{"command":"curl -u x PASSWORD=hunter2 https://a"}', "hunter2", "https://a"],
			['{"command":"export API_KEY=abc123def"}', "abc123def", "export "],
			['{"command":"PGPASSWORD=hunter2 psql -h db.internal"}', "hunter2", "psql -h db.internal"],
			['{"newText":"password: n3wS3cretPass"}', "n3wS3cretPass", '{"newText":"'],
			['{"content":"password: \\"hunter2\\" ok"}', "hunter2", " ok"],
			["command: DB_PASSWORD=x9", "x9", "command: "],
		] as const;
		for (const [input, secret, kept] of cases) {
			const redacted = redactText(input);
			expect(redacted).not.toContain(secret);
			expect(redacted).toContain(kept);
		}
	});

	test("redacts URL query credentials and keeps the rest of the URL", () => {
		const text = "url: https://x.io/?access_token=abcd1234 then GET https://api.example.com/v1?api_key=abcd1234efgh5678&page=2";
		const redacted = redactText(text);
		expect(redacted).not.toContain("abcd1234");
		expect(redacted).toContain("url: https://x.io/?");
		expect(redacted).toContain("https://api.example.com/v1?");
		expect(redacted).toContain("&page=2");
	});
});

describe("redaction stays on one line", () => {
	test("prompt strings do not swallow later source entries", () => {
		const entries = [
			toolResultEntry("t1", "read", 'import getpass\npw = getpass.getpass("Password: ")\nprint(\'ok\')'),
			messageEntry("u2", "user", "never push to main directly, always open a PR"),
			toolCallEntry("a3", "bash", { command: "git status" }),
			toolResultEntry("t4", "bash", 'read -p "Enter password: " pw\necho "$pw" > /dev/null'),
			messageEntry("u5", "user", "the old config had token: 'abc and it broke the login flow"),
			messageEntry("a6", "assistant", "Decision: migrate the database schema to v3 and drop the legacy_users table"),
			messageEntry("u7", "user", "Don't touch the billing tables"),
			toolResultEntry("t8", "read", 'key = input("API key: ")\nprint("got it")'),
			messageEntry("u9", "user", "thanks, that's all for today"),
		];
		const source = serializeSourceEntries(entries).text;
		const redacted = redactText(source);
		for (const entry of entries) expect(redacted).toContain(`[Source entry id: ${entry.id}]`);
		expect(redacted).toContain("never push to main directly, always open a PR");
		expect(redacted).toContain('{"command":"git status"}');
		expect(redacted).toContain("Decision: migrate the database schema to v3 and drop the legacy_users table");
		expect(redacted).toContain("Don't touch the billing tables");
		expect(redacted).toContain("thanks, that's all for today");
		expect(redacted).toContain('getpass.getpass("Password: ")');
		expect(redacted).toContain('read -p "Enter password: " pw');
		// The unclosed quote still redacts the word after it, but nothing beyond the line.
		expect(redacted).not.toContain("'abc");
		expect(redacted).toContain("and it broke the login flow");
	});

	test("a prompt string in one memory line does not erase the following lines", () => {
		const rendered = [
			'[0123456789ab] 2026-10-29 10:00 [medium] cli.py prompts with getpass("Password: ") before calling the API.',
			'[0123456789ac] 2026-10-29 10:01 [critical] User said never push to main; always open a "PR" first.',
			'[0123456789ad] 2026-10-29 10:02 [high] deploy.sh asks read -p "Token: " for the deploy token.',
			'[0123456789ae] 2026-10-29 10:03 [high] The "billing" tables are off limits.',
		].join("\n");
		expect(redactText(rendered)).toBe(rendered);
	});

	test("BEGIN and END markers in different entries do not erase the entries between them", () => {
		const entries = [
			toolResultEntry("t1", "bash", "-----BEGIN RSA PRIVATE KEY-----"),
			messageEntry("a2", "assistant", "Decision: migrate the database schema to v3 and drop the legacy_users table"),
			messageEntry("u3", "user", "Don't touch the billing tables"),
			toolResultEntry("t4", "bash", "-----END RSA PRIVATE KEY-----"),
		];
		const redacted = redactText(serializeSourceEntries(entries).text);
		for (const entry of entries) expect(redacted).toContain(`[Source entry id: ${entry.id}]`);
		expect(redacted).toContain("Decision: migrate the database schema to v3 and drop the legacy_users table");
		expect(redacted).toContain("Don't touch the billing tables");
		expect(redacted).not.toContain("-----BEGIN");
		expect(redacted).not.toContain("-----END");
	});
});

describe("sensitive key detection", () => {
	test("redacts AWS CLI credential JSON", () => {
		const credentials = {
			Credentials: {
				AccessKeyId: "ASIAIOSFODNN7EXAMPLE",
				SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				SessionToken: "FwoGZXIvYXdzEJrExampleSessionTokenValue",
				Expiration: "2026-10-29T11:00:00Z",
			},
		};
		for (const output of [JSON.stringify(credentials), JSON.stringify(credentials, null, 2)]) {
			const redacted = redactText(output);
			expect(redacted).not.toContain("ASIAIOSFODNN7EXAMPLE");
			expect(redacted).not.toContain("wJalrXUtnFEMI");
			expect(redacted).not.toContain("FwoGZXIvYXdzEJr");
			expect(redacted).toContain("2026-10-29T11:00:00Z");
		}
		const ini = redactText("[default]\naws_access_key_id = AKIA0000EXAMPLE\naws_secret_access_key = wJalrXUtnFEMIK7MDENG\nregion = eu-west-1");
		expect(ini).not.toContain("wJalrXUtnFEMIK7MDENG");
		expect(ini).toContain("region = eu-west-1");
	});

	test("splits camelCase, snake_case and kebab-case keys into words", () => {
		const sensitive = [
			"SecretAccessKey",
			"secretAccessKey",
			"secret_access_key",
			"aws_secret_access_key",
			"clientSecret",
			"X-Api-Key",
			"x-api-key",
			"APIKey",
			"PGPASSWORD",
			"DB_PASS",
			"X-Amz-Security-Token",
			"Ocp-Apim-Subscription-Key",
			"spring.datasource.password",
		];
		const neutral = [
			"tokenizer",
			"tokens",
			"maxTokens",
			"max_tokens",
			"inputTokens",
			"tokenCount",
			"token_type",
			"secretary",
			"passwordless",
			"password_file",
			"secretName",
			"public_key",
			"primary_key",
			"sessionId",
			"pass",
		];
		const value = redactValue(
			Object.fromEntries([...sensitive, ...neutral].map((key) => [key, "plainvalue"])),
		) as Record<string, unknown>;
		for (const key of sensitive) expect(value[key]).toBe("[REDACTED]");
		for (const key of neutral) expect(value[key]).toBe("plainvalue");

		for (const key of sensitive) {
			expect(redactText(`set ${key}=hunter2value now`)).toBe("set [REDACTED CREDENTIAL] now");
		}
		for (const key of neutral) {
			const text = `set ${key}=plainvalue now`;
			expect(redactText(text)).toBe(text);
		}
	});
});

describe("private-key redaction", () => {
	test("redacts PGP armored private key blocks", () => {
		const armored = [
			"-----BEGIN PGP PRIVATE KEY BLOCK-----",
			"Version: GnuPG v2",
			"Comment: Alice's signing key",
			"",
			...KEY_LINES.slice(0, 8),
			"=XyZ1",
			"-----END PGP PRIVATE KEY BLOCK-----",
		].join("\n");
		const redacted = redactText(`gpg --export-secret-keys --armor\n${armored}\nexit 0`);
		expectNoKeyMaterial(redacted);
		expect(redacted).toBe("gpg --export-secret-keys --armor\n[REDACTED PRIVATE KEY]\nexit 0");
	});

	test("redacts a key whose END marker was cut off by truncation", () => {
		const atEnd = redactText(`dump:\n-----BEGIN EC PRIVATE KEY-----\n${KEY_LINES.slice(0, 5).join("\n")}\nMIIEab`);
		expectNoKeyMaterial(atEnd);
		expect(atEnd).toBe("dump:\n[REDACTED PRIVATE KEY]");

		// truncateRendered keeps about 19,960 head characters of a 40,000 cap, so
		// a key starting at 19,600 loses its END line to the cut.
		const output = `${logLines(600).slice(0, 19_600)}\n${pemBlock()}\n${logLines(1200)}`;
		const serialized = serializeEntry(toolResultEntry("t1", "bash", output));
		expect(serialized).toContain("chars truncated");
		expect(serialized).toContain("-----BEGIN PRIVATE KEY-----");
		expect(serialized).not.toContain("-----END PRIVATE KEY-----");
		const redacted = redactText(serialized);
		expectNoKeyMaterial(redacted);
		expect(redacted).toContain("[REDACTED PRIVATE KEY]");
		// The truncation marker and the text after it survive.
		expect(redacted).toContain("chars truncated; original remains in the session ledger");
		expect(redacted).toContain("build step 1199 finished without errors");
	});

	test("redacts a key body whose BEGIN marker was cut off by truncation", () => {
		// The kept tail is about 19,960 characters: with 19,600 after the key,
		// the END line survives and the BEGIN line is cut.
		const output = `${logLines(800)}\n${pemBlock()}\n${logLines(600).slice(0, 19_600)}`;
		const serialized = serializeEntry(toolResultEntry("t1", "bash", output));
		expect(serialized).toContain("chars truncated");
		expect(serialized).not.toContain("-----BEGIN PRIVATE KEY-----");
		expect(serialized).toContain("-----END PRIVATE KEY-----");
		expect(serialized).toContain(KEY_LINES[25]?.slice(0, 24) ?? "missing");
		const redacted = redactText(serialized);
		expectNoKeyMaterial(redacted);
		expect(redacted).not.toContain("-----END PRIVATE KEY-----");
		expect(redacted).toContain("chars truncated; original remains in the session ledger");
		expect(redacted).toContain("build step 0 finished without errors");
		expect(redacted).toContain("build step 300 finished without errors");
	});

	test("redacts a key split by per-entry truncation in a source chunk", () => {
		const entry = toolResultEntry("t1", "bash", `${pemBlock("RSA PRIVATE KEY")}\n${logLines(300)}`);
		const source = serializeSourceEntries([entry], { perEntryMaxChars: 1_000 });
		expect(source.truncatedSourceEntryIds).toEqual(["t1"]);
		expect(source.text).toContain("-----BEGIN RSA PRIVATE KEY-----");
		expect(source.text).not.toContain("-----END RSA PRIVATE KEY-----");
		const redacted = redactText(source.text);
		expectNoKeyMaterial(redacted);
		expect(redacted).toContain("[Source entry id: t1]");
	});

	test("redacts keys in JSON-escaped, diff and numbered renderings", () => {
		const json = redactText(serializeEntry(toolCallEntry("a1", "write", { path: "key.pem", content: `${pemBlock()}\n` })));
		expectNoKeyMaterial(json);
		expect(json).toContain('"path":"key.pem"');

		const unterminatedJson = redactText(JSON.stringify({ content: `-----BEGIN PRIVATE KEY-----\n${KEY_LINES.slice(0, 3).join("\n")}` }));
		expectNoKeyMaterial(unterminatedJson);

		const diff = ["+-----BEGIN OPENSSH PRIVATE KEY-----", ...KEY_LINES.map((line) => `+${line}`), "+-----END OPENSSH PRIVATE KEY-----", " context"].join("\n");
		expect(redactText(diff)).toBe("+[REDACTED PRIVATE KEY]\n context");

		const numbered = pemBlock().split("\n").map((line, index) => `${index + 1}|${line}`).join("\n");
		expectNoKeyMaterial(redactText(numbered));
	});

	test("leaves public keys and certificates alone", () => {
		const text = pemBlock("PUBLIC KEY", KEY_LINES.slice(0, 2)) + "\n" + pemBlock("CERTIFICATE", KEY_LINES.slice(2, 4));
		expect(redactText(text)).toBe(text);
	});
});

describe("auth-scheme credentials", () => {
	test("leaves prose that follows Basic, Digest or Bearer alone", () => {
		const prose = [
			"Basic understanding of the system is enough.",
			"Bearer tokenization strategies are out of scope.",
			"Add basic authentication to /admin before release.",
			"Keep the basic structure of src/ledger/fold.ts unchanged.",
			"Implemented basic functionality; next is the digest algorithm and Bearer authentication docs.",
			"Requires Basic JavaScript knowledge and Basic PostgreSQL skills.",
			"The digest notification goes out daily.",
		].join("\n");
		expect(redactText(prose)).toBe(prose);
	});

	test("redacts credential-shaped tokens after the scheme word", () => {
		const text = [
			"auth Basic dXNlcjpwYXNzd29yZA==",
			"headers.set('Authorization', 'Basic dXNlcjpwYXNz')",
			"use Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
			"curl -H 'X: bearer abcdefghijklmnopqrstuvwxyz123456'",
		].join("\n");
		const redacted = redactText(text);
		expect(redacted).not.toContain("dXNlcjpwYXNz");
		expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
		expect(redacted).toContain("Bearer [REDACTED]");
		expect(redacted).toContain("[REDACTED AUTH CREDENTIAL]");
	});
});

describe("multi-word values", () => {
	test("dotenv and YAML lines redact through the end of the line", () => {
		const text = [
			"$ cat .env config.yml",
			"APP_NAME=demo",
			"MAIL_PASSWORD=my secret phrase",
			"export SMTP_PASSWORD=correct horse battery staple",
			"database:",
			"  password: correct horse battery staple",
			"  - token: pass phrase words",
			"  host: db.internal",
		].join("\n");
		const redacted = redactText(text);
		for (const word of ["secret phrase", "horse", "battery", "staple", "phrase words"]) expect(redacted).not.toContain(word);
		expect(redacted).toContain("APP_NAME=demo");
		expect(redacted).toContain("  host: db.internal");
		expect(redacted.split("\n")).toHaveLength(8);
	});

	test("inline shell assignments stop at whitespace", () => {
		expect(redactText("run it with PASSWORD=x9 psql -h db")).toBe("run it with [REDACTED CREDENTIAL] psql -h db");
	});

	test("line values stop at comments and do not swallow prose sentences", () => {
		expect(redactText("SMTP_PASSWORD=abc def # rotated by ops")).toBe("[REDACTED CREDENTIAL] # rotated by ops");
		expect(redactText("Password: must be rotated every 90 days per policy")).toBe(
			"[REDACTED CREDENTIAL] be rotated every 90 days per policy",
		);
	});
});

describe("code and prose that must be left alone", () => {
	test("does not redact type annotations, references or calls", () => {
		const code = [
			"function login(password: string, token: string): Promise<void> {",
			"def login(password: str) -> None:",
			"const token = await fetchToken();",
			'token = request.headers.get("Authorization")',
			'password = os.environ["DB_PASSWORD"]',
			"secret: ${{ secrets.DEPLOY_KEY }}",
			"PASSWORD=$DB_PASSWORD",
			"match Token::Ident and token::Token",
			"tokenizer: bpe, tokens: 42, maxTokens: 100, secretary: Jane, passwordless: true",
			'pw = getpass.getpass("Password: ")',
		].join("\n");
		expect(redactText(code)).toBe(code);
	});
});

describe("redaction is idempotent", () => {
	test("redacting twice equals redacting once", () => {
		const samples = [
			'[tool call bash({"command":"export DB_PASSWORD=hunter2 && GITHUB_TOKEN=abcdef0123456789 npm run migrate"})]',
			"Authorization: Bearer abcdefghijklmnop\npassword: Bearer abcdef0123456789xyz",
			"token: 'abc and it broke\nMAIL_PASSWORD=my secret phrase",
			'"password": "hunter2", url: https://u:p@x.io/?api_key=abc&x=1',
			`${pemBlock()}\n-----BEGIN RSA PRIVATE KEY-----\n${KEY_LINES[0]}\n[… 9 chars truncated …]\n-----END PRIVATE KEY-----`,
			"auth Basic dXNlcjpwYXNzd29yZA== and password: [REDACTED API KEY] and sk-abcdefghijklmnopqrstuvwx",
		];
		const fragments = [
			"password", "token", "api_key", "url", "x", "=", ": ", " ", "\n", "\\n", '\\"', '"', "'", "(", ")", "&", "?",
			"hunter2", "abc def", "Bearer ", "Basic ", "dXNlcjpwYXNz", "https://", "u:p@h", "[REDACTED]",
			"-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", KEY_LINES[0] ?? "", "export ", "12|", "getpass(",
		];
		// Deterministic pseudo-random concatenations of tricky fragments.
		let seed = 7;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let i = 0; i < 3_000; i++) {
			let sample = "";
			const count = 1 + Math.floor(next() * 12);
			for (let j = 0; j < count; j++) sample += fragments[Math.floor(next() * fragments.length)];
			samples.push(sample);
		}
		for (const sample of samples) {
			const once = redactText(sample);
			expect(redactText(once)).toBe(once);
		}
	});
});

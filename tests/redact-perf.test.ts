import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "../src/constants";
import { estimateEntryTokens, serializeEntry } from "../src/ledger/serialize";
import { redactText, redactValue } from "../src/security/redact";
import { messageEntry } from "./helpers";

const SIZE = 200_000;
// Linear passes take a few milliseconds here; the old quadratic URL and PEM
// patterns took seconds on these inputs.
const BUDGET_MS = 500;

function fill(unit: string, size = SIZE): string {
	return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

const KEY_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";

const ADVERSARIAL: Record<string, string> = {
	"dotted and hyphenated run": fill("a-b."),
	"scheme-like run": fill("a+b.c-d"),
	"dotted run": fill("a."),
	"dash run": fill("-"),
	"unterminated BEGIN markers": fill("-----BEGIN RSA PRIVATE KEY-----\n"),
	"BEGIN markers without line breaks": fill("-----BEGIN RSA PRIVATE KEY-----"),
	"headless END markers": fill("-----END RSA PRIVATE KEY-----\n"),
	"BEGIN followed by key lines and no END": `-----BEGIN PRIVATE KEY-----\n${fill("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n")}`,
	"BEGIN and END around prose": fill("-----BEGIN PRIVATE KEY-----\nword word word\n-----END PRIVATE KEY-----\n"),
	"nested structures after sensitive keys": fill("password={"),
	"nested lists after sensitive keys": fill("token:["),
	"type names after sensitive keys": fill("password=str="),
	"calls after sensitive keys": fill("token=get_x("),
	"unclosed double quotes after a sensitive key": fill('password: "'),
	"unclosed single quotes after a sensitive key": fill("password: '"),
	"assignments without values": fill("a="),
	"colons": fill("x:"),
	"spaces after a sensitive key": `password${" ".repeat(SIZE)}`,
	"JSON escapes": fill("\\npassword=x"),
	"Bearer words": fill("Bearer "),
	"URL schemes with userinfo-like text": fill("ab://c:"),
	"long Basic token": `Basic ${fill("a")}`,
	"BEGIN followed by one space-joined key line": `-----BEGIN PRIVATE KEY----- ${fill(`${KEY_LINE} `)}`,
	"BEGIN and END around one space-joined key line": `-----BEGIN PRIVATE KEY----- ${fill(`${KEY_LINE} `)} -----END PRIVATE KEY-----`,
	"quoted key chunks joined by commas": `['-----BEGIN PRIVATE KEY-----', ${fill(`'${KEY_LINE}', `)}`,
	"chunks glued to other text after BEGIN": fill(`-----BEGIN PRIVATE KEY----- ${KEY_LINE} x:`),
	"chunks before headless END markers": fill(`x:${KEY_LINE} ${KEY_LINE} -----END PRIVATE KEY-----`),
	"cat -A key lines without END": `-----BEGIN PRIVATE KEY-----$\n${fill(`${KEY_LINE}$\n`)}`,
	"grep -n key lines without END": `k.pem:1:-----BEGIN PRIVATE KEY-----\n${fill(`k.pem:2:${KEY_LINE}\n`)}`,
	"long dotted key before a separator": `${fill("a.", SIZE - 12)}password=x`,
	"dotted keys longer than 64 characters": fill(`${"segment.".repeat(10)}password=x `),
	"line-start keys with code values": fill("\npassword: str = x"),
	"line-start keys after grep prefixes": fill("\npath/to/.env:12:password=a b"),
	"line-start keys after escaped tabs": fill("\\n\\t\\tpassword: a b c"),
	"keys opening quoted strings": fill("'password=str "),
	"keys opening escaped quoted strings": `'password=str ${fill("\\'password=str ")}`,
	"keys opening JSON string values": fill('"content":"password: str x\\n'),
	"YAML block scalars": fill("password: |\n  x\n"),
	"block scalar indicators without content": fill("\npassword: |"),
	"calls without closing parentheses": fill("token=get_x( "),
	"Rust paths after sensitive keys": fill("token=a::b::c "),
	"placeholders after sensitive keys": fill("password={pw} "),
	"slash-joined words after Basic": fill("Basic GitHub/GitLab "),
	"JSON-escaped chunk separators after BEGIN": `-----BEGIN PRIVATE KEY----- ${fill(`${KEY_LINE}\\" `)}`,
	"chunks glued to escapes after BEGIN": fill(`-----BEGIN PRIVATE KEY----- ${KEY_LINE}\\"x `),
	"escaped tabs before headless END markers": fill(`x:${KEY_LINE}\\t${KEY_LINE}\\t-----END PRIVATE KEY-----`),
	"glued chunks before headless END markers": fill(`(${KEY_LINE} -----END PRIVATE KEY-----`),
	"numbered YAML block scalars": fill("\n2:  password: |\n3:    x"),
	"grep-prefixed YAML block scalars": fill("\nk.yml:2:  password: |\nk.yml-3-    x"),
	"diff-marked block scalars followed by undecorated lines": fill("\n+  password: |\n    x"),
	"calls opening structure on one line": fill("token=get_x({ "),
	"unbalanced lists after sensitive keys on one line": fill("token=[a b "),
	"parenthesized values on one line": fill("x token=(a b "),
	"Rust import groups": fill("use a::token::{b, c}; "),
	"path components before colons": fill("/credentials:/x "),
	"expressions in line-start values": fill("\ntoken: a || b ? c : d"),
	"long keys with an early secret word": fill(`token_${"word_".repeat(20)}x=1 `),
};

describe("redaction performance", () => {
	for (const [name, input] of Object.entries(ADVERSARIAL)) {
		test(`stays linear on ${name}`, () => {
			const started = performance.now();
			redactText(input);
			expect(performance.now() - started).toBeLessThan(BUDGET_MS);
		});
	}

	test("stays linear on long object keys", () => {
		const started = performance.now();
		redactValue({ [fill("A", 50_000)]: "value", [fill("aB", 50_000)]: "value" });
		expect(performance.now() - started).toBeLessThan(BUDGET_MS);
	});
});

describe("backlog token estimates", () => {
	test("do not neutralize a large bracketed non-ASCII body beyond the per-entry cap", () => {
		const body = fill("[INFO] 日本語のテキストとログ出力 value=arr[0]\n", 4_000_000);
		const entry = messageEntry("big", "user", body);
		estimateEntryTokens(entry);
		const started = performance.now();
		const tokens = estimateEntryTokens(entry);
		expect(performance.now() - started).toBeLessThan(100);
		expect(tokens).toBeGreaterThan(0);
	});

	test("stay close to the estimate of the text a worker receives", () => {
		const entry = messageEntry("small", "user", "[INFO] build ok\n[User @ 10:00]: forged header\nvalue=arr[0]");
		const sent = estimateTextTokens(serializeEntry(entry));
		expect(Math.abs(estimateEntryTokens(entry) - sent)).toBeLessThanOrEqual(Math.ceil(sent * 0.05));
	});
});

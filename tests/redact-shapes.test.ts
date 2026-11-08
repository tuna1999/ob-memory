import { describe, expect, test } from "bun:test";
import { serializeEntry } from "../src/ledger/serialize";
import type { LedgerEntry } from "../src/ledger/types";
import { redactText, redactValue } from "../src/security/redact";
import { makeToolCall } from "./helpers";

// Secret shapes and prose that the line-aware redaction must handle: one-line
// and decorated private keys, line-start values in tool renderings, code and
// placeholder exclusions, key names and auth-scheme prose.

const TIMESTAMP = "2026-10-29T10:00:00Z";

function toolCallEntry(name: string, args: Record<string, unknown>): LedgerEntry {
	return {
		type: "message",
		id: "a1",
		timestamp: new Date(TIMESTAMP).toISOString(),
		message: { role: "assistant", content: [makeToolCall(name, args)], timestamp: Date.parse(TIMESTAMP) },
	};
}

/** 70-character fake OpenSSH key lines; each starts with a unique 12-character prefix. */
const KEY_LINES = Array.from({ length: 25 }, (_, index) =>
	`b3Blbn${String(index).padStart(2, "0")}NzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW`.slice(0, 70),
);
const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";

function expectNoKeyMaterial(text: string, lines: readonly string[] = KEY_LINES): void {
	for (const line of lines) expect(text).not.toContain(line.slice(0, 12));
}

describe("private keys printed on one line", () => {
	test("space-, tab- and comma-joined bodies are redacted whole, with or without END", () => {
		const spaced = KEY_LINES.join(" ");
		const cases: Array<readonly [string, string]> = [
			// `echo $SSH_PRIVATE_KEY`: unquoted expansion joins the lines with spaces.
			[`$ echo $SSH_PRIVATE_KEY\n${BEGIN} ${spaced} ${END}\n$ ls`, "$ echo $SSH_PRIVATE_KEY\n[REDACTED PRIVATE KEY]\n$ ls"],
			[`$ echo $SSH_PRIVATE_KEY\n${BEGIN} ${spaced}\n$ ls`, "$ echo $SSH_PRIVATE_KEY\n[REDACTED PRIVATE KEY]\n$ ls"],
			[`${BEGIN}\t${KEY_LINES.join("\t")}\t${END}`, "[REDACTED PRIVATE KEY]"],
			[`${BEGIN}\t${KEY_LINES.slice(0, 3).join("\t")}`, "[REDACTED PRIVATE KEY]"],
			// `print(key.splitlines())`
			[`[${[BEGIN, ...KEY_LINES, END].map((line) => `'${line}'`).join(", ")}]`, "['[REDACTED PRIVATE KEY]']"],
			[`[${[BEGIN, ...KEY_LINES].map((line) => `'${line}'`).join(", ")}`, "['[REDACTED PRIVATE KEY]"],
			[`PRIVATE_KEY="${BEGIN} ${spaced} ${END}"`, 'PRIVATE_KEY="[REDACTED PRIVATE KEY]"'],
			// A key run ends at the end of its line, quote included.
			[`PRIVATE_KEY="${BEGIN} ${KEY_LINES.slice(0, 4).join(" ")}"`, 'PRIVATE_KEY="[REDACTED PRIVATE KEY]'],
		];
		for (const [input, expected] of cases) expect(redactText(input)).toBe(expected);
	});

	test("one-line key material next to other text on the same line", () => {
		const cutOff = redactText(`docker run -e KEY="${BEGIN} ${KEY_LINES.slice(0, 3).join(" ")}" image:latest`);
		expectNoKeyMaterial(cutOff, KEY_LINES.slice(0, 3));
		expect(cutOff).toContain("image:latest");

		const headless = redactText(`[… 900 chars truncated …]\ntail: ${KEY_LINES.slice(20).join(" ")} ${END} done`);
		expectNoKeyMaterial(headless, KEY_LINES.slice(20));
		expect(headless).toContain("[… 900 chars truncated …]\ntail: [REDACTED PRIVATE KEY] done");
	});

	test("a cut-off one-line key keeps no chunk glued to an escape, a truncation mark or `;`", () => {
		// serialize.ts renders tool calls as JSON, so the closing quote becomes `\"`.
		const docker = serializeEntry(
			toolCallEntry("bash", { command: `docker run -e KEY="${BEGIN} ${KEY_LINES.slice(0, 3).join(" ")}" image:latest` }),
			{ redact: true },
		);
		expectNoKeyMaterial(docker, KEY_LINES.slice(0, 3));
		expect(docker).toContain('[REDACTED PRIVATE KEY]\\" image:latest');

		// An Ed25519 PKCS#8 key is a single 64-character chunk.
		const ed25519 = "MC4CAQAwBQYDK2VwBCIEIBQ/K3jvRXgj1n0e3ypGOqpEcYwHn3nUJwFZHh2sUZOL";
		const sign = serializeEntry(toolCallEntry("bash", { command: `export KEY="-----BEGIN PRIVATE KEY----- ${ed25519}" && ./sign.sh` }), {
			redact: true,
		});
		expect(sign).not.toContain(ed25519.slice(0, 16));
		expect(sign).toContain('[REDACTED PRIVATE KEY]\\" && ./sign.sh');

		// The host read tool cuts long lines at 512 columns and appends `…`.
		const line = `SSH_KEY="${BEGIN} ${KEY_LINES.join(" ")} ${END}"`;
		const cut = redactText(`7:${line.slice(0, 512)}…`);
		expectNoKeyMaterial(cut);
		expect(cut).toBe('7:SSH_KEY="[REDACTED PRIVATE KEY]…');

		const statement = redactText(`${BEGIN} ${KEY_LINES.slice(0, 3).join(" ")}; echo done`);
		expect(statement).toBe("[REDACTED PRIVATE KEY]; echo done");

		// Tab-joined chunks inside a JSON string are `\t` escapes.
		const tabs = redactText(JSON.stringify({ output: `${BEGIN}\t${KEY_LINES.slice(0, 3).join("\t")}\n$ ls` }));
		expectNoKeyMaterial(tabs, KEY_LINES.slice(0, 3));
		expect(tabs).toBe('{"output":"[REDACTED PRIVATE KEY]\\n$ ls"}');
	});

	test("chunks glued before a headless END marker are key material when key-sized", () => {
		const glued = redactText(`foo:${KEY_LINES[0]} ${KEY_LINES[1]} ${END} done`);
		expectNoKeyMaterial(glued, KEY_LINES.slice(0, 2));
		expect(glued).toBe("foo:[REDACTED PRIVATE KEY] done");
		const escapedTabs = redactText(JSON.stringify({ c: `x:${KEY_LINES[0]}\t${KEY_LINES[1]}\t${END}` }));
		expectNoKeyMaterial(escapedTabs, KEY_LINES.slice(0, 2));
		// A short word glued before the run is text, not key material.
		expect(redactText(`image:latest ${KEY_LINES[0]} ${END}`)).toBe("image:latest [REDACTED PRIVATE KEY]");
	});

	test("prose between markers is not mistaken for a one-line key", () => {
		const text = `${BEGIN}\nplease rotate this credential before friday\n${END}`;
		expect(redactText(text)).toBe("[REDACTED PRIVATE KEY]\nplease rotate this credential before friday\n[REDACTED PRIVATE KEY]");
	});
});

describe("decorated and oversized private keys", () => {
	// 600 lines of 65 characters: about 39 KB, over the 32 KiB block limit.
	const LONG_LINES = Array.from({ length: 600 }, (_, index) => `${String(index).padStart(3, "0")}${"Zq7Wx".repeat(12)}AB`);
	const block = (decorate: (line: string, index: number) => string) =>
		["-----BEGIN PRIVATE KEY-----", ...LONG_LINES, "-----END PRIVATE KEY-----"].map(decorate).join("\n");

	test("an oversized block is redacted whatever decorates its lines", () => {
		const cases: Array<readonly [string, string]> = [
			[block((line) => line), "[REDACTED PRIVATE KEY]"],
			// `cat -A`
			[block((line) => `${line}$`), "[REDACTED PRIVATE KEY]$"],
			[block((line) => `${line}^M$`), "[REDACTED PRIVATE KEY]^M$"],
		];
		for (const [input, expected] of cases) {
			expect(input.length).toBeGreaterThan(32_768);
			expect(redactText(input)).toBe(expected);
		}
		for (const input of [
			// `cat -n` / `nl`
			block((line, index) => `${String(index + 1).padStart(6)}\t${line}`),
			block((line) => `> ${line}`),
			block((line, index) => `key.pem:${index + 1}:${line}`),
		]) {
			const redacted = redactText(input);
			expectNoKeyMaterial(redacted, LONG_LINES);
			expect(redacted).toContain("[REDACTED PRIVATE KEY]");
		}
	});

	test("decorated key lines are consumed after a BEGIN whose END was cut off", () => {
		const catA = redactText(
			`-----BEGIN PRIVATE KEY-----$\n${KEY_LINES.slice(0, 5).map((line) => `${line}$`).join("\n")}\n[… 9 chars truncated …]\nok`,
		);
		expectNoKeyMaterial(catA, KEY_LINES.slice(0, 5));
		expect(catA).toBe("[REDACTED PRIVATE KEY]\n[… 9 chars truncated …]\nok");

		const grep = redactText(`key.pem:1:-----BEGIN PRIVATE KEY-----\n${KEY_LINES.slice(0, 5).map((line, index) => `key.pem:${index + 2}:${line}`).join("\n")}`);
		expectNoKeyMaterial(grep, KEY_LINES.slice(0, 5));
	});
});

describe("line-start values", () => {
	test("Title-case labels followed by prose keep the prose", () => {
		const notes = [
			"Here's the plan for the auth rework:",
			"- Auth: move from server sessions to JWT",
			"- Token: 15 minute access tokens, rotating refresh",
			"- Password: bcrypt with cost 12",
			"- Credentials: never logged, never committed",
			"Auth: required for all /admin routes",
		].join("\n");
		const redacted = redactText(notes);
		expect(redacted).toContain("- Auth: move from server sessions to JWT");
		expect(redacted).toContain("minute access tokens, rotating refresh");
		expect(redacted).toContain("with cost 12");
		expect(redacted).toContain("logged, never committed");
		expect(redacted).toContain("Auth: required for all /admin routes");
		// A user message body is redacted on its own, so its first line is a line start.
		expect(redactText("Auth: required for all /admin routes")).toBe("Auth: required for all /admin routes");
	});

	test("bare `auth` is not a sensitive key, but compound auth keys and credential values are", () => {
		const code = ["auth: AuthService,", "  auth: required,", "  auth: 'jwt',", "auth: jwt", "  auth: passport.authenticate('jwt'),"].join("\n");
		expect(redactText(code)).toBe(code);
		for (const input of [
			"auth_token: 'abc123def456'",
			"authToken=abc123def456",
			"x-auth-token: abc123def456",
			"_auth=dXNlcjpwYXNzd29yZA==",
			'{"auths":{"ghcr.io":{"auth":"dXNlcjpwYXNzd29yZA=="}}}',
		]) {
			const redacted = redactText(input);
			expect(redacted).not.toContain("abc123def456");
			expect(redacted).not.toContain("dXNlcjpwYXNz");
			expect(redacted).toContain("[REDACTED CREDENTIAL]");
		}
		const logged = redactValue({ auth: "dXNlcjpwYXNzd29yZA==", nested: { auth: "required" } }) as Record<string, unknown>;
		expect(logged.auth).toBe("[REDACTED]");
		expect(logged.nested).toEqual({ auth: "required" });
	});

	test("a Title-case label with a non-prose value still runs to the end of the line", () => {
		const header = redactText("Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20261029, SignedHeaders=host, Signature=fe5f80f77d5fa3be");
		expect(header).not.toContain("fe5f80f77d5fa3be");
	});

	test("line starts in tool renderings", () => {
		const cases: Array<readonly [string, string]> = [
			["     2\tMAIL_PASSWORD=my secret phrase\n     3\tAPP=x", "     2\t[REDACTED CREDENTIAL]\n     3\tAPP=x"],
			[".env:2:MAIL_PASSWORD=my secret phrase\n.env:3:APP=x", ".env:2:[REDACTED CREDENTIAL]\n.env:3:APP=x"],
			["config/app.yml:12:  password: correct horse battery", "config/app.yml:12:  [REDACTED CREDENTIAL]"],
			["*2:MAIL_PASSWORD=my secret phrase", "*2:[REDACTED CREDENTIAL]"],
			["echo 'SMTP_PASSWORD=correct horse battery staple' >> .env", "echo '[REDACTED CREDENTIAL]' >> .env"],
			['["DB_PASSWORD=correct horse battery", "X=1"]', '["[REDACTED CREDENTIAL]", "X=1"]'],
			[JSON.stringify({ c: "db:\n\tpassword: correct horse battery staple\n" }), '{"c":"db:\\n\\t[REDACTED CREDENTIAL]\\n"}'],
			[
				JSON.stringify({ command: 'echo "SMTP_PASSWORD=correct horse battery" >> .env' }),
				'{"command":"echo \\"[REDACTED CREDENTIAL]\\" >> .env"}',
			],
		];
		for (const [input, expected] of cases) expect(redactText(input)).toBe(expected);
	});

	test("the first line of a JSON string value is a line start, except in a shell command", () => {
		const write = serializeEntry(toolCallEntry("write", { path: ".env", content: "MAIL_PASSWORD=my secret phrase\nAPP=x\n" }), {
			redact: true,
		});
		expect(write).not.toContain("secret phrase");
		expect(write).toContain('"content":"[REDACTED CREDENTIAL]\\nAPP=x\\n"');

		const edit = redactText(
			serializeEntry(
				toolCallEntry("edit", {
					path: "config.yml",
					oldText: "X",
					newText: "  password: correct horse battery staple\n  host: x",
				}),
			),
		);
		expect(edit).not.toContain("horse");
		expect(edit).toContain('"newText":"  [REDACTED CREDENTIAL]\\n  host: x"');
		expect(redactText('{"newText":"MAIL_PASSWORD=my secret phrase"}')).toBe('{"newText":"[REDACTED CREDENTIAL]"}');

		// Shell semantics: an inline assignment ends at whitespace.
		expect(redactText('{"command":"PGPASSWORD=hunter2 psql -h db.internal"}')).toBe(
			'{"command":"[REDACTED CREDENTIAL] psql -h db.internal"}',
		);
	});

	test("`=` values have no word limit and stop at a comment", () => {
		expect(redactText("WALLET_PASSPHRASE=alpha bravo charlie delta echo foxtrot golf")).toBe("[REDACTED CREDENTIAL]");
		expect(redactText("WALLET_PASSPHRASE=alpha bravo charlie delta echo foxtrot golf # rotated")).toBe(
			"[REDACTED CREDENTIAL] # rotated",
		);
		// A single lowercase `key:` word keeps the prose cap.
		expect(redactText("password: must be at least twelve characters long")).toBe(
			"[REDACTED CREDENTIAL] be at least twelve characters long",
		);
		expect(redactText("DB_PASSWORD: correct horse battery staple with seven words")).toBe("[REDACTED CREDENTIAL]");
	});

	test("YAML block scalars redact their more-indented lines", () => {
		const yaml = ["db:", "  password: |", "    correct horse battery staple", "", "    second line", "  host: db.internal"].join("\n");
		expect(redactText(yaml)).toBe("db:\n  [REDACTED CREDENTIAL]\n  host: db.internal");
		const vault = "password: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6231343235\nuser: admin";
		expect(redactText(vault)).toBe("[REDACTED CREDENTIAL]\nuser: admin");
		expect(redactText("token: >-\n  abcdef0123456789\n")).toBe("[REDACTED CREDENTIAL]\n");
		const escaped = redactText(JSON.stringify({ content: "password: |\n  s3cret line\nhost: x\n" }));
		expect(escaped).not.toContain("s3cret line");
		expect(escaped).toContain("host: x");
		// Bounded: lines beyond the cap are not consumed.
		const long = redactText(`secret: |\n${Array.from({ length: 40 }, (_, index) => `  line${index}`).join("\n")}`);
		expect(long).not.toContain("line31\n");
		expect(long).toContain("line32");
	});

	test("YAML block scalars under line numbers and diff marks measure indentation after the decoration", () => {
		const cases: Array<readonly [string, string]> = [
			// Host read tool (`N:` in hashline mode, `N|` otherwise), `cat -n`.
			[
				"1:stringData:\n2:  password: |\n3:    correct horse battery staple\n4:\n5:    second line\n6:  host: db.internal",
				"1:stringData:\n2:  [REDACTED CREDENTIAL]\n6:  host: db.internal",
			],
			[
				"1|stringData:\n2|  password: |\n3|    correct horse battery staple\n4|  host: db.internal",
				"1|stringData:\n2|  [REDACTED CREDENTIAL]\n4|  host: db.internal",
			],
			[
				"     1\tstringData:\n     2\t  password: |\n     3\t    correct horse battery staple\n     4\t  host: db.internal",
				"     1\tstringData:\n     2\t  [REDACTED CREDENTIAL]\n     4\t  host: db.internal",
			],
			// `grep -n -A`: the match line uses `:`, context lines use `-`.
			[
				"k8s.yml:2:  password: |\nk8s.yml-3-    correct horse battery staple\nk8s.yml-4-  host: db.internal",
				"k8s.yml:2:  [REDACTED CREDENTIAL]\nk8s.yml-4-  host: db.internal",
			],
			// `git diff`
			[
				"+stringData:\n+  password: |\n+    correct horse battery staple\n+  host: db.internal",
				"+stringData:\n+  [REDACTED CREDENTIAL]\n+  host: db.internal",
			],
			// A line without the key line's decoration ends the block.
			["2:  password: |\n3:    s3cret\n    not numbered", "2:  [REDACTED CREDENTIAL]\n    not numbered"],
			// A list bullet counts as indentation: `user` is a sibling of `password`.
			["- password: |\n    s3cret\n  user: x", "- [REDACTED CREDENTIAL]\n  user: x"],
		];
		for (const [input, expected] of cases) expect(redactText(input)).toBe(expected);

		// A hashline edit writes `+` rows inside the JSON `input` field.
		const edit = serializeEntry(
			toolCallEntry("edit", {
				input: "*** Begin Patch\n[k8s.yml#ab12]\nPUT >2:\n+  password: |\n+    correct horse battery staple\n+  host: x\n*** End Patch",
			}),
			{ redact: true },
		);
		expect(edit).not.toContain("correct horse battery staple");
		expect(edit).toContain("PUT >2:\\n+  [REDACTED CREDENTIAL]\\n+  host: x\\n*** End Patch");
	});

	test("expression line values redact only their first word", () => {
		expect(redactText("PASSWORD=hunter2 && ./run")).toBe("[REDACTED CREDENTIAL] && ./run");
		expect(redactText("  apiKey: oauthToken || suppress ? null : apiKey,")).toBe(
			"  [REDACTED CREDENTIAL] || suppress ? null : apiKey,",
		);
		expect(redactText("tokenFraction: tokens > 0 ? share / tokens : 0,")).toBe("[REDACTED CREDENTIAL] > 0 ? share / tokens : 0,");
	});
});

describe("code and placeholder exclusions", () => {
	test("literal secrets that start like code are redacted", () => {
		for (const input of [
			"PASSWORD=New-Hire-2024!",
			"API_TOKEN=int-9f8e7d6c5b4a",
			"password=Object!123",
			"SECRET_KEY=Optional-Key-9",
			"password=Str.0ng.Pass",
			"password=Bytes@123",
			"password=Maybe-Later-77",
			"password=Any#Pass2024",
			"password=bool:x9",
			"password=pa$$word(1)",
			"password=Summer(2024)",
			"password=config.Xyz9!",
			"password={Xy9!kq}",
			"password=[Xy9!kq]",
			'"password": "  spaced"',
			"password:/abc123",
			"password::abc123",
			"MAIL_PASSWORD=new secret phrase",
			'{"password":"$ummer2024"}',
			// Letters-only `A::B` is a Rust path only where code can be.
			"DB_PASSWORD=Hunter::Two",
			"password: Hunter::Two",
			"secret = Hunter::Two",
			"export API_TOKEN=Hunter::Two",
			"echo 'DB_PASSWORD=Hunter::Two' >> .env",
			// Parentheses and brackets around a single literal, or a dotenv/YAML phrase.
			"password=(Xy9!kq)",
			"PASSWORD=(Hunter Two)",
			"password: (Hunter Two)",
			"password=abc(Hunter",
			"password=[Xy9!kq",
			"password=Hunter(Two",
			// A parenthesized literal followed by `=>` later on the line is not an arrow function.
			"SECRET_KEY=(Xy9!kq):hunter2 # map dev=>prod",
			"DB_PASSWORD=(Xy9!kq):hunter2=>x",
			"PASSWORD=(Xy9!kq)=>x",
			"AUTH_TOKEN=(abc123def456):Hunter=>Two",
			"password: (Xy9!kq):Hunter=>Two",
		]) {
			expect(redactText(input)).not.toMatch(/2024|9f8e7d6c|123|Pass|Later|x9|word|Xy9|spaced|abc|secret|ummer|Hunter|Two/);
		}
		expect(redactText("DB_PASSWORD='$ecretPass' ./migrate")).toBe("[REDACTED CREDENTIAL] ./migrate");
		expect(redactText("echo 'DB_PASSWORD=$ecretPass' >> .env")).toBe("echo '[REDACTED CREDENTIAL]' >> .env");
	});

	test("code, references and templates are left alone", () => {
		const code = [
			"token = new Token()",
			"let token = String::new();",
			"password = os.environ.get(\n    'DB_PASSWORD'\n)",
			"apiKey: process.env.API_KEY!,",
			'secret = crypto.randomBytes(32).toString("hex")',
			'print(f"password={password}")',
			"password: {{ vault_password }}",
			'PASSWORD="$DB_PASSWORD"',
			"token = {}",
			"credentials: {",
			"password: Optional[str] = None",
			"password: string | undefined",
			"password = Hash::make($request->password)",
			"token: Token::Ident,",
			"password = std::env::var(\"PW\")",
		].join("\n");
		expect(redactText(code)).toBe(code);
	});

	test("modern TypeScript and Python code shapes are left alone", () => {
		const lines = [
			// Private fields, optional chaining, non-null member access, increments.
			"token: this.#token,",
			"const token = this.#tokenByKey.get(key);",
			"this.#t.password = this.#c();",
			"client_secret: this.#clientSecret,",
			"const credentials = this.#authStore.listAuthCredentials(provider);",
			"const token = this.#nextRequestToken++;",
			"const token = options.apiKey?.trim();",
			"const apiKey = options.config?.apiKey;",
			"const accessToken = params.credential.accessToken?.trim();",
			"const token = options.config!.token;",
			// Calls whose argument list continues on the next line.
			"getApiKey: createSecurityAuthResolver({",
			"export const cfgAuthBrokerToken = register({",
			"const credentialSync = setInterval(() => {",
			"const credentials = value.credentials.map((entry: unknown, index): AuthExportEntry => {",
			"const blockTokenEstimates = message.content.map(block => {",
			"var TOKEN_TYPES = Object.freeze({",
			// Array literals, spreads, parenthesized expressions, arrow functions.
			"token.pos = [offset - token.content.length, offset];",
			"const credentials = [...this.state.credentials];",
			"const TEMPLATE_TOKEN_KEYS = [...TEMPLATE_TOKEN_BY_KEY.keys()];",
			"_deleteCookie_decorators = [throwIfDisposed(context => {",
			"const isSizeToken = (trailing >= 97 && trailing <= 122) || (trailing >= 65 && trailing <= 90);",
			"const token = (await fs.readFile(tokenPath, \"utf8\")).trim();",
			"export type ProviderFileCredentialResolver = (model: Model) => Promise<string | undefined>;",
			"  getApiKey: (model: Model<Api>) => Promise<string | undefined>;",
			// Class-field arrow functions and a Python lambda as an assignment value.
			"  refreshToken = () => {",
			"  setToken = (token: string): void => {",
			"12|  getToken = () => this.token;",
			"token = lambda: get()",
			"  getToken = (token) => this.token;",
			"  refresh = (...args) => this.client.refresh(...args);",
			// Return types with object members, function types and tuples.
			"  getAccessToken = (): Promise<{ accessToken: string }> => this.store.get();",
			"const useAuthToken = (): [string, (t: string) => void] => {",
			"  validateToken: (token: string): { valid: boolean } => ({ valid: true }),",
			"  getToken = (): { token: string } => ({ token: this.token });",
			"  onTokenChange = (cb: (t: string) => void): (() => void) => {",
			"export type Opaque<Type, Token = unknown> = Type & {readonly __opaque__: Token};",
			// A code reference followed by more code.
			"  token: this.config.token ?? null,",
			"  audio_token_id: this.config.ignore_index ?? this.config.audio_token_id,",
			"secret = config.secret if config else None",
			'api_key = settings.API_KEY or ""',
			"    password: self.password or None,",
			"  apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,",
			// A keyword followed by a comment or an operator.
			"  token: null, // set later",
			"password = None if not args else args.password",
			"secret = await vault.read_secret",
			// Rust import groups and paths.
			"use argon2::{password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString}, Argon2};",
			"use crate::auth::token::{Claims, encode};",
			"use crate::secret::v1::Secret;",
			"use crate::token::*;",
			// Bind mounts whose source path ends in a sensitive name.
			"docker run -v ~/.aws/credentials:/root/.aws/credentials:ro amazon/aws-cli s3 ls",
			"      - ./secrets/db_password.txt:/run/secrets/db_password",
			// A message id is not a key name just because it contains `token`.
			'"Unexpected_token_A_constructor_method_accessor_or_property_was_expected_1068": "Token imprevisto.",',
			// Metadata words after the secret word.
			'const MCP_OAUTH_URL_CREDENTIAL_PREFIX = "mcp_oauth:";',
			"const CONNECTION_URL_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\\/\\/[^/:@?#\\s]*:([^/?#\\s]+)@/i;",
			"const MAX_PENDING_CREDENTIAL_DISABLED = 32;",
			"let worstTokenScore = Number.NEGATIVE_INFINITY;",
		];
		const changed = lines.filter((line) => redactText(line) !== line);
		expect(changed).toEqual([]);
	});

	test("YAML keys with a slash still redact a spaced value", () => {
		expect(redactText("example.com/api-token: s3cr3tValue")).toBe("example.com/[REDACTED CREDENTIAL]");
		expect(redactText('{"vault.example.com/agent-token":"s3cr3tValue"}')).not.toContain("s3cr3tValue");
	});
});

describe("sensitive key names", () => {
	test("metadata words veto a key only after the secret word", () => {
		const sensitive = [
			"LABEL_STUDIO_API_KEY",
			"URL_SIGNING_SECRET",
			"ENDPOINT_SECRET",
			"NAME_SERVICE_TOKEN",
			"MIN_IO_SECRET_KEY",
			"KEY_FILE_PASSWORD",
			"TOKEN_LIMIT_BYPASS_SECRET",
		];
		const neutral = ["token_count", "password_file", "secret_name", "token_url", "max_token", "MIN_PASSWORD_LENGTH", "total_secret"];
		const logged = redactValue(Object.fromEntries([...sensitive, ...neutral].map((key) => [key, "plainvalue"]))) as Record<string, unknown>;
		for (const key of sensitive) {
			expect(logged[key]).toBe("[REDACTED]");
			expect(redactText(`set ${key}=0123456789abcdef now`)).toBe("set [REDACTED CREDENTIAL] now");
		}
		for (const key of neutral) {
			expect(logged[key]).toBe("plainvalue");
			expect(redactText(`set ${key}=plainvalue now`)).toBe(`set ${key}=plainvalue now`);
		}
	});

	test("long dotted keys still match on their sensitive suffix", () => {
		const cases: Array<readonly [string, string]> = [
			["spring.security.oauth2.client.registration.azure-active-directory.client-secret=Xy9abcDEF", "Xy9abcDEF"],
			["com.example.myapplication.configuration.database.primary.connection.password=hunter2", "hunter2"],
			["  12|spring.security.oauth2.client.registration.keycloak.client-secret: s3cr3tValue", "s3cr3tValue"],
			['{"spring.security.oauth2.client.registration.keycloak.client-secret":"s3cr3tValue"}', "s3cr3tValue"],
			// Longer than 128 characters: judged by the trailing segments.
			[`${"module.".repeat(20)}datasource.password=hunter2deep`, "hunter2deep"],
		];
		for (const [input, secret] of cases) {
			const redacted = redactText(input);
			expect(redacted).not.toContain(secret);
			expect(redacted).toContain("[REDACTED CREDENTIAL]");
		}
		const name = "spring.security.oauth2.client.registration.azure-active-directory.client-name=portal";
		expect(redactText(name)).toBe(name);
		const longKey = "spring.security.oauth2.client.registration.azure-active-directory.client-secret";
		expect((redactValue({ [longKey]: "Xy9abcDEF" }) as Record<string, unknown>)[longKey]).toBe("[REDACTED]");
	});
});

describe("Basic and Digest prose", () => {
	test("slash-joined product names after Basic are prose", () => {
		const prose = [
			"Add basic GitHub/GitLab integration.",
			"Ship Basic MySQL/PostgreSQL support.",
			"User wants basic iOS/macOS support and basic GraphQL/WebSocket support.",
		].join("\n");
		expect(redactText(prose)).toBe(prose);
	});

	test("Basic credentials are still redacted, with or without padding", () => {
		for (const credential of ["dXNlcjpwYXNz", "YWRtaW46aHVudGVyMg", "dXNlcjpwYXNzd29yZA==", "Ym9iOnA/c3N3b3Jk", "dXNlcjpQYT9zcw"]) {
			expect(redactText(`curl -H 'X: Basic ${credential}' https://api`)).toBe("curl -H 'X: [REDACTED AUTH CREDENTIAL]' https://api");
		}
	});
});

describe("redaction stays idempotent on the new shapes", () => {
	test("redacting twice equals redacting once", () => {
		const fragments = [
			"password", "token", "Password", "Token", "auth", "DB_PASSWORD", "=", ": ", "::", ":/", " ", "\t", "\n", "\\n", "\\t", '"', "'",
			'{"content":"', '{"command":"', '": "', "     2\t", ".env:2:", "*3:", "export ", "- ", "|", ">-", "!vault |", "  ",
			"abc def", "must be rotated", "new ", "str", "{pw}", "{Xy9!k}", "[REDACTED CREDENTIAL]", "config.Xy9!", "Summer(2024)",
			"Basic ", "GitHub/GitLab", "dXNlcjpwYXNz", BEGIN, END, KEY_LINES[0] ?? "", ", '", "$", "^M$",
			"this.#t", "?.", "!.", "(", ")", " => {", "::{", "::", "Hunter::Two", "/credentials:/", "2:  ", "+  ", "k.yml-3-",
			"k.yml:2:", '\\"', "…", ";", " && ", " || ", " ? ", "++", "[a, b]", "(a b)", "#",
		];
		let seed = 23;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let i = 0; i < 3_000; i++) {
			let sample = "";
			const count = 1 + Math.floor(next() * 12);
			for (let j = 0; j < count; j++) sample += fragments[Math.floor(next() * fragments.length)];
			const once = redactText(sample);
			expect(redactText(once)).toBe(once);
		}
	});
});

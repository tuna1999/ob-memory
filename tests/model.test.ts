import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { completeSimple, TJsonSchema } from "@oh-my-pi/pi-ai";
import { DEFAULT_CONFIG } from "../src/config-types";
import { runWorkerLoop } from "../src/workers/loop";
import { isHostSecretObfuscationActive, resolveWorkerModel } from "../src/workers/model";
import { makeAssistant, makeHarness, makeModel, text } from "./helpers";

function ctxWith(overrides: Partial<ExtensionContext> & { auth?: (model: unknown) => unknown }): ExtensionContext {
	const { auth, ...rest } = overrides;
	return {
		...makeHarness().ctx,
		...rest,
		modelRegistry: {
			getApiKeyAndHeaders: async (model: unknown) =>
				auth ? auth(model) : { ok: true, apiKey: "test", headers: {} },
			resolveModelHeaders: async () => ({}),
		},
	} as unknown as ExtensionContext;
}

describe("worker model resolution", () => {
	test("uses the configured model when available", async () => {
		const model = makeModel();
		const ctx = ctxWith({
			models: {
				current: () => model,
				resolve: () => model,
				list: () => [model],
				family: () => "test",
			} as ExtensionContext["models"],
		});
		const config = { ...DEFAULT_CONFIG, model: { provider: "test", id: "test-model" } };
		const result = await resolveWorkerModel(ctx, config, new AbortController().signal);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.label).toBe("test/test-model");
			expect(result.value.fallbackUsed).toBe(false);
		}
	});

	test("falls back when the primary cannot be resolved", async () => {
		const model = makeModel();
		const ctx = ctxWith({
			models: {
				current: () => model,
				resolve: (spec: string) => (spec.startsWith("missing/") ? undefined : model),
				list: () => [model],
				family: () => "test",
			} as ExtensionContext["models"],
		});
		const config = {
			...DEFAULT_CONFIG,
			model: { provider: "missing", id: "nope" },
			fallbackModel: { provider: "test", id: "test-model" },
		};
		const result = await resolveWorkerModel(ctx, config, new AbortController().signal);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.fallbackUsed).toBe(true);
	});

	test("returns a reason when auth is unavailable and no fallback is usable", async () => {
		const model = makeModel();
		const ctx = ctxWith({
			models: {
				current: () => model,
				resolve: () => model,
				list: () => [model],
				family: () => "test",
			} as ExtensionContext["models"],
			auth: () => ({ ok: false, error: "no credential" }),
		});
		const result = await resolveWorkerModel(ctx, DEFAULT_CONFIG, new AbortController().signal);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("no credential");
	});

	test("passes the host no-auth sentinel through for keyless providers", async () => {
		const model = makeModel({ provider: "ollama", id: "llama3" });
		const ctx = ctxWith({
			models: {
				current: () => model,
				resolve: () => model,
				list: () => [model],
				family: () => "ollama",
			} as ExtensionContext["models"],
			auth: () => ({ ok: true, apiKey: "N/A", headers: {} }),
		});
		const result = await resolveWorkerModel(ctx, DEFAULT_CONFIG, new AbortController().signal);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.auth.apiKey).toBe("N/A");

		let sentKey: unknown;
		const complete = (async (_model: unknown, _context: unknown, options?: { apiKey?: string }) => {
			sentKey = options?.apiKey;
			return makeAssistant([text("done")]);
		}) as unknown as typeof completeSimple;
		await runWorkerLoop({
			stage: "observer",
			model: result.value.model,
			auth: result.value.auth,
			thinking: result.value.thinking,
			maxTokens: 1024,
			maxTurns: 1,
			system: "system",
			user: "user",
			tool: { name: "record_observations", description: "test", parameters: { type: "object" } as TJsonSchema, execute: async () => ({ text: "ok" }) },
			signal: new AbortController().signal,
			complete,
		});
		expect(sentKey).toBe("N/A");
	});
});

describe("host secret obfuscation detection", () => {
	const defaultNotice = "- `$$HASH$$`, `$$HASH:CASE$$`, `$$NAME_HASH:CASE$$` output tokens: opaque strings.";
	const customNotice =
		"<redacted-content>\nSome values in tool output are redacted for security. They appear as placeholder tokens such as `$$HASH$$`, `$$HASH:CASE$$`, or `$$NAME_HASH:CASE$$`.\n</redacted-content>";

	test("detects the placeholder notice omp renders while Hide Secrets is active", () => {
		expect(isHostSecretObfuscationActive({ getSystemPrompt: () => ["You are a coding agent.", defaultNotice] })).toBe(true);
		expect(isHostSecretObfuscationActive({ getSystemPrompt: () => [`Custom prompt.\n${customNotice}`] })).toBe(true);
	});

	test("reports false without the notice and undefined when the prompt is unavailable", () => {
		expect(isHostSecretObfuscationActive({ getSystemPrompt: () => ["You are a coding agent. Mention $$HASH$$ once."] })).toBe(false);
		expect(isHostSecretObfuscationActive({ getSystemPrompt: () => [] })).toBeUndefined();
		expect(
			isHostSecretObfuscationActive({
				getSystemPrompt: () => {
					throw new Error("not ready");
				},
			}),
		).toBeUndefined();
		expect(isHostSecretObfuscationActive({} as Parameters<typeof isHostSecretObfuscationActive>[0])).toBeUndefined();
	});
});

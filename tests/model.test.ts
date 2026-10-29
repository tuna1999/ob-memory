import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config-types";
import { resolveWorkerModel } from "../src/workers/model";
import { makeHarness, makeModel } from "./helpers";

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
});

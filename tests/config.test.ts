import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config-types";
import { loadConfig } from "../src/config";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ob-memory-config-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
	test("uses defaults when no config exists", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const loaded = loadConfig({ cwd, agentDir, env: {} });
		expect(loaded.config).toEqual(DEFAULT_CONFIG);
		expect(loaded.warnings).toEqual([]);
	});

	test("project overrides global and env overrides project", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ observeAfterTokens: 111, agentMaxTurns: 3 }));
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "ob-memory.json"), JSON.stringify({ observeAfterTokens: 222 }));
		const loaded = loadConfig({
			cwd,
			agentDir,
			env: { OB_MEMORY_OBSERVE_AFTER_TOKENS: "333", OB_MEMORY_AGENT_MAX_TURNS: "4" },
		});
		expect(loaded.config.observeAfterTokens).toBe(333);
		expect(loaded.config.agentMaxTurns).toBe(4);
		expect(loaded.sources).toHaveLength(2);
	});

	test("invalid values warn and keep defaults", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "ob-memory.json"),
			JSON.stringify({ observeAfterTokens: -1, enabled: "maybe", observationsPoolTargetTokens: 99, observationsPoolMaxTokens: 10 }),
		);
		const warnings: string[] = [];
		const loaded = loadConfig({ cwd, agentDir, env: {}, warn: (message) => warnings.push(message) });
		expect(loaded.config.observeAfterTokens).toBe(DEFAULT_CONFIG.observeAfterTokens);
		expect(loaded.config.enabled).toBe(DEFAULT_CONFIG.enabled);
		expect(loaded.config.observationsPoolTargetTokens).toBe(10);
		expect(warnings.length).toBeGreaterThanOrEqual(3);
	});

	test("parses model choices from JSON and env", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "ob-memory.json"),
			JSON.stringify({ model: "openai/gpt-5.2", fallbackModel: { provider: "anthropic", id: "claude", thinking: "high" } }),
		);
		const loaded = loadConfig({ cwd, agentDir, env: { OB_MEMORY_MODEL: " test/model " } });
		expect(loaded.config.model).toEqual({ provider: "test", id: "model" });
		expect(loaded.config.fallbackModel).toEqual({ provider: "anthropic", id: "claude", thinking: "high" });
	});
});

describe("invalid model override", () => {
	test("keeps the last valid model", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ model: "openai/gpt-5.2" }));
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "ob-memory.json"), JSON.stringify({ model: "not-a-model" }));
		const warnings: string[] = [];
		const loaded = loadConfig({ cwd, agentDir, env: {}, warn: (message) => warnings.push(message) });
		expect(loaded.config.model).toEqual({ provider: "openai", id: "gpt-5.2" });
		expect(warnings.some((warning) => warning.includes("model"))).toBe(true);
	});
});

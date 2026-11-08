import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config-types";
import { loadConfig, publicConfig } from "../src/config";

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

	test("pauseOnHostSecrets defaults on and is set from files and OB_MEMORY_PAUSE_ON_HOST_SECRETS", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		expect(loadConfig({ cwd, agentDir, env: {} }).config.pauseOnHostSecrets).toBe(true);

		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ pauseOnHostSecrets: false }));
		const fromFile = loadConfig({ cwd, agentDir, env: {} });
		expect(fromFile.config.pauseOnHostSecrets).toBe(false);
		expect(fromFile.warnings).toEqual([]);
		expect(publicConfig(fromFile.config).pauseOnHostSecrets).toBe(false);

		expect(loadConfig({ cwd, agentDir, env: { OB_MEMORY_PAUSE_ON_HOST_SECRETS: "yes" } }).config.pauseOnHostSecrets).toBe(true);

		const invalid = loadConfig({ cwd, agentDir, env: { OB_MEMORY_PAUSE_ON_HOST_SECRETS: "sometimes" } });
		expect(invalid.config.pauseOnHostSecrets).toBe(false);
		expect(invalid.warnings).toEqual(['OB_MEMORY_PAUSE_ON_HOST_SECRETS: expected a boolean, got "sometimes"']);
	});

	test("clamps reflectAfterTokens to the observation pool max", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "ob-memory.json"),
			JSON.stringify({ reflectAfterTokens: 20_000, observationsPoolMaxTokens: 1_000 }),
		);
		const warnings: string[] = [];
		const loaded = loadConfig({ cwd, agentDir, env: {}, warn: (message) => warnings.push(message) });
		expect(loaded.config.reflectAfterTokens).toBe(1_000);
		expect(loaded.config.observationsPoolTargetTokens).toBe(1_000);
		expect(warnings.some((warning) => warning.includes("reflectAfterTokens"))).toBe(true);
	});

	test("clamps resource limits", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "ob-memory.json"),
			JSON.stringify({
				agentMaxTurns: 1_000,
				observerChunkMaxTokens: 9_000_000,
				workerMemoryMaxTokens: 8_000_000,
				compactionCatchUpBudgetMs: 999_999,
				compactionCatchUpMaxChunks: 99,
			}),
		);
		const warnings: string[] = [];
		const loaded = loadConfig({ cwd, agentDir, env: {}, warn: (message) => warnings.push(message) });
		expect(loaded.config.agentMaxTurns).toBe(32);
		expect(loaded.config.observerChunkMaxTokens).toBe(1_000_000);
		expect(loaded.config.workerMemoryMaxTokens).toBe(1_000_000);
		expect(loaded.config.compactionCatchUpBudgetMs).toBe(25_000);
		expect(loaded.config.compactionCatchUpMaxChunks).toBe(8);
		expect(warnings.filter((warning) => warning.includes("clamped"))).toHaveLength(5);
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

describe("merged-config clamps", () => {
	test("a later layer raising the pool max is not undercut by an earlier clamp", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ observationsPoolMaxTokens: 3_000 }));
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "ob-memory.json"), JSON.stringify({ observationsPoolMaxTokens: 30_000 }));
		const loaded = loadConfig({ cwd, agentDir, env: {} });
		expect(loaded.config.observationsPoolMaxTokens).toBe(30_000);
		expect(loaded.config.observationsPoolTargetTokens).toBe(DEFAULT_CONFIG.observationsPoolTargetTokens);
		expect(loaded.config.reflectAfterTokens).toBe(DEFAULT_CONFIG.reflectAfterTokens);
		expect(loaded.warnings).toEqual([]);
	});

	test("an env pool max overrides an earlier file clamp", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ observationsPoolMaxTokens: 3_000 }));
		const loaded = loadConfig({ cwd, agentDir, env: { OB_MEMORY_OBSERVATIONS_POOL_MAX_TOKENS: "30000" } });
		expect(loaded.config.observationsPoolTargetTokens).toBe(DEFAULT_CONFIG.observationsPoolTargetTokens);
		expect(loaded.config.reflectAfterTokens).toBe(DEFAULT_CONFIG.reflectAfterTokens);
		expect(loaded.warnings).toEqual([]);
	});

	test("clamp warnings name the layer that introduced the conflict", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const globalPath = join(agentDir, "ob-memory.json");
		const projectPath = join(cwd, ".omp", "ob-memory.json");
		writeFileSync(globalPath, JSON.stringify({ observationsPoolTargetTokens: 12_000, agentMaxTurns: 99 }));
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ observationsPoolMaxTokens: 8_000 }));
		const loaded = loadConfig({ cwd, agentDir, env: { OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS: "50" } });
		expect(loaded.config.observationsPoolTargetTokens).toBe(8_000);
		expect(loaded.config.agentMaxTurns).toBe(32);
		expect(loaded.config.compactionCatchUpMaxChunks).toBe(8);
		expect(loaded.warnings).toEqual([
			`${projectPath}: observationsPoolTargetTokens (12000) exceeds observationsPoolMaxTokens (8000); target clamped`,
			`${globalPath}: agentMaxTurns (99) exceeds the supported maximum; clamped to 32`,
			"environment: compactionCatchUpMaxChunks (50) exceeds the supported maximum; clamped to 8",
		]);
	});

	test("agentMaxTokens above the worker output cap clamps with a warning", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "ob-memory.json"), JSON.stringify({ agentMaxTokens: 32_000 }));
		const fromFile = loadConfig({ cwd, agentDir, env: {} });
		expect(fromFile.config.agentMaxTokens).toBe(16_384);
		expect(fromFile.warnings.some((warning) => warning.includes("agentMaxTokens (32000)"))).toBe(true);

		const fromEnv = loadConfig({ cwd: tempDir(), agentDir: tempDir(), env: { OB_MEMORY_AGENT_MAX_TOKENS: "16384" } });
		expect(fromEnv.config.agentMaxTokens).toBe(16_384);
		expect(fromEnv.warnings).toEqual([]);
	});
});

describe("numeric string parsing", () => {
	test("blank env values warn and keep the previous value", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const loaded = loadConfig({
			cwd,
			agentDir,
			env: {
				OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS: "",
				OB_MEMORY_COMPACTION_CATCH_UP_BUDGET_MS: "   ",
			},
		});
		expect(loaded.config.compactionCatchUpMaxChunks).toBe(DEFAULT_CONFIG.compactionCatchUpMaxChunks);
		expect(loaded.config.compactionCatchUpBudgetMs).toBe(DEFAULT_CONFIG.compactionCatchUpBudgetMs);
		expect(loaded.warnings).toHaveLength(2);
		expect(loaded.warnings[0]).toContain("OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS");
	});

	test("blank, hex, and exponent strings in JSON are rejected", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "ob-memory.json"),
			JSON.stringify({ compactionCatchUpMaxChunks: "", compactionCatchUpBudgetMs: "0x10", agentMaxTurns: "1e1" }),
		);
		const loaded = loadConfig({ cwd, agentDir, env: {} });
		expect(loaded.config.compactionCatchUpMaxChunks).toBe(DEFAULT_CONFIG.compactionCatchUpMaxChunks);
		expect(loaded.config.compactionCatchUpBudgetMs).toBe(DEFAULT_CONFIG.compactionCatchUpBudgetMs);
		expect(loaded.config.agentMaxTurns).toBe(DEFAULT_CONFIG.agentMaxTurns);
		expect(loaded.warnings).toHaveLength(3);
	});

	test("explicit zero and padded digit strings are still accepted", () => {
		const loaded = loadConfig({
			cwd: tempDir(),
			agentDir: tempDir(),
			env: { OB_MEMORY_COMPACTION_CATCH_UP_MAX_CHUNKS: "0", OB_MEMORY_AGENT_MAX_TURNS: " 4 " },
		});
		expect(loaded.config.compactionCatchUpMaxChunks).toBe(0);
		expect(loaded.config.agentMaxTurns).toBe(4);
		expect(loaded.warnings).toEqual([]);
	});
});

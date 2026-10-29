import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	DEFAULT_CONFIG,
	THINKING_LEVELS,
	type ModelChoice,
	type ObMemoryConfig,
	type ThinkingLevel,
} from "./config-types";

export interface ConfigLoadOptions {
	cwd: string;
	agentDir?: string;
	env?: Record<string, string | undefined>;
	warn?: (message: string) => void;
}

export interface LoadedConfig {
	config: ObMemoryConfig;
	warnings: string[];
	sources: string[];
}

export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured && configured.trim()) return resolve(configured);
	return join(homedir(), ".omp", "agent");
}

function readJsonObject(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`${path}: expected a JSON object, ignored`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function parseModelChoice(value: unknown, key: string, warnings: string[]): ModelChoice | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		const spec = value.trim();
		const slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) {
			warnings.push(`${key}: expected "provider/id", got ${JSON.stringify(value)}`);
			return undefined;
		}
		return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${key}: expected a model object or "provider/id"`);
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!provider || !id) {
		warnings.push(`${key}: provider and id are required`);
		return undefined;
	}
	const thinking = raw.thinking;
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
		warnings.push(`${key}.thinking: unknown level ${JSON.stringify(thinking)}`);
	}
	return {
		provider,
		id,
		...(typeof thinking === "string" && THINKING_LEVELS.includes(thinking as ThinkingLevel)
			? { thinking: thinking as ThinkingLevel }
			: {}),
	};
}

function asBoolean(value: unknown, key: string, warnings: string[]): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
		if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
	}
	warnings.push(`${key}: expected a boolean, got ${JSON.stringify(value)}`);
	return undefined;
}

function asPositiveInt(value: unknown, key: string, warnings: string[], allowZero = false): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(number) || !Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
		warnings.push(`${key}: expected ${allowZero ? "a non-negative" : "a positive"} integer, got ${JSON.stringify(value)}`);
		return undefined;
	}
	return number;
}

const BOOLEAN_KEYS = [
	"enabled",
	"consolidateWhenIdle",
	"observeAttachments",
	"redactSecrets",
	"passive",
	"ownManualCompaction",
	"ownAutoCompaction",
	"debugLog",
	"showNotifications",
] as const;

const POSITIVE_INT_KEYS = [
	"observeAfterTokens",
	"reflectAfterTokens",
	"observerChunkMaxTokens",
	"observationsPoolMaxTokens",
	"observationsPoolTargetTokens",
	"workerMemoryMaxTokens",
	"agentMaxTurns",
	"agentMaxTokens",
] as const;

function applyObject(
	base: ObMemoryConfig,
	raw: Record<string, unknown>,
	source: string,
	warnings: string[],
): ObMemoryConfig {
	const config: ObMemoryConfig = { ...base };
	const known = new Set<string>([
		...BOOLEAN_KEYS,
		...POSITIVE_INT_KEYS,
		"model",
		"fallbackModel",
		"compactionSummaryMaxTokens",
		"compactionMaxRetainedTokens",
		"compactionCatchUpMaxChunks",
		"compactionCatchUpBudgetMs",
	]);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) warnings.push(`${source}: unknown key ${JSON.stringify(key)} ignored`);
	}
	for (const key of BOOLEAN_KEYS) {
		if (!(key in raw)) continue;
		const value = asBoolean(raw[key], `${source}.${key}`, warnings);
		if (value !== undefined) config[key] = value;
	}
	for (const key of POSITIVE_INT_KEYS) {
		if (!(key in raw)) continue;
		const value = asPositiveInt(raw[key], `${source}.${key}`, warnings);
		if (value !== undefined) config[key] = value;
	}
	if ("compactionSummaryMaxTokens" in raw) {
		const value = asPositiveInt(raw.compactionSummaryMaxTokens, `${source}.compactionSummaryMaxTokens`, warnings);
		if (value !== undefined) config.compactionSummaryMaxTokens = value;
	}
	if ("compactionMaxRetainedTokens" in raw) {
		const value = asPositiveInt(raw.compactionMaxRetainedTokens, `${source}.compactionMaxRetainedTokens`, warnings);
		if (value !== undefined) config.compactionMaxRetainedTokens = value;
	}
	if ("compactionCatchUpMaxChunks" in raw) {
		const value = asPositiveInt(raw.compactionCatchUpMaxChunks, `${source}.compactionCatchUpMaxChunks`, warnings, true);
		if (value !== undefined) config.compactionCatchUpMaxChunks = value;
	}
	if ("compactionCatchUpBudgetMs" in raw) {
		const value = asPositiveInt(raw.compactionCatchUpBudgetMs, `${source}.compactionCatchUpBudgetMs`, warnings, true);
		if (value !== undefined) config.compactionCatchUpBudgetMs = value;
	}
	if ("model" in raw) {
		const value = parseModelChoice(raw.model, `${source}.model`, warnings);
		if (value) config.model = value;
	}
	if ("fallbackModel" in raw) {
		const value = parseModelChoice(raw.fallbackModel, `${source}.fallbackModel`, warnings);
		if (value) config.fallbackModel = value;
	}
	if (config.observationsPoolTargetTokens > config.observationsPoolMaxTokens) {
		warnings.push(
			`${source}: observationsPoolTargetTokens (${config.observationsPoolTargetTokens}) exceeds observationsPoolMaxTokens (${config.observationsPoolMaxTokens}); target clamped`,
		);
		config.observationsPoolTargetTokens = config.observationsPoolMaxTokens;
	}
	return config;
}

const ENV_KEYS: ReadonlyArray<readonly [keyof ObMemoryConfig, string]> = [
	["enabled", "ENABLED"],
	["observeAfterTokens", "OBSERVE_AFTER_TOKENS"],
	["reflectAfterTokens", "REFLECT_AFTER_TOKENS"],
	["observerChunkMaxTokens", "OBSERVER_CHUNK_MAX_TOKENS"],
	["observationsPoolMaxTokens", "OBSERVATIONS_POOL_MAX_TOKENS"],
	["observationsPoolTargetTokens", "OBSERVATIONS_POOL_TARGET_TOKENS"],
	["compactionSummaryMaxTokens", "COMPACTION_SUMMARY_MAX_TOKENS"],
	["compactionMaxRetainedTokens", "COMPACTION_MAX_RETAINED_TOKENS"],
	["compactionCatchUpMaxChunks", "COMPACTION_CATCH_UP_MAX_CHUNKS"],
	["compactionCatchUpBudgetMs", "COMPACTION_CATCH_UP_BUDGET_MS"],
	["workerMemoryMaxTokens", "WORKER_MEMORY_MAX_TOKENS"],
	["agentMaxTurns", "AGENT_MAX_TURNS"],
	["agentMaxTokens", "AGENT_MAX_TOKENS"],
	["consolidateWhenIdle", "CONSOLIDATE_WHEN_IDLE"],
	["observeAttachments", "OBSERVE_ATTACHMENTS"],
	["redactSecrets", "REDACT_SECRETS"],
	["passive", "PASSIVE"],
	["ownManualCompaction", "OWN_MANUAL_COMPACTION"],
	["ownAutoCompaction", "OWN_AUTO_COMPACTION"],
	["debugLog", "DEBUG_LOG"],
	["showNotifications", "SHOW_NOTIFICATIONS"],
];

function applyEnv(base: ObMemoryConfig, env: Record<string, string | undefined>, warnings: string[]): ObMemoryConfig {
	const config: ObMemoryConfig = { ...base };
	for (const [key, suffix] of ENV_KEYS) {
		const envKey = `OB_MEMORY_${suffix}`;
		const raw = env[envKey];
		if (raw === undefined) continue;
		if (key === "model" || key === "fallbackModel") continue;
		const current = config[key];
		if (typeof current === "boolean") {
			const value = asBoolean(raw, envKey, warnings);
			if (value !== undefined) Object.assign(config, { [key]: value });
			continue;
		}
		const value = asPositiveInt(raw, envKey, warnings, key === "compactionCatchUpMaxChunks" || key === "compactionCatchUpBudgetMs");
		if (value !== undefined) Object.assign(config, { [key]: value });
	}
	for (const [key, suffix] of [
		["model", "MODEL"],
		["fallbackModel", "FALLBACK_MODEL"],
	] as const) {
		const raw = env[`OB_MEMORY_${suffix}`];
		if (raw === undefined || raw.trim() === "") continue;
		const value = parseModelChoice(raw, `OB_MEMORY_${suffix}`, warnings);
		if (value) config[key] = value;
	}
	if (config.observationsPoolTargetTokens > config.observationsPoolMaxTokens) {
		warnings.push(
			`environment: observationsPoolTargetTokens (${config.observationsPoolTargetTokens}) exceeds observationsPoolMaxTokens (${config.observationsPoolMaxTokens}); target clamped`,
		);
		config.observationsPoolTargetTokens = config.observationsPoolMaxTokens;
	}
	return config;
}

/**
 * Load defaults, then the user file, then the project file, then environment
 * overrides. Invalid values are warned about and ignored rather than throwing:
 * a broken config must never prevent the extension from loading.
 */
export function loadConfig(options: ConfigLoadOptions): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	const warn = options.warn ?? (() => {});
	const agentDir = resolve(options.agentDir ?? resolveAgentDir(options.env));
	let config = { ...DEFAULT_CONFIG };

	const globalPath = join(agentDir, "ob-memory.json");
	const globalRaw = readJsonObject(globalPath, warnings);
	if (globalRaw) {
		config = applyObject(config, globalRaw, globalPath, warnings);
		sources.push(globalPath);
	}

	const projectPath = join(options.cwd, ".omp", "ob-memory.json");
	const projectRaw = readJsonObject(projectPath, warnings);
	if (projectRaw) {
		config = applyObject(config, projectRaw, projectPath, warnings);
		sources.push(projectPath);
	}

	config = applyEnv(config, options.env ?? process.env, warnings);
	for (const warning of warnings) warn(warning);
	return { config, warnings, sources };
}

export function modelLabel(model: ModelChoice | undefined): string {
	return model ? `${model.provider}/${model.id}` : "session model";
}

export function publicConfig(config: ObMemoryConfig): Record<string, unknown> {
	return {
		...config,
		model: config.model ? `${config.model.provider}/${config.model.id}` : undefined,
		fallbackModel: config.fallbackModel
			? `${config.fallbackModel.provider}/${config.fallbackModel.id}`
			: undefined,
	};
}

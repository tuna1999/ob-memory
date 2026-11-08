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
import { MAX_WORKER_OUTPUT_TOKENS } from "./workers/model";

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

/** Decimal digits only: blank, signed, hex, and exponent strings are rejected rather than coerced. */
const INTEGER_STRING_PATTERN = /^\s*\d+\s*$/;

function asPositiveInt(value: unknown, key: string, warnings: string[], allowZero = false): number | undefined {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && INTEGER_STRING_PATTERN.test(value)
				? Number(value)
				: Number.NaN;
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
	"pauseOnHostSecrets",
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

const MAX_AGENT_TURNS = 32;
const MAX_CATCH_UP_BUDGET_MS = 25_000;
const MAX_CATCH_UP_CHUNKS = 8;
const MAX_WORKER_BUDGET_TOKENS = 1_000_000;

/** The source (file path or "environment") that last set a key, in load order. */
interface KeyOrigin {
	source: string;
	layer: number;
}
type KeyOrigins = Map<keyof ObMemoryConfig, KeyOrigin>;

/**
 * Attribute a merged-config warning to the latest layer that set any of the
 * involved keys: that layer introduced the conflict.
 */
function attribution(origins: KeyOrigins, ...keys: ReadonlyArray<keyof ObMemoryConfig>): string {
	let latest: KeyOrigin | undefined;
	for (const key of keys) {
		const origin = origins.get(key);
		if (origin && (!latest || origin.layer > latest.layer)) latest = origin;
	}
	return latest?.source ?? "defaults";
}

function clampPoolTarget(config: ObMemoryConfig, origins: KeyOrigins, warnings: string[]): void {
	if (config.observationsPoolTargetTokens <= config.observationsPoolMaxTokens) return;
	warnings.push(
		`${attribution(origins, "observationsPoolTargetTokens", "observationsPoolMaxTokens")}: observationsPoolTargetTokens (${config.observationsPoolTargetTokens}) exceeds observationsPoolMaxTokens (${config.observationsPoolMaxTokens}); target clamped`,
	);
	config.observationsPoolTargetTokens = config.observationsPoolMaxTokens;
}

function validateReflectionThreshold(config: ObMemoryConfig, origins: KeyOrigins, warnings: string[]): void {
	if (config.reflectAfterTokens <= config.observationsPoolMaxTokens) return;
	warnings.push(
		`${attribution(origins, "reflectAfterTokens", "observationsPoolMaxTokens")}: reflectAfterTokens (${config.reflectAfterTokens}) exceeds observationsPoolMaxTokens (${config.observationsPoolMaxTokens}); reflection threshold clamped`,
	);
	config.reflectAfterTokens = config.observationsPoolMaxTokens;
}

function clampResourceLimits(config: ObMemoryConfig, origins: KeyOrigins, warnings: string[]): void {
	const limits: ReadonlyArray<[keyof ObMemoryConfig, number]> = [
		["agentMaxTurns", MAX_AGENT_TURNS],
		["agentMaxTokens", MAX_WORKER_OUTPUT_TOKENS],
		["observerChunkMaxTokens", MAX_WORKER_BUDGET_TOKENS],
		["workerMemoryMaxTokens", MAX_WORKER_BUDGET_TOKENS],
		["compactionCatchUpMaxChunks", MAX_CATCH_UP_CHUNKS],
		["compactionCatchUpBudgetMs", MAX_CATCH_UP_BUDGET_MS],
	];
	for (const [key, max] of limits) {
		const value = config[key];
		if (typeof value !== "number" || value <= max) continue;
		warnings.push(`${attribution(origins, key)}: ${String(key)} (${value}) exceeds the supported maximum; clamped to ${max}`);
		Object.assign(config, { [key]: max });
	}
}

/**
 * Cross-field and resource clamps run once, on the merged config, so a later
 * layer that raises a limit is never undercut by an earlier layer's clamp.
 */
function finalizeConfig(config: ObMemoryConfig, origins: KeyOrigins, warnings: string[]): ObMemoryConfig {
	const finalized: ObMemoryConfig = { ...config };
	clampPoolTarget(finalized, origins, warnings);
	validateReflectionThreshold(finalized, origins, warnings);
	clampResourceLimits(finalized, origins, warnings);
	return finalized;
}

function applyObject(
	base: ObMemoryConfig,
	raw: Record<string, unknown>,
	source: string,
	warnings: string[],
	origins: KeyOrigins,
	layer: number,
): ObMemoryConfig {
	const config: ObMemoryConfig = { ...base };
	const set = <K extends keyof ObMemoryConfig>(key: K, value: ObMemoryConfig[K]): void => {
		config[key] = value;
		origins.set(key, { source, layer });
	};
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
		if (value !== undefined) set(key, value);
	}
	for (const key of POSITIVE_INT_KEYS) {
		if (!(key in raw)) continue;
		const value = asPositiveInt(raw[key], `${source}.${key}`, warnings);
		if (value !== undefined) set(key, value);
	}
	if ("compactionSummaryMaxTokens" in raw) {
		const value = asPositiveInt(raw.compactionSummaryMaxTokens, `${source}.compactionSummaryMaxTokens`, warnings);
		if (value !== undefined) set("compactionSummaryMaxTokens", value);
	}
	if ("compactionMaxRetainedTokens" in raw) {
		const value = asPositiveInt(raw.compactionMaxRetainedTokens, `${source}.compactionMaxRetainedTokens`, warnings);
		if (value !== undefined) set("compactionMaxRetainedTokens", value);
	}
	if ("compactionCatchUpMaxChunks" in raw) {
		const value = asPositiveInt(raw.compactionCatchUpMaxChunks, `${source}.compactionCatchUpMaxChunks`, warnings, true);
		if (value !== undefined) set("compactionCatchUpMaxChunks", value);
	}
	if ("compactionCatchUpBudgetMs" in raw) {
		const value = asPositiveInt(raw.compactionCatchUpBudgetMs, `${source}.compactionCatchUpBudgetMs`, warnings, true);
		if (value !== undefined) set("compactionCatchUpBudgetMs", value);
	}
	if ("model" in raw) {
		const value = parseModelChoice(raw.model, `${source}.model`, warnings);
		if (value) set("model", value);
	}
	if ("fallbackModel" in raw) {
		const value = parseModelChoice(raw.fallbackModel, `${source}.fallbackModel`, warnings);
		if (value) set("fallbackModel", value);
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
	["pauseOnHostSecrets", "PAUSE_ON_HOST_SECRETS"],
];

function applyEnv(
	base: ObMemoryConfig,
	env: Record<string, string | undefined>,
	warnings: string[],
	origins: KeyOrigins,
	layer: number,
): ObMemoryConfig {
	const config: ObMemoryConfig = { ...base };
	const origin: KeyOrigin = { source: "environment", layer };
	for (const [key, suffix] of ENV_KEYS) {
		const envKey = `OB_MEMORY_${suffix}`;
		const raw = env[envKey];
		if (raw === undefined) continue;
		if (key === "model" || key === "fallbackModel") continue;
		const current = config[key];
		if (typeof current === "boolean") {
			const value = asBoolean(raw, envKey, warnings);
			if (value !== undefined) {
				Object.assign(config, { [key]: value });
				origins.set(key, origin);
			}
			continue;
		}
		const value = asPositiveInt(raw, envKey, warnings, key === "compactionCatchUpMaxChunks" || key === "compactionCatchUpBudgetMs");
		if (value !== undefined) {
			Object.assign(config, { [key]: value });
			origins.set(key, origin);
		}
	}
	for (const [key, suffix] of [
		["model", "MODEL"],
		["fallbackModel", "FALLBACK_MODEL"],
	] as const) {
		const raw = env[`OB_MEMORY_${suffix}`];
		if (raw === undefined || raw.trim() === "") continue;
		const value = parseModelChoice(raw, `OB_MEMORY_${suffix}`, warnings);
		if (value) {
			config[key] = value;
			origins.set(key, origin);
		}
	}
	return config;
}

/**
 * Load defaults, then the user file, then the project file, then environment
 * overrides. Invalid values are warned about and ignored rather than throwing:
 * a broken config must never prevent the extension from loading. Cross-field
 * and resource clamps run once on the merged result.
 */
export function loadConfig(options: ConfigLoadOptions): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	const origins: KeyOrigins = new Map();
	const warn = options.warn ?? (() => {});
	const agentDir = resolve(options.agentDir ?? resolveAgentDir(options.env));
	let config = { ...DEFAULT_CONFIG };

	const globalPath = join(agentDir, "ob-memory.json");
	const globalRaw = readJsonObject(globalPath, warnings);
	if (globalRaw) {
		config = applyObject(config, globalRaw, globalPath, warnings, origins, 1);
		sources.push(globalPath);
	}

	const projectPath = join(options.cwd, ".omp", "ob-memory.json");
	const projectRaw = readJsonObject(projectPath, warnings);
	if (projectRaw) {
		config = applyObject(config, projectRaw, projectPath, warnings, origins, 2);
		sources.push(projectPath);
	}

	config = applyEnv(config, options.env ?? process.env, warnings, origins, 3);
	config = finalizeConfig(config, origins, warnings);
	for (const warning of warnings) warn(warning);
	return { config, warnings, sources };
}

export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 12_000;
export const WORKER_MEMORY_CONTEXT_RATIO = 0.25;
export const WORKER_MEMORY_MIN_TOKENS = 256;
export const WORKER_MEMORY_FALLBACK_MAX_TOKENS = 16_000;

function derivedBudget(
	explicit: number | undefined,
	contextWindow: number | null | undefined,
	ratio: number,
	minimum: number,
	fallback: number,
): number {
	if (explicit !== undefined) return explicit;
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(minimum, Math.floor(contextWindow * ratio));
	}
	return fallback;
}

/**
 * Source chunk sent to one observer request. The default scales with the
 * resolved memory model so large windows are not underused and small windows
 * leave room for the prompt and output. Explicit config always wins.
 */
export function resolveObserverChunkMaxTokens(
	config: Pick<ObMemoryConfig, "observerChunkMaxTokens">,
	contextWindow?: number | null,
): number {
	return derivedBudget(
		config.observerChunkMaxTokens,
		contextWindow,
		OBSERVER_CHUNK_CONTEXT_RATIO,
		OBSERVER_CHUNK_MIN_TOKENS,
		OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
	);
}

/** Prior memory attached to one worker request; same derivation policy as the chunk cap. */
export function resolveWorkerMemoryMaxTokens(
	config: Pick<ObMemoryConfig, "workerMemoryMaxTokens">,
	contextWindow?: number | null,
): number {
	return derivedBudget(
		config.workerMemoryMaxTokens,
		contextWindow,
		WORKER_MEMORY_CONTEXT_RATIO,
		WORKER_MEMORY_MIN_TOKENS,
		WORKER_MEMORY_FALLBACK_MAX_TOKENS,
	);
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

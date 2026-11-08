import type { ExtensionContext, ResolvedRequestAuth } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelChoice, ObMemoryConfig, ThinkingLevel } from "../config-types";

/** Hard per-request worker output ceiling, applied after the catalog cap. */
export const MAX_WORKER_OUTPUT_TOKENS = 16_384;

export interface WorkerAuth {
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ResolvedWorkerModel {
	model: Model;
	auth: WorkerAuth;
	thinking: ThinkingLevel;
	maxTokens: number;
	label: string;
	fallbackUsed: boolean;
}

export type ResolveWorkerResult =
	| { ok: true; value: ResolvedWorkerModel }
	| { ok: false; reason: string };

/**
 * Pass the host key through unchanged. For keyless providers (ollama,
 * lm-studio, llama.cpp, `auth: none`) the host returns the `"N/A"` no-auth
 * sentinel, which pi-ai expects: it skips the Authorization header for it,
 * while an undefined key makes it throw MissingApiKeyError before the request.
 */
function usableApiKey(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Placeholder grammar that omp's system prompt documents only while the
 * session's "Hide Secrets" obfuscator is active (`secrets.enabled` with at
 * least one secret source). Both the default and the custom-prompt templates
 * list these tokens; requiring both keeps a passing mention from matching.
 */
const HOST_SECRET_PLACEHOLDER_MARKERS = ["$$HASH:CASE$$", "$$NAME_HASH:CASE$$"] as const;

/**
 * Best-effort check for omp's "Hide Secrets" obfuscation in this session.
 *
 * Extensions cannot reach the session's secret obfuscator, and worker calls go
 * straight to pi-ai, so host obfuscation never applies to them. The host only
 * renders its placeholder notice into the system prompt while that obfuscator
 * is active, which makes the prompt the one supported signal available.
 * Returns undefined when the system prompt cannot be read.
 */
export function isHostSecretObfuscationActive(
	ctx: Pick<ExtensionContext, "getSystemPrompt">,
): boolean | undefined {
	let prompt: unknown;
	try {
		prompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
	} catch {
		return undefined;
	}
	if (!Array.isArray(prompt)) return undefined;
	const text = prompt.filter((part): part is string => typeof part === "string").join("\n");
	if (!text) return undefined;
	return HOST_SECRET_PLACEHOLDER_MARKERS.every((marker) => text.includes(marker));
}

function mergeHeaders(
	first: Record<string, string> | undefined,
	second: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!first && !second) return undefined;
	return { ...(first ?? {}), ...(second ?? {}) };
}

async function resolveCandidate(
	ctx: ExtensionContext,
	model: Model,
	choice: ModelChoice | undefined,
	fallbackUsed: boolean,
	signal: AbortSignal,
): Promise<ResolveWorkerResult> {
	let authResult: ResolvedRequestAuth;
	try {
		authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error) {
		return { ok: false, reason: `auth lookup failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!authResult.ok) return { ok: false, reason: authResult.error };

	let modelHeaders: Record<string, string> | undefined;
	try {
		modelHeaders = await ctx.modelRegistry.resolveModelHeaders(model, signal);
	} catch {
		// Header resolution is optional; the auth result already carries provider headers.
	}

	const thinking = choice?.thinking ?? "low";
	const catalogMax = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	const maxTokens = Math.min(catalogMax ?? 64_000, MAX_WORKER_OUTPUT_TOKENS);
	return {
		ok: true,
		value: {
			model,
			auth: {
				apiKey: usableApiKey(authResult.apiKey),
				headers: mergeHeaders(authResult.headers, modelHeaders),
			},
			thinking,
			maxTokens,
			label: `${model.provider}/${model.id}`,
			fallbackUsed,
		},
	};
}

async function findModel(
	ctx: ExtensionContext,
	choice: ModelChoice | undefined,
): Promise<{ model: Model | undefined; reason?: string }> {
	if (!choice) {
		const current = ctx.models.current();
		return current ? { model: current } : { model: undefined, reason: "session has no active model" };
	}
	const spec = `${choice.provider}/${choice.id}`;
	const resolved = ctx.models.resolve(spec);
	if (!resolved) return { model: undefined, reason: `model ${spec} is not available in this session` };
	return { model: resolved };
}

/**
 * Resolve the worker model, preferring the configured model and falling back to
 * the session model when it is absent. A configured fallbackModel is used only
 * after the primary fails to resolve or authenticate.
 */
export async function resolveWorkerModel(
	ctx: ExtensionContext,
	config: ObMemoryConfig,
	signal: AbortSignal,
): Promise<ResolveWorkerResult> {
	const primaryChoice = config.model;
	const primary = await findModel(ctx, primaryChoice);
	if (primary.model) {
		const resolved = await resolveCandidate(ctx, primary.model, primaryChoice, false, signal);
		if (resolved.ok) return resolved;
		const fallback = await resolveFallback(ctx, config, resolved.reason, signal);
		return fallback ?? resolved;
	}

	const sessionModel = ctx.models.current();
	if (!primaryChoice && sessionModel) {
		const resolved = await resolveCandidate(ctx, sessionModel, undefined, false, signal);
		if (resolved.ok) return resolved;
		const fallback = await resolveFallback(ctx, config, resolved.reason, signal);
		return fallback ?? resolved;
	}

	const fallback = await resolveFallback(ctx, config, primary.reason ?? "no model", signal);
	return fallback ?? { ok: false, reason: primary.reason ?? "no model available" };
}

async function resolveFallback(
	ctx: ExtensionContext,
	config: ObMemoryConfig,
	primaryReason: string,
	signal: AbortSignal,
): Promise<ResolveWorkerResult | undefined> {
	if (!config.fallbackModel) return undefined;
	const found = await findModel(ctx, config.fallbackModel);
	if (!found.model) return { ok: false, reason: `${primaryReason}; fallback: ${found.reason}` };
	const resolved = await resolveCandidate(ctx, found.model, config.fallbackModel, true, signal);
	if (resolved.ok) return resolved;
	return { ok: false, reason: `${primaryReason}; fallback: ${resolved.reason}` };
}


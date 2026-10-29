import type { ExtensionContext, ResolvedRequestAuth } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelChoice, ObMemoryConfig, ThinkingLevel } from "../config-types";

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

function usableApiKey(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value !== "N/A" ? value : undefined;
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
	const maxTokens = Math.min(catalogMax ?? 64_000, 16_384);
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


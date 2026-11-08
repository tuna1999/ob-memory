import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../ledger/types";
import {
	foldLedger,
	latestCoverageId,
	latestCoverageIndex,
	observationTokens,
	rawTokensAfterIndex,
	visibleProjection,
} from "../ledger/fold";
import { estimateEntryTokens } from "../ledger/serialize";
import { realTokensSinceObservationCoverage } from "../ledger/usage";
import {
	modelLabel,
	publicConfig,
	resolveObserverChunkMaxTokens,
	resolveWorkerMemoryMaxTokens,
} from "../config";
import { compactionRetainedBudget, compactionSummaryBudget } from "../hooks/policy";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { isHostSecretObfuscationActive } from "../workers/model";

function ago(value: number | undefined): string {
	if (!value) return "never";
	const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

function present(ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI) return;
	const limit = 4_000;
	ctx.ui.notify(text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text, "info");
}

/**
 * omp Hide Secrets detection and the resulting pause state, shown even with
 * showNotifications off, which suppresses the automatic warning. Without a UI
 * the host log and the `session_bind` lifecycle entry record it instead.
 */
function hostSecretsLine(runtime: SessionRuntime): string {
	const active = isHostSecretObfuscationActive(runtime.ctx);
	const host = active === undefined ? "unknown" : active ? "on" : "off";
	const pause =
		runtime.hostSecretsPause === "paused"
			? "automatic memory passes paused since Hide Secrets was detected; /ob-memory passive off resumes them (worker requests would not be obfuscated)"
			: runtime.hostSecretsPause === "overridden"
				? "pause overridden by /ob-memory passive off; worker requests are not obfuscated"
				: !runtime.config.pauseOnHostSecrets
					? `not paused (pauseOnHostSecrets: false)${active ? "; worker requests are not obfuscated" : ""}`
					: "not paused";
	runtime.debug.record("status", "host_secret_obfuscation", {
		active: active ?? "unknown",
		pause: runtime.hostSecretsPause ?? "none",
	});
	return `host Hide Secrets: ${host}; ${pause}`;
}

export function handleStatus(runtime: SessionRuntime, ctx: ExtensionContext): void {
	runtime.updateContext(ctx);
	const entries = ctx.sessionManager.getBranch();
	const fold = foldLedger(entries);
	const visible = visibleProjection(entries);
	const observationCoverage = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const reflectionCoverage = latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
	const rawUnobserved = rawTokensAfterIndex(entries, Math.max(observationCoverage, -1), (entry) =>
		estimateEntryTokens(entry, runtime.estimator),
	);
	const currentContextTokens = runtime.contextTokens();
	const providerDelta = realTokensSinceObservationCoverage(entries, currentContextTokens);
	const hasCompaction = entries.some((entry) => entry.type === "compaction");
	const providerLine =
		currentContextTokens === undefined
			? "provider context: unavailable"
			: observationCoverage < 0 && !hasCompaction
				? `provider context: ~${currentContextTokens.toLocaleString()} tokens now; no observation coverage yet`
				: providerDelta === undefined
					? `provider context: ~${currentContextTokens.toLocaleString()} tokens now; delta since the latest memory anchor unavailable`
					: `provider context: ~${currentContextTokens.toLocaleString()} tokens now; ~${providerDelta.toLocaleString()} since the latest memory anchor`;
	const activeTokens = observationTokens(fold.activeObservations);
	const visibleIds = new Set(visible.observations.map((observation) => observation.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));
	const onlyFullObservations = fold.activeObservations.filter((observation) => !visibleIds.has(observation.id)).length;
	const onlyFullReflections = fold.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)).length;
	const lines = [
		"Observational Memory status",
		`model: ${runtime.modelLabel} (active: ${runtime.activeModelLabel})`,
		`enabled: ${runtime.config.enabled} | passive: ${runtime.config.passive} | busy: ${runtime.busy} | idle: ${runtime.isIdle()}`,
		hostSecretsLine(runtime),
		`records: ${fold.observations.length} observations, ${fold.activeObservations.length} active, ${fold.droppedObservationIds.size} dropped; ${fold.reflections.length} reflections`,
		`tokens: active observations ~${activeTokens.toLocaleString()} / max ${runtime.config.observationsPoolMaxTokens.toLocaleString()} (target ${runtime.config.observationsPoolTargetTokens.toLocaleString()}); unobserved source ~${rawUnobserved.toLocaleString()}`,
		providerLine,
		`coverage: observations OBM ${latestCoverageId(entries, OM_OBSERVATIONS_RECORDED) ?? "none"}; reflections ${latestCoverageId(entries, OM_REFLECTIONS_RECORDED) ?? "none"}`,
		`visible projection: ${visible.observations.length} observations, ${visible.reflections.length} reflections; drift +${onlyFullObservations} observations / +${onlyFullReflections} reflections only in full ledger`,
		`last: observer ${ago(runtime.lastObserverAt)}; reflector ${ago(runtime.lastReflectorAt)}; dropper ${ago(runtime.lastDropperAt)}; compaction ${ago(runtime.lastCompactionAt)}`,
		`last compaction owned: ${runtime.lastCompactionOwned === undefined ? "none" : String(runtime.lastCompactionOwned)}`,
		`last error: ${runtime.lastError ? `${runtime.lastError.stage}: ${runtime.lastError.message} (${ago(runtime.lastError.at)})` : "none"}`,
		`config: ${JSON.stringify(publicConfig(runtime.config))}`,
	];
	const text = lines.join("\n");
	present(ctx, runtime.config.redactSecrets ? redactText(text) : text);
}

interface WorkerModelSelection {
	model: Model | undefined;
	label: string;
	source: "configured" | "session" | "fallback" | "unavailable";
}

/**
 * Mirror of the model-lookup step of `resolveWorkerModel` (src/workers/model.ts):
 * configured model, else the session model when none is configured, else
 * `fallbackModel`. Auth failures, which also switch to the fallback, are only
 * known once a pass runs.
 */
function selectWorkerModel(runtime: SessionRuntime): WorkerModelSelection {
	const { ctx, config } = runtime;
	const configured = config.model;
	const primary = configured ? ctx.models.resolve(modelLabel(configured)) : ctx.models.current();
	if (primary) {
		return {
			model: primary,
			label: `${primary.provider}/${primary.id}`,
			source: configured ? "configured" : "session",
		};
	}
	const fallback = config.fallbackModel ? ctx.models.resolve(modelLabel(config.fallbackModel)) : undefined;
	if (fallback) return { model: fallback, label: `${fallback.provider}/${fallback.id}`, source: "fallback" };
	return {
		model: undefined,
		label: `${configured ? modelLabel(configured) : "session model"} (unavailable)`,
		source: "unavailable",
	};
}

export function effectiveConfig(runtime: SessionRuntime): Record<string, unknown> {
	const configured = runtime.config.model;
	const selection = selectWorkerModel(runtime);
	const worker = selection.model;
	return {
		...publicConfig(runtime.config),
		sessionModel: runtime.activeModelLabel,
		workerModel: selection.label,
		workerModelSource: selection.source,
		workerModelChoice: configured ?? null,
		observerChunkMaxTokens: resolveObserverChunkMaxTokens(runtime.config, worker?.contextWindow),
		workerMemoryMaxTokens: resolveWorkerMemoryMaxTokens(runtime.config, worker?.contextWindow),
		compactionSummaryMaxTokens: compactionSummaryBudget(runtime),
		compactionMaxRetainedTokens: compactionRetainedBudget(runtime),
	};
}

export function handleConfig(runtime: SessionRuntime, ctx: ExtensionContext): void {
	runtime.updateContext(ctx);
	present(ctx, `Observational Memory config\n${JSON.stringify(effectiveConfig(runtime), null, 2)}`);
}

export function handleHelp(runtime: SessionRuntime, ctx: ExtensionContext): void {
	runtime.updateContext(ctx);
	present(
		ctx,
		[
			"Observational Memory commands",
			"/ob-memory view — show the visible memory",
			"/ob-memory view full — show the full branch ledger",
			"/ob-memory status — counts, coverage, pressure, errors",
			"/ob-memory observe-now — run one consolidation pass immediately",
			"/ob-memory passive on|off — pause/resume automatic memory work for this session",
			"/ob-memory config — show effective config",
			"Tool: ob_recall { id } — recover a record and its source evidence",
		].join("\n"),
	);
}


import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import {
	OM_OBSERVATIONS_RECORDED,
	isMemoryDetails,
	type LedgerEntry,
	type MemoryDetails,
	type Observation,
} from "../ledger/types";
import {
	compactionProjection,
	latestCoverageId,
	latestCoverageIndex,
	latestResetBoundaryIndex,
	rawTokensAfterIndex,
	unwrapCompactionDetails,
	type Projection,
} from "../ledger/fold";
import { renderMemory, type RenderedMemory } from "../ledger/render";
import { chunkUnobservedEntries } from "../ledger/serialize";
import { resolveObserverChunkMaxTokens } from "../config";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import type { TokenEstimator } from "../util/tokens";
import { resolveWorkerModel } from "../workers/model";
import { observeChunk, cancelScheduledConsolidation } from "../workers/trigger";
import {
	createContextTokenCounter,
	entryIndexForId,
	liveContextStartIndex,
	observedCoverageIndex,
	resolveCompactionCut,
	skippedSourceSpans,
	type CompactionReason,
	type CutResolution,
} from "./cut";
import {
	compactionMinimumSummaryTokens,
	compactionRetainedBudget,
	compactionSummaryBudget,
	hostResidualBudget,
	hostResidualCheck,
	recordAutoCompactionEnd,
	recordAutoCompactionStart,
	resolveCompactionReason,
	shouldOwnCompaction,
} from "./policy";

/** Upper bound on waiting for an aborted background pass to release the lock. */
const COMPACTION_PREEMPT_WAIT_MS = 5_000;

/**
 * omp's notes-backed context management (`compaction.experimentalContextManagement`)
 * snapshots the branch leaf before emitting session_before_compact and cancels
 * the compaction (manual `/compact`) or skips the rollover (automatic) when the
 * leaf moved by the time the hook returns (session-maintenance.ts
 * `#compactExperimentalContext`, `#runExperimentalContextRollover`). Every
 * ledger append moves the leaf, so in that mode nothing may be appended while
 * the compaction is in flight. The flag reaches the hook in the preparation
 * settings; with it set but the rollover tools unavailable the host compacts
 * normally, and skipping catch-up there is merely conservative.
 */
function hostRequiresStableLeaf(event: SessionBeforeCompactEvent): boolean {
	const settings: unknown = event.preparation?.settings;
	return (
		settings !== null &&
		typeof settings === "object" &&
		(settings as Record<string, unknown>).experimentalContextManagement === true
	);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Mirror of pi-agent-core 18.13.3 `isTranscriptUsageAnchor` with
 * `hasContextTokenUsage` (compaction/transcript-tokens.ts, compaction.ts): a
 * settled assistant message whose provider usage reports context tokens.
 * Replicated, like the policy constants, so a host rename cannot break loading.
 */
function isUsageAnchor(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || record.stopReason === "aborted" || record.stopReason === "error") return false;
	const usage = record.usage;
	if (!usage || typeof usage !== "object") return false;
	const fields = usage as Record<string, unknown>;
	if (finiteNumber(fields.contextTokens) > 0) return true;
	const prompt = finiteNumber(fields.input) + finiteNumber(fields.cacheRead) + finiteNumber(fields.cacheWrite);
	if (prompt > 0) return true;
	// calculateContextTokens(usage) > usage.output
	if (fields.contextTokens !== undefined) return false;
	const output = finiteNumber(fields.output);
	const orchestration = fields.orchestration as Record<string, unknown> | undefined;
	const orchestrationTokens =
		orchestration && typeof orchestration === "object"
			? finiteNumber(orchestration.input) + finiteNumber(orchestration.output) + finiteNumber(orchestration.cacheRead)
			: 0;
	const raw = finiteNumber(fields.totalTokens) || output;
	return Math.max(0, raw - orchestrationTokens) > output;
}

/**
 * The assistant message the host anchors context usage on (session-stats.ts
 * `getContextBreakdown`): the newest usage anchor after the latest compaction
 * and `/clear`. Its provider-reported prompt tokens cover everything before
 * it, but not the anchor's own content.
 */
function usageAnchorMessage(entries: readonly LedgerEntry[]): unknown {
	let lower = latestResetBoundaryIndex(entries);
	for (let i = entries.length - 1; i > lower; i--) {
		const entry = entries[i];
		if (entry?.type === "compaction") {
			lower = i;
			break;
		}
	}
	for (let i = entries.length - 1; i > lower; i--) {
		const entry = entries[i];
		if (entry?.type === "message" && isUsageAnchor(entry.message)) return entry.message;
	}
	return undefined;
}

function isSameAssistantMessage(candidate: unknown, anchor: unknown): boolean {
	if (!candidate || typeof candidate !== "object" || !anchor || typeof anchor !== "object") return false;
	const a = candidate as Record<string, unknown>;
	const b = anchor as Record<string, unknown>;
	return a.role === "assistant" && b.role === "assistant" && typeof a.timestamp === "number" && a.timestamp === b.timestamp;
}

/**
 * Context the host counts outside the message list after compaction (system
 * prompt, tool schemas, skills): `#compactionCreatedHeadroom` measures
 * `nonMessageTokens + stored messages`. Extensions cannot read the non-message
 * part directly, so take the larger of the system prompt estimate and what the
 * current context usage leaves once the messages it holds are subtracted.
 *
 * Host usage is `anchor.promptTokens + count(messages after the anchor)`
 * (session-stats.ts `#anchoredUsedTokens`): the usage anchor's own content is
 * never part of it, so it is not subtracted either.
 */
function estimateFixedContextTokens(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	entries: readonly LedgerEntry[],
): number {
	let systemPromptTokens = 0;
	try {
		const parts: unknown = typeof runtime.ctx.getSystemPrompt === "function" ? runtime.ctx.getSystemPrompt() : undefined;
		if (Array.isArray(parts)) {
			const text = parts.filter((part): part is string => typeof part === "string").join("\n");
			systemPromptTokens = text ? runtime.estimator(text) : 0;
		}
	} catch {
		// Optional host API.
	}
	const usageTokens = runtime.contextTokens();
	if (usageTokens === undefined) return systemPromptTokens;
	const counter = createContextTokenCounter(runtime);
	const preparation = event.preparation;
	const messages: unknown[] = [];
	for (const list of [preparation.messagesToSummarize, preparation.turnPrefixMessages, preparation.recentMessages]) {
		if (Array.isArray(list)) messages.push(...list);
	}
	let messageTokens = 0;
	for (const message of messages) messageTokens += counter.message(message);
	const anchor = usageAnchorMessage(entries);
	if (anchor !== undefined) {
		// Like the host: match by identity first, then by assistant timestamp.
		const prepared =
			messages.find((message) => message === anchor) ??
			messages.find((message) => isSameAssistantMessage(message, anchor));
		if (prepared !== undefined) messageTokens -= counter.message(prepared);
	}
	// The previous compaction's summary is in context but not in the
	// preparation's message lists, unless a later `/clear` dropped it.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type === "reset_boundary") break;
		if (entry.type !== "compaction") continue;
		if (typeof entry.summary === "string") messageTokens += runtime.estimator(entry.summary);
		break;
	}
	return Math.max(systemPromptTokens, usageTokens - messageTokens);
}

interface CatchUpOutcome {
	/** Chunks that advanced observation coverage. */
	chunks: number;
	/** The live branch when coverage advanced, otherwise the input entries. */
	entries: LedgerEntry[];
	/** Observation coverage on the live branch moved during catch-up. */
	advanced: boolean;
}

async function catchUp(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	entries: LedgerEntry[],
	deadline: number,
	needsMore: (entries: LedgerEntry[]) => boolean,
	complete?: typeof completeSimple,
): Promise<CatchUpOutcome> {
	const startCoverageId = latestCoverageId(entries, OM_OBSERVATIONS_RECORDED);
	let chunks = 0;
	if (Date.now() < deadline) {
		await runtime.runExclusive("compaction.catchup", async (signal) => {
			const combined = AbortSignal.any([signal, event.signal]);
			if (Date.now() >= deadline) return;
			const model = await resolveWorkerModel(runtime.ctx, runtime.config, combined);
			if (combined.aborted || Date.now() >= deadline) return;
			if (!model.ok) {
				runtime.noteFailure("compaction.catchup.resolve", model.reason);
				return;
			}
			const chunkMaxTokens = resolveObserverChunkMaxTokens(
				runtime.config,
				model.value.model.contextWindow,
			);
			let currentEntries = entries;
			let currentCoverageId = startCoverageId;
			for (let i = 0; i < runtime.config.compactionCatchUpMaxChunks; i++) {
				const remaining = deadline - Date.now();
				if (remaining <= 0 || combined.aborted) break;
				// Hide Secrets switched on during the preempt wait, model
				// resolution or an earlier chunk pauses the session and aborts
				// this pass before more raw source is sent.
				runtime.beforePass?.();
				if (combined.aborted) break;
				const chunk = chunkUnobservedEntries(
					currentEntries,
					currentCoverageId,
					chunkMaxTokens,
					runtime.estimator,
					{ observeAttachments: runtime.config.observeAttachments, redact: runtime.config.redactSecrets },
				);
				if (!chunk) break;
				// Bound the awaited worker call, not only the gaps between chunks.
				// A timeout is a normal catch-up miss, not a worker failure.
				const chunkSignal = AbortSignal.any([combined, AbortSignal.timeout(remaining)]);
				let failed = false;
				try {
					await observeChunk(runtime, currentEntries, model.value, chunk, chunkSignal, complete);
				} catch (error) {
					failed = true;
					// A worker failure still backs off background passes, but it
					// must not discard what earlier chunks already recorded.
					if (!chunkSignal.aborted) runtime.noteFailure("compaction.catchup", error);
				}
				// Judge progress by the ledger, not the return value: a chunk may
				// advance coverage without records, or append before it fails.
				const next = runtime.ctx.sessionManager.getBranch() as LedgerEntry[];
				const nextCoverageId = latestCoverageId(next, OM_OBSERVATIONS_RECORDED);
				if (nextCoverageId === currentCoverageId) break;
				chunks++;
				currentEntries = next;
				currentCoverageId = nextCoverageId;
				// Observing the kept tail only adds latency to a blocking hook.
				if (failed || !needsMore(currentEntries)) break;
			}
		}, { requireIdle: false });
	}
	// Re-read even when the pass failed or was refused: whatever reached the
	// ledger must shape the cut.
	const live = runtime.ctx.sessionManager.getBranch() as LedgerEntry[];
	const advanced = latestCoverageId(live, OM_OBSERVATIONS_RECORDED) !== startCoverageId;
	runtime.debug.record("compaction", "catchup", { chunks, advanced });
	return { chunks, entries: advanced ? live : entries, advanced };
}

function delegate(
	runtime: SessionRuntime,
	reason: CompactionReason,
	why: string,
	gap?: { gap?: { entryCount: number } },
): undefined {
	runtime.lastCompactionOwned = false;
	runtime.debug.record("compaction", "delegated", {
		reason,
		why,
		gapEntries: gap?.gap?.entryCount,
	});
	return undefined;
}

interface SummaryLimit {
	/** Context tokens of the messages the compaction keeps verbatim. */
	keptTokens: number;
	/** Budget for the kept messages plus the summary. */
	limitTokens: number;
	fixedContextTokens: number;
	/**
	 * Delegate instead of overshooting when the room left is too small. Only a
	 * compaction that keeps more than native would (the retained unobserved
	 * tail) can avoid the overshoot that way: native compaction keeps the
	 * host's own tail, so with that tail it would overshoot just the same.
	 */
	delegateWhenShort: boolean;
}

/**
 * What an owned result has to fit together with what it keeps. With a gap,
 * ob-memory keeps more than the host asked for (the retained unobserved
 * tail), so it holds that tail plus the summary to the recovery band and
 * `compactionMaxRetainedTokens` for every reason, as before. Without one the
 * host's own kept tail (firstKeptEntryId to the leaf, measured the way the
 * host measures it) plus the summary is held to the check the host actually
 * runs for this reason (`hostResidualCheck`): none after idle passes and
 * manual `/compact`. Undefined when nothing caps the result.
 */
function ownedSummaryLimit(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	resolution: Extract<CutResolution, { kind: "cut" }>,
	entries: readonly LedgerEntry[],
	reason: CompactionReason,
): SummaryLimit | undefined {
	const settings = event.preparation.settings;
	if (resolution.retainedTokens !== undefined) {
		const fixedContextTokens = estimateFixedContextTokens(runtime, event, entries);
		return {
			keptTokens: resolution.retainedTokens,
			limitTokens: compactionRetainedBudget(runtime, { settings, fixedContextTokens }),
			fixedContextTokens,
			delegateWhenShort: true,
		};
	}
	const check = hostResidualCheck(reason);
	if (!check || !settings) return undefined;
	const fixedContextTokens = estimateFixedContextTokens(runtime, event, entries);
	const limitTokens = hostResidualBudget(runtime, { settings, fixedContextTokens }, check);
	if (limitTokens === undefined) return undefined;
	const counter = createContextTokenCounter(runtime);
	const keptTokens = rawTokensAfterIndex(
		entries,
		entryIndexForId(entries, resolution.firstKeptEntryId) - 1,
		(entry) => counter.entry(entry),
	);
	return { keptTokens, limitTokens, fixedContextTokens, delegateWhenShort: false };
}

interface CompactionRender {
	rendered: RenderedMemory;
	/** Every reflection and every observation about the compacted range was rendered. */
	complete: boolean;
}

function renderedNothing(rendered: RenderedMemory): boolean {
	return !rendered.text || rendered.observations.length + rendered.reflections.length === 0;
}

function renderedEverything(rendered: RenderedMemory, maxTokens: number): boolean {
	return rendered.omittedObservations + rendered.omittedReflections === 0 && rendered.tokens <= maxTokens;
}

/**
 * Render memory for a compaction that keeps `entries[keptStart..]` verbatim.
 * An observation whose sources all lie in that kept region describes context
 * that stays in place, so it only fills room left once every reflection and
 * every observation about the compacted range is rendered: `renderMemory`
 * alone keeps the newest records, and with coverage past the cut those are
 * exactly the redundant ones.
 */
function renderForCompaction(
	projection: Projection,
	entries: readonly LedgerEntry[],
	keptStart: number,
	maxTokens: number,
	estimate: TokenEstimator,
): CompactionRender {
	const render = (observations: readonly Observation[]) =>
		renderMemory(projection.reflections, observations, { maxTokens, estimate });
	const redundant = new Set<string>();
	if (keptStart >= 0) {
		const indexes = new Map<string, number>();
		for (let i = 0; i < entries.length; i++) indexes.set(entries[i]!.id, i);
		for (const observation of projection.observations) {
			const sources = observation.sourceEntryIds;
			if (sources.length > 0 && sources.every((id) => (indexes.get(id) ?? -1) >= keptStart)) {
				redundant.add(observation.id);
			}
		}
	}
	if (redundant.size === 0) {
		const rendered = render(projection.observations);
		return { rendered, complete: renderedEverything(rendered, maxTokens) };
	}
	const essential = render(projection.observations.filter((observation) => !redundant.has(observation.id)));
	if (!renderedEverything(essential, maxTokens)) return { rendered: essential, complete: false };
	// Add the newest redundant observations that still fit beside everything
	// essential. Whether all of them fit is monotonic in their count.
	const extras = projection.observations.filter((observation) => redundant.has(observation.id));
	const withNewestExtras = (count: number) => {
		const chosen = new Set(extras.slice(extras.length - count).map((observation) => observation.id));
		return render(projection.observations.filter((observation) => !redundant.has(observation.id) || chosen.has(observation.id)));
	};
	let best = essential;
	let low = 1;
	let high = extras.length;
	while (low <= high) {
		const count = (low + high) >>> 1;
		const candidate = withNewestExtras(count);
		if (renderedEverything(candidate, maxTokens)) {
			best = candidate;
			low = count + 1;
		} else {
			high = count - 1;
		}
	}
	return { rendered: best, complete: true };
}

const CARRIED_SUMMARY_HEADING = "## Earlier compaction summary";
const CARRIED_SUMMARY_NOTE =
	"Part of the earlier conversation never reached memory: the observer skipped it after repeated failures. This summary from an earlier compaction is the only remaining record of it.";

interface CarriedSummary {
	/** Summary text carried forward; persisted in the details for the next owned compaction. */
	text: string;
	/** The section appended after the rendered memory. */
	section: string;
	/** Tokens the section adds to the summary, separator included. */
	tokens: number;
}

/** Memory details plus the carried summary, an extra key older readers ignore. */
type OwnedCompactionDetails = MemoryDetails & { carriedSummary?: string };

/**
 * A chunk the observer skipped (retry_limit) that already left model context
 * was never observed, so the latest compaction summary is the only record of
 * it: the native summary that compacted it, or what an earlier owned
 * compaction carried forward. An owned summary replaces that summary in
 * context, so it has to carry it on.
 */
function carriedSummary(runtime: SessionRuntime, entries: readonly LedgerEntry[]): CarriedSummary | undefined {
	const reset = latestResetBoundaryIndex(entries);
	let compactionIndex = -1;
	for (let i = entries.length - 1; i > reset; i--) {
		if (entries[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return undefined;
	const liveStart = liveContextStartIndex(entries);
	const skippedOutOfContext = skippedSourceSpans(entries).some(
		(span) => span.firstIndex > reset && span.lastIndex < liveStart,
	);
	if (!skippedOutOfContext) return undefined;
	const compaction = entries[compactionIndex]!;
	const details = unwrapCompactionDetails(compaction.details);
	let raw: unknown;
	if (isMemoryDetails(details)) raw = (details as OwnedCompactionDetails).carriedSummary;
	// A notes-backed rollover's summary is a prompt, not a summary.
	else if (details === compaction.details) raw = compaction.summary;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const text = runtime.config.redactSecrets ? redactText(raw.trim()) : raw.trim();
	const section = `${CARRIED_SUMMARY_HEADING}\n${CARRIED_SUMMARY_NOTE}\n\n${text}`;
	return { text, section, tokens: runtime.estimator(`\n\n${section}`) };
}

interface OwnedSummary extends CompactionRender {
	text: string;
	tokens: number;
}

function buildCompactionResult(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	resolution: Extract<CutResolution, { kind: "cut" }>,
	entries: LedgerEntry[],
	reason: CompactionReason,
): SessionBeforeCompactResult | undefined {
	const projection = compactionProjection(entries, resolution.foldThroughEntryId);
	if (projection.observations.length + projection.reflections.length === 0) return undefined;
	const budget = compactionSummaryBudget(runtime);
	const minimum = compactionMinimumSummaryTokens(runtime);
	const carried = carriedSummary(runtime, entries);
	if (carried && carried.tokens > budget - minimum) {
		// Never drop the only record of a skipped chunk: native compaction
		// summarizes the previous summary again.
		runtime.debug.record("compaction", "carried_summary_exceeds_budget", {
			carriedTokens: carried.tokens,
			summaryBudget: budget,
			minimumSummaryTokens: minimum,
		});
		return undefined;
	}
	const keptStart = entryIndexForId(entries, resolution.firstKeptEntryId);
	const compose = (maxTokens: number): OwnedSummary => {
		const memoryTokens = carried ? maxTokens - carried.tokens : maxTokens;
		const render = renderForCompaction(projection, entries, keptStart, memoryTokens, runtime.estimator);
		if (!carried || renderedNothing(render.rendered)) {
			return { ...render, text: render.rendered.text, tokens: render.rendered.tokens };
		}
		const text = `${render.rendered.text}\n\n${carried.section}`;
		return { ...render, text, tokens: runtime.estimator(text) };
	};
	let summary = compose(budget);
	if (renderedNothing(summary.rendered)) return undefined;

	const limit = ownedSummaryLimit(runtime, event, resolution, entries, reason);
	if (limit && limit.keptTokens + summary.tokens > limit.limitTokens) {
		// Shrink the summary to the room left. With a retained tail, a summary
		// below the minimum has to still hold everything about the compacted
		// range, or delegating (native keeps a smaller tail) does better.
		const room = limit.limitTokens - limit.keptTokens;
		const shrunk = room > 0 ? compose(Math.min(budget, room)) : undefined;
		const debug = {
			keptTokens: limit.keptTokens,
			gap: resolution.retainedTokens !== undefined,
			fixedContextTokens: limit.fixedContextTokens,
			retainedBudget: limit.limitTokens,
			minimumSummaryTokens: minimum,
		};
		const carriedTokens = carried?.tokens ?? 0;
		if (
			shrunk &&
			!renderedNothing(shrunk.rendered) &&
			shrunk.tokens <= room &&
			(room - carriedTokens >= minimum || shrunk.complete || !limit.delegateWhenShort)
		) {
			summary = shrunk;
			runtime.debug.record("compaction", "summary_shrunk_to_band", { ...debug, summaryTokens: summary.tokens });
		} else if (limit.delegateWhenShort) {
			runtime.debug.record("compaction", "retained_budget_exceeded", { ...debug, summaryTokens: shrunk?.tokens });
			return undefined;
		} else {
			// The host's own kept tail leaves no room for any summary. Native
			// compaction would keep that same tail, so delegating cannot avoid
			// the overshoot; own it with a summary no larger than the fallback's.
			const floor = compose(Math.min(budget, minimum + carriedTokens));
			if (renderedNothing(floor.rendered)) return undefined;
			summary = floor;
			runtime.debug.record("compaction", "summary_exceeds_band", { ...debug, summaryTokens: summary.tokens });
		}
	}

	const rendered = summary.rendered;
	const details: OwnedCompactionDetails = {
		...projection.details,
		observations: rendered.observations,
		reflections: rendered.reflections,
		foldThroughEntryId: resolution.foldThroughEntryId,
		...(carried ? { carriedSummary: carried.text } : {}),
	};
	const text = runtime.config.redactSecrets ? redactText(summary.text) : summary.text;
	const compaction: CompactionResult<MemoryDetails> = {
		summary: text,
		shortSummary: `Observational memory: ${rendered.observations.length} observations, ${rendered.reflections.length} reflections`,
		firstKeptEntryId: resolution.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	};
	runtime.lastCompactionOwned = true;
	runtime.lastCompactionAt = Date.now();
	runtime.lastCompactionRecords = rendered.observations.length + rendered.reflections.length;
	runtime.debug.record("compaction", "owned", {
		firstKeptEntryId: resolution.firstKeptEntryId,
		foldThroughEntryId: resolution.foldThroughEntryId,
		observations: rendered.observations.length,
		reflections: rendered.reflections.length,
		summaryTokens: summary.tokens,
		carriedSummaryTokens: carried?.tokens,
		retainedTokens: resolution.retainedTokens,
		gap: resolution.gap?.entryCount,
	});
	return { compaction };
}

/**
 * Take ownership of compaction only when the ledger covers every source entry
 * being summarized, or when the uncovered tail can be retained within budget.
 * Otherwise native compaction runs, preserving the raw context.
 */
export async function handleSessionBeforeCompact(
	runtime: SessionRuntime,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	options: { complete?: typeof completeSimple } = {},
): Promise<SessionBeforeCompactResult | undefined> {
	cancelScheduledConsolidation(runtime);
	runtime.updateContext(ctx);
	const reason = resolveCompactionReason(runtime);
	const stableLeaf = hostRequiresStableLeaf(event);
	// A running background pass would append between the host's leaf snapshot
	// and its check. Abort without waiting: every append is preceded by
	// throwIfAborted, so an aborted pass cannot move the leaf any more.
	if (stableLeaf && runtime.busy) runtime.abort("compaction requires a stable branch leaf");
	if (event.signal.aborted) return undefined;
	try {
		if (event.customInstructions?.trim()) {
			return delegate(runtime, reason, "user focus instructions require native summarization");
		}
		let entries = event.branchEntries as LedgerEntry[];
		const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
		if (!shouldOwnCompaction(runtime, reason, coverageIndex >= 0)) {
			return delegate(runtime, reason, "policy or no coverage");
		}

		const rangeStart = (() => {
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.type === "compaction") return i;
			}
			return -1;
		})();
		const resolveAt = (next: readonly LedgerEntry[]): CutResolution =>
			resolveCompactionCut(
				next,
				event.preparation.firstKeptEntryId,
				latestCoverageIndex(next, OM_OBSERVATIONS_RECORDED),
				{ reason, runtime, rangeStartIndex: rangeStart },
			);
		let resolution = resolveAt(entries);
		// A chunk the observer skipped (retry_limit) that is still in context
		// starts the gap, and observing newer chunks cannot shrink it: the
		// watermark would move while observed coverage stays put.
		const skippedSpanStartsGap = (next: readonly LedgerEntry[]): boolean => {
			const coverage = latestCoverageIndex(next, OM_OBSERVATIONS_RECORDED);
			return coverage >= 0 && observedCoverageIndex(next, coverage) < coverage;
		};

		// Catch up whenever the observer is behind the proposed cut, even when
		// the initial resolution would delegate because the uncovered tail does
		// not fit. Catch-up can shrink that tail enough to own the compaction.
		const catchUpBudgetMs = runtime.config.compactionCatchUpBudgetMs;
		if (resolution.gap && stableLeaf) {
			// Retain the unobserved tail or delegate instead: an append here
			// would make the host cancel or skip this compaction.
			runtime.debug.record("compaction", "catchup_skipped_stable_leaf", {
				gapEntries: resolution.gap.entryCount,
			});
		} else if (resolution.gap && skippedSpanStartsGap(entries)) {
			runtime.debug.record("compaction", "catchup_skipped_unobserved_span", {
				gapEntries: resolution.gap.entryCount,
			});
		} else if (resolution.gap && runtime.config.compactionCatchUpMaxChunks > 0 && catchUpBudgetMs > 0) {
			// One wall-clock budget covers waiting for a background pass and
			// the catch-up itself.
			const deadline = Date.now() + catchUpBudgetMs;
			const resolveFrom = (next: LedgerEntry[]): void => {
				entries = next;
				resolution = resolveAt(entries);
			};
			// A background consolidation would otherwise make catch-up skip
			// entirely and keep calling the worker model and appending ledger
			// entries while the summary is built. Preempt it; whatever it
			// already appended is picked up by re-reading the branch.
			if (runtime.busy) {
				const settled = await runtime.preempt(
					"compaction",
					Math.min(COMPACTION_PREEMPT_WAIT_MS, catchUpBudgetMs),
				);
				if (settled) resolveFrom(runtime.ctx.sessionManager.getBranch() as LedgerEntry[]);
				else runtime.debug.record("compaction", "catchup_skipped_busy");
			}
			if (resolution.gap && !runtime.busy && !event.signal.aborted && !skippedSpanStartsGap(entries)) {
				const catchUpResult = await catchUp(
					runtime,
					event,
					entries,
					deadline,
					// Stop once nothing before the proposed cut is unobserved, or
					// once a skipped chunk (possibly skipped by this very pass)
					// starts the gap.
					(next) => resolveAt(next).gap !== undefined && !skippedSpanStartsGap(next),
					options.complete,
				);
				if (catchUpResult.advanced) resolveFrom(catchUpResult.entries);
			}
		}
		if (event.signal.aborted) return undefined;
		// A Hide Secrets pause or `passive on` that began during the preempt
		// wait or catch-up leaves this compaction to the host, as one detected
		// at entry does. Coverage was confirmed above.
		if (!shouldOwnCompaction(runtime, reason, true)) {
			return delegate(runtime, reason, "passive since the compaction started");
		}

		if (resolution.kind === "delegate") {
			return delegate(runtime, reason, resolution.reason, resolution);
		}
		if (resolution.gap) {
			runtime.debug.record("compaction", "retaining_unobserved_tail", {
				gapEntries: resolution.gap.entryCount,
				retainedTokens: resolution.retainedTokens,
				firstKeptEntryId: resolution.firstKeptEntryId,
			});
		}
		const result = buildCompactionResult(runtime, event, resolution, entries, reason);
		if (!result) {
			return delegate(runtime, reason, "no rendered memory fits or no records");
		}
		return result;
	} catch (error) {
		runtime.recordError("compaction.before", error);
		runtime.lastCompactionOwned = false;
		return undefined;
	}
}

export function registerCompactionEvents(pi: ExtensionAPI, getRuntime: () => SessionRuntime | undefined): void {
	pi.on("auto_compaction_start", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		recordAutoCompactionStart(runtime, event);
	});
	pi.on("auto_compaction_end", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		recordAutoCompactionEnd(runtime, event);
	});
	pi.on("session_compact", (event, ctx) => {
		const runtime = getRuntime();
		if (!runtime) return;
		runtime.updateContext(ctx);
		runtime.lastCompactionOwned = event.fromExtension;
		runtime.lastCompactionAt = Date.now();
		runtime.lastAutoCompactionReason = undefined;
		runtime.lastAutoCompactionAction = undefined;
		runtime.autoCompactionStartedAt = 0;
		runtime.debug.record("compaction", "session_compact", {
			fromExtension: event.fromExtension,
			entryId: event.compactionEntry.id,
			details: event.compactionEntry.details ? "present" : undefined,
		});
	});
}

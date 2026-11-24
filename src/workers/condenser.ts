import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { estimateTextTokens } from "../constants";
import { resolveWorkerMemoryMaxTokens } from "../config";
import { isLowValueRecordContent } from "../ledger/quality";
import { reflectionLine, reflectionTier, type Observation, type Reflection } from "../ledger/types";
import type { SessionRuntime } from "../runtime";
import { redactText } from "../security/redact";
import { hashMemoryId, normalizeRecordContentStrict } from "../util/ids";
import { formatRejections, runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { CONDENSER_SYSTEM, MERGE_CHECKER_SYSTEM } from "./prompts";

const CONDENSE_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["merges", "retire"],
	properties: {
		merges: {
			type: "array",
			description: "Groups of listed reflections, each replaced by one shorter line. Empty when nothing should be merged.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["replaces", "subject", "content"],
				properties: {
					replaces: {
						type: "array",
						minItems: 1,
						items: { type: "string", minLength: 1 },
						description: "Ids from REFLECTION POOL that this line replaces.",
					},
					subject: {
						type: "string",
						minLength: 1,
						maxLength: 80,
						description:
							"The one subject this line covers, in a few words and without 'and' or commas (for example 'retry persistence'). If it cannot be named without joining two subjects, merge them separately.",
					},
					content: {
						type: "string",
						minLength: 1,
						description: "One line of plain prose, shorter than the replaced reflections combined, keeping their durable meaning.",
					},
				},
			},
		},
		retire: {
			type: "array",
			items: { type: "string", minLength: 1 },
			description: "Ids from REFLECTION POOL with no remaining durable value. Empty when nothing should be retired.",
		},
	},
};

const CHECK_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["merges"],
	properties: {
		merges: {
			type: "array",
			description: "One entry per merge shown.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["merge", "issues"],
				properties: {
					merge: { type: "integer", minimum: 1, description: "The merge number shown as MERGE <n>." },
					issues: {
						type: "array",
						description: "Claims of the merged line that its sources do not support. Empty for a faithful merge.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["claim", "problem"],
							properties: {
								claim: { type: "string", minLength: 1, description: "Words of the merged line, quoted exactly." },
								problem: { type: "string", minLength: 1, description: "One sentence: what the sources say instead." },
							},
						},
					},
				},
			},
		},
	},
};

/**
 * Reflection tokens listed in one condenser request. A large pool is condensed
 * over several short passes instead of one long one: a pass holds the
 * consolidation lock, a new agent run aborts it (discarding everything it
 * accepted), and a smaller batch keeps each decision within one or two turns.
 * Reasoning models think longer about a larger batch: at `reasoning_effort:
 * low` a 3,000-token batch spent all of an 8,192-token output budget on
 * reasoning in most calls and answered nothing.
 */
export const CONDENSER_BATCH_MAX_TOKENS = 1_000;
/** Smallest batch an output-limit failure shrinks the batch to. */
export const CONDENSER_MIN_BATCH_TOKENS = 250;
/** A worker reply cut off by its output token limit before it said anything usable. */
const OUTPUT_LIMIT_ERROR = /output token limit|max_tokens|\bcut at its length\b/i;

/** Whether `error` is a condenser reply that ran out of output tokens (usually spent on reasoning). */
export function isOutputLimitError(error: unknown): boolean {
	return OUTPUT_LIMIT_ERROR.test(error instanceof Error ? error.message : String(error));
}

/**
 * Halve the session's condenser batch after an output-limit failure, so the
 * next call asks for less. Returns false once the batch is at its minimum.
 */
export function shrinkCondenserBatch(runtime: SessionRuntime): boolean {
	const current = runtime.condenserBatchTokens ?? CONDENSER_BATCH_MAX_TOKENS;
	if (current <= CONDENSER_MIN_BATCH_TOKENS) return false;
	runtime.condenserBatchTokens = Math.max(CONDENSER_MIN_BATCH_TOKENS, Math.floor(current / 2));
	runtime.debug.record("condenser", "batch_shrunk", { from: current, to: runtime.condenserBatchTokens });
	return true;
}
/** A merged line must be at most this share of what it replaces. */
export const CONDENSER_MAX_MERGED_SHARE = 0.9;
/**
 * Hard cap for one merged line. A line that absorbs a whole topic grows past
 * what a reader scans, and newest-first budgets skip long lines first.
 */
export const CONDENSER_MAX_MERGED_TOKENS = 200;
/**
 * Hard cap for a line that merges already-condensed lines: those are dense,
 * so two of them rarely fit the plain cap without dropping what they keep.
 */
export const CONDENSER_MAX_MERGED_CONDENSED_TOKENS = 250;
/**
 * Newest reflection tokens kept out of every batch (at most half the target),
 * so what the assistant learned last stays verbatim until newer reflections
 * push it out of this window.
 */
export const CONDENSER_RECENT_MAX_TOKENS = 2_000;
/**
 * Reflections outside the batch shown read-only beside it, newest first: they
 * reveal which listed reflections are already covered elsewhere or describe a
 * state that has since moved on.
 */
export const CONDENSER_CONTEXT_MAX_TOKENS = 5_000;
/** Upper bound on the cut asked of one batch; deeper cuts lose meaning. */
const MAX_BATCH_CUT_SHARE = 0.5;
/**
 * Upper bound on the cut asked of a batch made mostly of merged lines: they
 * were distilled once already, so only overlap between them is left to cut.
 */
const MAX_CONDENSED_BATCH_CUT_SHARE = 0.3;
/**
 * Model turns in one condenser call. The first turn does most of the work;
 * the rest only fix rejected proposals, so a long correction loop cannot hold
 * the consolidation lock for many minutes.
 */
export const CONDENSER_MAX_TURNS = 4;
/**
 * Source tokens one merge check may send: the original reflections behind the
 * merges of one condenser call. A source whose originals do not fit is shown
 * as the reflection the condenser saw.
 */
export const CONDENSER_CHECK_MAX_TOKENS = 12_000;
/**
 * Turns for one merge check. A report needs no reply, and a model asked for
 * another turn mostly sends the same report again; a malformed report leaves
 * the merges unchecked, as a failed check does.
 */
export const CONDENSER_CHECK_MAX_TURNS = 1;
/** Characters of a checker claim or explanation passed back with a rejected merge. */
const CHECK_TEXT_MAX_CHARS = 200;
const POOL_HEADER = "REFLECTION POOL (oldest first):";
const CONTEXT_HEADER = "OTHER REFLECTIONS (read-only context, oldest first; not part of this batch):";

/** Newest reflection tokens a condenser run leaves untouched for this target. */
export function condenserRecentTokens(targetTokens: number): number {
	return Math.max(0, Math.min(CONDENSER_RECENT_MAX_TOKENS, Math.floor(targetTokens / 2)));
}

export interface ReflectionPoolMetrics {
	reflectionTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	averageReflectionTokens: number;
	/** Hard limit on retirements without a replacement; merges are not counted. */
	maxRetiresAllowed: number;
}

export function reflectionPoolMetrics(reflections: readonly Reflection[], targetTokens: number): ReflectionPoolMetrics {
	const reflectionTokens = reflections.reduce((total, reflection) => total + reflection.tokenCount, 0);
	const tokensOverTarget = Math.max(0, reflectionTokens - targetTokens);
	const averageReflectionTokens = reflections.length > 0 ? reflectionTokens / reflections.length : 0;
	const maxRetiresAllowed =
		tokensOverTarget <= 0 || averageReflectionTokens <= 0
			? 0
			: Math.min(reflections.length, Math.max(1, Math.ceil(tokensOverTarget / averageReflectionTokens)));
	return { reflectionTokens, targetTokens, tokensOverTarget, averageReflectionTokens, maxRetiresAllowed };
}

export interface CondenseResult {
	/** Replacement reflections, each naming the reflections it merged in `condensedFromIds`. */
	reflections: Reflection[];
	/** Every reflection this run retires, merged or obsolete, in pool order. */
	retiredReflectionIds: string[];
}

export interface RunCondenserOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	/** Active reflections in pool order (oldest first). */
	reflections: readonly Reflection[];
	/** Every recorded observation, dropped ones included: their relevance decides protection. */
	observations: readonly Observation[];
	targetTokens: number;
	/**
	 * Every reflection on the branch, retired ones included: each proposed
	 * merge is checked against the original reflections it descends from.
	 */
	reflectionsById?: ReadonlyMap<string, Reflection>;
	signal: AbortSignal;
	complete?: typeof completeSimple;
}

/**
 * The never-condensed reflections a reflection descends from, oldest first;
 * a reflection that was never condensed is its own original. Sources missing
 * from `byId` (cleared by a /clear) are skipped.
 */
export function originalReflections(reflection: Reflection, byId: ReadonlyMap<string, Reflection>): Reflection[] {
	if (!reflection.condensedFromIds) return [reflection];
	const originals: Reflection[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		const source = byId.get(id);
		if (!source) return;
		if (source.condensedFromIds) source.condensedFromIds.forEach(visit);
		else originals.push(source);
	};
	reflection.condensedFromIds.forEach(visit);
	return originals;
}

interface MergeCandidate {
	content: string;
	/** Replaced reflection ids in pool order. */
	sources: string[];
	tokenCount: number;
	replacedTokens: number;
}

interface MergeIssue {
	claim: string;
	problem: string;
}

function normalizeForQuote(text: string): string {
	return text.toLowerCase().replace(/[\s ]+/g, " ").trim();
}

/**
 * Whether `claim` quotes `line`; an ellipsis may stand for skipped words. A
 * claim that does not quote the line is not about it and is ignored.
 */
function quotesLine(claim: string, line: string): boolean {
	const normalizedLine = normalizeForQuote(line);
	const parts = claim
		.split(/\.\.\.|…/)
		.map(normalizeForQuote)
		.map((part) => part.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim())
		.filter((part) => part.length > 0);
	return parts.length > 0 && parts.every((part) => normalizedLine.includes(part));
}

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > CHECK_TEXT_MAX_CHARS ? `${line.slice(0, CHECK_TEXT_MAX_CHARS - 1)}…` : line;
}

interface CheckMergesOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	candidates: readonly MergeCandidate[];
	listed: ReadonlyMap<string, Reflection>;
	reflectionsById?: ReadonlyMap<string, Reflection>;
	maxTokens: number;
	signal: AbortSignal;
	complete?: typeof completeSimple;
}

/**
 * Ask the worker model whether each proposed merge keeps what the original
 * reflections behind it say. Returns the issues found per candidate index, or
 * `undefined` when the check could not run: a failed check accepts the merges
 * as before rather than stalling the condenser. An abort still propagates.
 */
async function checkMerges(options: CheckMergesOptions): Promise<Map<number, MergeIssue[]> | undefined> {
	const { runtime, resolved, candidates, listed, signal } = options;
	const lineCost = (text: string) => estimateTextTokens(text) + 1;
	let remainingDirect = candidates.reduce(
		(total, candidate) => total + candidate.sources.reduce((sum, id) => sum + lineCost(listed.get(id)?.content ?? ""), 0),
		0,
	);
	let used = 0;
	const blocks = candidates.map((candidate, index) => {
		const sourceLines: string[] = [];
		for (const id of candidate.sources) {
			const source = listed.get(id);
			if (!source) continue;
			const direct = lineCost(source.content);
			remainingDirect -= direct;
			const originals = options.reflectionsById ? originalReflections(source, options.reflectionsById) : [];
			const originalsCost = originals.reduce((total, original) => total + lineCost(original.content), 0);
			if (originals.length > 0 && used + originalsCost + remainingDirect <= options.maxTokens) {
				for (const original of originals) sourceLines.push(`- ${original.content}`);
				used += originalsCost;
			} else {
				sourceLines.push(`- ${source.content}`);
				used += direct;
			}
		}
		return `MERGE ${index + 1}\nMerged line: ${candidate.content}\nSources (oldest first):\n${sourceLines.join("\n")}`;
	});
	const rawUser = `${blocks.join("\n\n")}\n\nCheck every merge above and report with report_merge_checks.`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	let verdicts: Map<number, MergeIssue[]> | undefined;
	const tool = {
		name: "report_merge_checks",
		description: "Report, for every merge shown, the claims of its merged line that its sources do not support.",
		parameters: CHECK_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			if (!Array.isArray(args.merges)) {
				return { text: "Invalid arguments: merges must be an array with one entry per merge.", isError: true };
			}
			const found = new Map<number, MergeIssue[]>();
			for (const entry of args.merges) {
				if (!entry || typeof entry !== "object") continue;
				const record = entry as Record<string, unknown>;
				const number = record.merge;
				if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > candidates.length) continue;
				const content = candidates[number - 1]!.content;
				const issues = found.get(number - 1) ?? [];
				for (const issue of Array.isArray(record.issues) ? record.issues : []) {
					if (!issue || typeof issue !== "object") continue;
					const { claim, problem } = issue as Record<string, unknown>;
					if (typeof claim !== "string" || typeof problem !== "string" || problem.trim().length === 0) continue;
					if (!quotesLine(claim, content)) continue;
					issues.push({ claim: clip(claim), problem: clip(problem) });
				}
				found.set(number - 1, issues);
			}
			verdicts = found;
			return { text: "Recorded." };
		},
	};
	try {
		const result = await runWorkerLoop({
			stage: "condenser-check",
			model: resolved.model,
			auth: resolved.auth,
			thinking: resolved.thinking,
			maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
			maxTurns: CONDENSER_CHECK_MAX_TURNS,
			system: MERGE_CHECKER_SYSTEM,
			user,
			tool,
			signal,
			sessionId: runtime.sessionId,
			beforeTurn: runtime.beforePass,
			complete: options.complete,
			onUsage: (usage) => runtime.debug.usage("condenser-check", resolved.label, usage),
			keepPartialOnError: () => true,
		});
		if (result.failed) runtime.debug.record("condenser", "check_failed", { error: result.errorMessage });
	} catch (error) {
		if (signal.aborted) throw error;
		runtime.debug.record("condenser", "check_failed", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
	if (!verdicts) runtime.debug.record("condenser", "check_unreported", { merges: candidates.length });
	return verdicts;
}

interface BoundedPool {
	text: string;
	listed: Reflection[];
	listedTokens: number;
	/** Tokens of listed merged lines (condensed before). */
	condensedTokens: number;
	omitted: number;
	/** Reflections shown read-only beside the batch. */
	contextCount: number;
	/** Tokens of the newest reflections kept out of the batch. */
	recentTokens: number;
}

interface BoundedPoolOptions {
	/** Token limit for listed lines. */
	maxTokens: number;
	/** Token limit for the read-only context lines. */
	contextTokens: number;
	/** Newest reflection tokens that are never listed. */
	recentTokens: number;
	/** Tokens the pool is over its target. */
	tokensOverTarget: number;
}

function poolLine(reflection: Reflection, protectedIds: ReadonlySet<string>): string {
	const markers = [
		...(reflection.condensedFromIds ? ["[condensed]"] : []),
		...(protectedIds.has(reflection.id) ? ["[protected]"] : []),
	];
	return markers.length > 0 ? `[${reflection.id}] ${markers.join(" ")} ${reflection.content}` : reflectionLine(reflection);
}

/**
 * List one batch of at most `maxTokens`, oldest first. The newest reflections
 * (up to `recentTokens`) are never listed: they are what the assistant learned
 * last and stay verbatim. Only reflections that were never condensed are
 * listed while any of them is left out: a merged line sits where its oldest
 * source was, and condensing it again right away would compound the loss of
 * every pass. Merged lines join the batch only once every never-condensed
 * reflection fits and those cannot supply the cut the pool needs, by tier,
 * lowest first and oldest first within a tier, so no line is distilled a
 * second time before every line of its tier had its turn. A line that does
 * not fit is skipped, not a stop marker. Only listed reflections can be merged
 * or retired; the newest of the others are shown without ids as read-only
 * context, so the model can see what a listed reflection is covered or
 * superseded by.
 */
function boundedPool(
	reflections: readonly Reflection[],
	protectedIds: ReadonlySet<string>,
	options: BoundedPoolOptions,
): BoundedPool {
	const lines = reflections.map((reflection) => poolLine(reflection, protectedIds));
	const costs = lines.map((line) => estimateTextTokens(line) + 1);
	const available = Math.max(0, options.maxTokens - estimateTextTokens(`${POOL_HEADER}\n`));
	const recent = new Set<number>();
	let recentUsed = 0;
	for (let i = reflections.length - 1; i >= 0; i--) {
		const cost = reflections[i]!.tokenCount;
		if (recentUsed + cost > options.recentTokens) break;
		recent.add(i);
		recentUsed += cost;
	}
	const chosen = new Set<number>();
	let used = 0;
	const pick = (order: readonly number[]) => {
		for (const i of order) {
			if (chosen.has(i) || used + costs[i]! > available) continue;
			chosen.add(i);
			used += costs[i]!;
		}
	};
	const raw: number[] = [];
	const condensed: number[] = [];
	reflections.forEach((reflection, index) => {
		if (!recent.has(index)) (reflection.condensedFromIds ? condensed : raw).push(index);
	});
	pick(raw);
	const rawTokens = Array.from(chosen).reduce((total, index) => total + reflections[index]!.tokenCount, 0);
	// Merged lines only fill the batch once every never-condensed reflection
	// is in it (otherwise a short merged line would slip into a leftover gap)
	// and those alone cannot supply the cut the pool needs.
	if (raw.every((index) => chosen.has(index)) && rawTokens * MAX_BATCH_CUT_SHARE < options.tokensOverTarget) {
		const tierOf = (index: number) => reflectionTier(reflections[index]!);
		pick([...condensed].sort((a, b) => tierOf(a) - tierOf(b) || a - b));
	}
	const indexes = Array.from(chosen).sort((a, b) => a - b);
	const omitted = reflections.length - indexes.length;
	const omittedNote =
		omitted > 0 ? `\n(${omitted} more reflection${omitted === 1 ? "" : "s"} not listed in this batch; later passes handle them.)` : "";
	const contextIndexes: number[] = [];
	const contextAvailable = Math.max(0, options.contextTokens - estimateTextTokens(`${CONTEXT_HEADER}\n`));
	let contextUsed = 0;
	for (let i = reflections.length - 1; i >= 0 && contextAvailable > 0; i--) {
		if (chosen.has(i)) continue;
		const cost = estimateTextTokens(`- ${reflections[i]!.content}`) + 1;
		if (contextUsed + cost > contextAvailable) continue;
		contextIndexes.push(i);
		contextUsed += cost;
	}
	contextIndexes.reverse();
	const contextText =
		contextIndexes.length > 0
			? `\n\n${CONTEXT_HEADER}\n${contextIndexes.map((index) => `- ${reflections[index]!.content}`).join("\n")}`
			: "";
	return {
		text: `${POOL_HEADER}\n${indexes.length > 0 ? indexes.map((index) => lines[index]!).join("\n") : "(none)"}${omittedNote}${contextText}`,
		listed: indexes.map((index) => reflections[index]!),
		listedTokens: indexes.reduce((total, index) => total + reflections[index]!.tokenCount, 0),
		condensedTokens: indexes.reduce(
			(total, index) => total + (reflections[index]!.condensedFromIds ? reflections[index]!.tokenCount : 0),
			0,
		),
		omitted,
		contextCount: contextIndexes.length,
		recentTokens: recentUsed,
	};
}

function protectedReflectionIds(reflections: readonly Reflection[], observations: readonly Observation[]): Set<string> {
	const critical = new Set(
		observations.filter((observation) => observation.relevance === "critical").map((observation) => observation.id),
	);
	const ids = new Set<string>();
	if (critical.size === 0) return ids;
	for (const reflection of reflections) {
		if (reflection.supportingObservationIds.some((id) => critical.has(id))) ids.add(reflection.id);
	}
	return ids;
}

/**
 * Identifier-like names a merged line may only take from its sources: file
 * paths and file names with an extension, commit hashes, camelCase,
 * PascalCase and snake_case names. camelCase and PascalCase names must match
 * their sources' case (`CreateTask` is not `createTask`); the others match in
 * any case. Ticket and PR numbers are matched by their digits.
 */
const NAME_PATTERNS: readonly { pattern: RegExp; exactCase?: true }[] = [
	{ pattern: /[\w.~-]*\/[\w.~{}/-]*\.[A-Za-z]\w{0,5}\b/g },
	{ pattern: /\b[A-Za-z_][\w-]+\.(?:[a-z]{1,5}|[A-Z]{1,5})\b/g },
	{ pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g },
	{ pattern: /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, exactCase: true },
	{ pattern: /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g, exactCase: true },
	{ pattern: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g },
];
const TICKET_PATTERN = /(?:#|\b[A-Z][A-Z0-9]*-)(\d+)\b/g;
/** Numbers of five or more digits: an all-digit commit hash, an id, a size or a count. */
const LONG_NUMBER = /\b\d{5,}\b/g;
/** A merge subject that lists several subjects ("X and Y", "X, Y", "X; Y", "X & Y", "X plus Y"). */
const JOINED_SUBJECT = /\s(?:and|&|plus|\+)\s|[,;]\s/i;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A name is known when a source contains it. A slash-joined list of files
 * ("data.ts/handler.ts") is known when each file is named on its own.
 */
function knownName(name: string, haystack: string): boolean {
	if (haystack.includes(name)) return true;
	const files = name.split("/").filter((segment) => /\.[a-z]\w{0,5}$/.test(segment));
	return (
		files.length >= 2 &&
		files.length === name.split("/").length &&
		files.every((file) => new RegExp(`(?:^|[^\\w.-])${escapeRegExp(file)}`).test(haystack))
	);
}

/** Names and long numbers in `content` that appear in none of `sources`. */
export function namesMissingFromSources(content: string, sources: readonly string[]): string[] {
	const exact = sources.join("\n");
	const haystack = exact.toLowerCase();
	// "16,384" and "16_384" in a source support "16384" in the line.
	const numbers = new Set(haystack.replace(/(?<=\d)[,_](?=\d{3}\b)/g, "").match(/\d+/g) ?? []);
	const missing: string[] = [];
	// Paths come first, so a name inside a missing path is not reported again.
	const note = (name: string) => {
		if (!missing.some((reported) => reported.includes(name))) missing.push(name);
	};
	for (const { pattern, exactCase } of NAME_PATTERNS) {
		for (const match of content.matchAll(pattern)) {
			// Three-letter forms are units and acronyms (KiB, E2E), not names.
			if (match[0].length < 4) continue;
			if (exactCase ? knownName(match[0], exact) : knownName(match[0].toLowerCase(), haystack)) continue;
			note(match[0]);
		}
	}
	for (const match of content.matchAll(TICKET_PATTERN)) {
		if (!numbers.has(match[1]!)) note(match[0]);
	}
	for (const match of content.matchAll(LONG_NUMBER)) {
		if (!numbers.has(match[0])) note(match[0]);
	}
	return missing;
}

function uniqueStrings(values: readonly unknown[]): string[] | undefined {
	const result: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") return undefined;
		if (!result.includes(value)) result.push(value);
	}
	return result;
}

/**
 * Shrink an over-target reflection pool, one batch per call: merge
 * overlapping reflections into distilled lines and retire obsolete ones.
 * Model output supplies content and choices only; ids, support ids and token
 * counts are computed here, and every merged line must cut at least a tenth of
 * what it replaces and stay under its length cap. Reflections
 * backed by a critical observation may be merged but never retired. Retired
 * reflections stay in the session file and remain recallable.
 */
export async function runCondenser(options: RunCondenserOptions): Promise<CondenseResult | undefined> {
	const { runtime, resolved, reflections, observations, targetTokens, signal } = options;
	if (reflections.length === 0) return undefined;
	const metrics = reflectionPoolMetrics(reflections, targetTokens);
	if (metrics.tokensOverTarget <= 0) return undefined;

	const protectedIds = protectedReflectionIds(reflections, observations);
	const memoryTokens = resolveWorkerMemoryMaxTokens(runtime.config, resolved.model.contextWindow);
	const batchTokens = Math.min(runtime.condenserBatchTokens ?? CONDENSER_BATCH_MAX_TOKENS, memoryTokens);
	const context = boundedPool(reflections, protectedIds, {
		maxTokens: batchTokens,
		contextTokens: Math.min(CONDENSER_CONTEXT_MAX_TOKENS, memoryTokens - batchTokens),
		recentTokens: condenserRecentTokens(targetTokens),
		tokensOverTarget: metrics.tokensOverTarget,
	});
	if (context.listed.length === 0) return undefined;
	const poolIndex = new Map(reflections.map((reflection, index) => [reflection.id, index]));
	const listed = new Map(context.listed.map((reflection) => [reflection.id, reflection]));
	const existingIds = new Set(reflections.map((reflection) => reflection.id));
	const used = new Set<string>();
	const merged = new Map<string, Reflection>();
	let retiredWithoutReplacement = 0;
	// Run totals feed diagnostics; each tool result reports only its own call.
	let runRejected = 0;
	const mostlyCondensed = context.condensedTokens * 2 > context.listedTokens;
	// The newest reflections are never cut, so the rest carries the whole cut.
	const cutShare = Math.min(
		mostlyCondensed ? MAX_CONDENSED_BATCH_CUT_SHARE : MAX_BATCH_CUT_SHARE,
		metrics.tokensOverTarget / Math.max(1, metrics.reflectionTokens - context.recentTokens),
	);
	const cutTokens = Math.round(context.listedTokens * cutShare);
	let tokensCut = 0;
	const checkTokens = Math.min(CONDENSER_CHECK_MAX_TOKENS, memoryTokens);
	let checkedMerges = 0;
	let checkRejected = 0;

	const byPoolOrder = (a: string, b: string) => (poolIndex.get(a) ?? 0) - (poolIndex.get(b) ?? 0);

	/** Validate a proposed merge locally; `pending` holds ids of this call's earlier valid merges. */
	const proposeMerge = (
		raw: unknown,
		label: string,
		reasons: string[],
		pending: ReadonlySet<string>,
	): MergeCandidate | undefined => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			reasons.push(`${label}: not a merge object`);
			return undefined;
		}
		const record = raw as Record<string, unknown>;
		const replaces = Array.isArray(record.replaces) ? uniqueStrings(record.replaces) : undefined;
		if (!replaces || replaces.length === 0) {
			reasons.push(`${label}: replaces must list at least one reflection id`);
			return undefined;
		}
		for (const id of replaces) {
			if (!listed.has(id)) {
				reasons.push(`${label}: ${id} is not an id listed under REFLECTION POOL`);
				return undefined;
			}
			if (used.has(id) || pending.has(id)) {
				reasons.push(`${label}: ${id} is already used in this run`);
				return undefined;
			}
		}
		const subject = typeof record.subject === "string" ? record.subject.trim() : "";
		if (subject.length === 0 || subject.length > 80) {
			reasons.push(`${label}: subject must name, in a few words, the one subject the line covers`);
			return undefined;
		}
		if (JOINED_SUBJECT.test(subject)) {
			reasons.push(
				`${label}: subject "${subject}" joins more than one subject; give each subject its own merge, or leave its reflections as they are`,
			);
			return undefined;
		}
		const rawContent = typeof record.content === "string" ? normalizeRecordContentStrict(record.content) : undefined;
		const content = rawContent && runtime.config.redactSecrets ? redactText(rawContent) : rawContent;
		if (!content) {
			reasons.push(`${label}: content must be one non-empty line of plain prose`);
			return undefined;
		}
		if (isLowValueRecordContent(content)) {
			reasons.push(`${label}: content is empty filler`);
			return undefined;
		}
		const sources = [...replaces].sort(byPoolOrder);
		const missingNames = namesMissingFromSources(
			content,
			sources.map((id) => listed.get(id)?.content ?? ""),
		);
		if (missingNames.length > 0) {
			reasons.push(
				`${label}: names ${missingNames.slice(0, 3).join(", ")} that none of the reflections it replaces mention; a merged line may only use names from those reflections`,
			);
			return undefined;
		}
		const replacedTokens = sources.reduce((total, id) => total + (listed.get(id)?.tokenCount ?? 0), 0);
		const tokenCount = estimateTextTokens(content);
		const maxLineTokens = sources.some((id) => listed.get(id)?.condensedFromIds !== undefined)
			? CONDENSER_MAX_MERGED_CONDENSED_TOKENS
			: CONDENSER_MAX_MERGED_TOKENS;
		if (tokenCount > maxLineTokens) {
			reasons.push(
				`${label}: the merged line is ~${tokenCount} tokens; keep it under ~${maxLineTokens} tokens and split unrelated subjects into separate merges`,
			);
			return undefined;
		}
		const allowedTokens = Math.floor(replacedTokens * CONDENSER_MAX_MERGED_SHARE);
		if (tokenCount > allowedTokens) {
			reasons.push(
				`${label}: the merged line must cut at least a tenth of the reflections it replaces (~${tokenCount} tokens; at most ~${allowedTokens} for ~${replacedTokens} replaced)`,
			);
			return undefined;
		}
		return { content, sources, tokenCount, replacedTokens };
	};

	const commitMerge = (candidate: MergeCandidate): void => {
		const { content, sources, tokenCount, replacedTokens } = candidate;
		const supportingObservationIds: string[] = [];
		for (const id of sources) {
			for (const support of listed.get(id)?.supportingObservationIds ?? []) {
				if (!supportingObservationIds.includes(support)) supportingObservationIds.push(support);
			}
		}
		const id = hashMemoryId(content, "", supportingObservationIds, new Set([...existingIds, ...merged.keys()]));
		const tier = 1 + Math.max(...sources.map((source) => reflectionTier(listed.get(source)!)));
		merged.set(id, { id, content, supportingObservationIds, tokenCount, condensedFromIds: sources, tier });
		for (const source of sources) used.add(source);
		tokensCut += replacedTokens - tokenCount;
	};

	/** `inRejectedMerge` maps ids of this call's rejected merges to the merge's label. */
	const acceptRetire = (
		raw: unknown,
		label: string,
		reasons: string[],
		inRejectedMerge: ReadonlyMap<string, string>,
	): boolean => {
		if (typeof raw !== "string" || !listed.has(raw)) {
			reasons.push(`${label}: not an id listed under REFLECTION POOL`);
			return false;
		}
		if (used.has(raw)) {
			reasons.push(`${label}: ${raw} is already used in this run`);
			return false;
		}
		const rejectedMerge = inRejectedMerge.get(raw);
		if (rejectedMerge) {
			reasons.push(
				`${label}: ${raw} is part of ${rejectedMerge}, which was rejected; send that merge corrected instead of retiring its reflections`,
			);
			return false;
		}
		if (protectedIds.has(raw)) {
			reasons.push(`${label}: ${raw} is protected; it can be merged but never retired`);
			return false;
		}
		if (retiredWithoutReplacement >= metrics.maxRetiresAllowed) {
			reasons.push(`${label}: the hard maximum of ${metrics.maxRetiresAllowed} retirements is reached`);
			return false;
		}
		used.add(raw);
		retiredWithoutReplacement++;
		tokensCut += listed.get(raw)?.tokenCount ?? 0;
		return true;
	};

	const tool = {
		name: "condense_reflections",
		description:
			"Merge listed reflections into shorter lines and retire obsolete ones. The retirement maximum is enforced locally; changing fewer reflections is fine.",
		parameters: CONDENSE_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const merges = args.merges ?? [];
			const retire = args.retire ?? [];
			if (!Array.isArray(merges) || !Array.isArray(retire)) {
				runRejected++;
				return {
					text: "Invalid arguments: merges must be an array of merge objects and retire an array of reflection ids. Nothing was changed.",
					isError: true,
				};
			}
			const reasons: string[] = [];
			const accepted: string[] = [];
			let mergesAccepted = 0;
			let retiresAccepted = 0;
			const pending = new Set<string>();
			const candidates: { label: string; candidate: MergeCandidate }[] = [];
			const inRejectedMerge = new Map<string, string>();
			const noteRejected = (ids: readonly unknown[], label: string) => {
				for (const id of ids) {
					if (typeof id === "string" && listed.has(id) && !used.has(id) && !pending.has(id) && !inRejectedMerge.has(id)) {
						inRejectedMerge.set(id, label);
					}
				}
			};
			merges.forEach((raw, index) => {
				const label = `merge #${index + 1}`;
				const candidate = proposeMerge(raw, label, reasons, pending);
				if (!candidate) {
					const replaces = (raw as { replaces?: unknown } | null)?.replaces;
					if (Array.isArray(replaces)) noteRejected(replaces, label);
					return;
				}
				for (const id of candidate.sources) pending.add(id);
				candidates.push({ label, candidate });
			});
			// Every locally valid merge is checked against its originals before any is kept.
			const verdicts =
				candidates.length > 0 && runtime.config.condenserCheck
					? await checkMerges({
							runtime,
							resolved,
							candidates: candidates.map(({ candidate }) => candidate),
							listed,
							...(options.reflectionsById ? { reflectionsById: options.reflectionsById } : {}),
							maxTokens: checkTokens,
							signal,
							complete: options.complete,
						})
					: undefined;
			candidates.forEach(({ label, candidate }, index) => {
				const issues = verdicts?.get(index) ?? [];
				if (issues.length > 0) {
					checkRejected++;
					reasons.push(
						`${label}: changes what the reflections behind it say (${issues
							.slice(0, 2)
							.map((issue) => `"${issue.claim}": ${issue.problem}`)
							.join("; ")}); fix the line from the reflections it replaces, give a separate subject its own merge, or leave them as they are`,
					);
					for (const id of candidate.sources) if (!inRejectedMerge.has(id)) inRejectedMerge.set(id, label);
					return;
				}
				commitMerge(candidate);
				mergesAccepted++;
				accepted.push(label);
			});
			if (candidates.length > 0) checkedMerges += candidates.length;
			// Merges first: a reflection both merged and retired keeps its meaning.
			retire.forEach((raw, index) => {
				if (!acceptRetire(raw, `retire #${index + 1}`, reasons, inRejectedMerge)) return;
				retiresAccepted++;
				accepted.push(`retire #${index + 1}`);
			});
			runRejected += reasons.length;
			const nothingAccepted = mergesAccepted + retiresAccepted === 0;
			const targetReached = tokensCut >= cutTokens;
			return {
				text:
					`Accepted ${mergesAccepted} merge${mergesAccepted === 1 ? "" : "s"} and ${retiresAccepted} retirement${retiresAccepted === 1 ? "" : "s"}` +
					(accepted.length > 0 ? ` (${accepted.join(", ")})` : "") +
					(reasons.length > 0 ? `; ${reasons.length} rejected: ${formatRejections(reasons)}` : "") +
					`. Accepted changes are final: never send them again.` +
					(reasons.length > 0 ? " Send only corrected versions of the rejected items, or stop." : "") +
					` Cut so far this run: ~${tokensCut.toLocaleString()} of ~${cutTokens.toLocaleString()} tokens` +
					(targetReached ? " (target reached: stop unless something listed is clearly obsolete)" : "") +
					`; retirements ${retiredWithoutReplacement}/${metrics.maxRetiresAllowed}.`,
				details: { mergesAccepted, retiresAccepted, rejected: reasons.length, changed: used.size },
				...(nothingAccepted ? { isError: true } : {}),
			};
		},
	};

	const rawUser = `${context.text}

Pool: ~${metrics.reflectionTokens.toLocaleString()} tokens; target: ~${metrics.targetTokens.toLocaleString()}; over target by ~${metrics.tokensOverTarget.toLocaleString()}.
This batch: ~${context.listedTokens.toLocaleString()} tokens; aim to cut it by about ${Math.round(cutShare * 100)}% (~${cutTokens.toLocaleString()} tokens) through merges and retirements.
Hard maximum retirements this run: ${metrics.maxRetiresAllowed}. Merges are not limited, but each merged line must cut at least a tenth of what it replaces (aim for about half). Only ids listed under REFLECTION POOL are valid; use each id at most once.`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	const result = await runWorkerLoop({
		stage: "condenser",
		model: resolved.model,
		auth: resolved.auth,
		thinking: resolved.thinking,
		maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
		maxTurns: Math.min(runtime.config.agentMaxTurns, CONDENSER_MAX_TURNS),
		system: CONDENSER_SYSTEM,
		user,
		tool,
		signal,
		sessionId: runtime.sessionId,
		beforeTurn: runtime.beforePass,
		complete: options.complete,
		onUsage: (usage) => runtime.debug.usage("condenser", resolved.label, usage),
		// A later turn failing must not discard changes already validated.
		keepPartialOnError: () => used.size > 0,
	});
	if (result.failed) {
		runtime.debug.record("condenser", "partial_after_error", { turns: result.turns, error: result.errorMessage });
	}
	if (result.truncated && used.size === 0) {
		throw new Error("condenser reply hit its output token limit before proposing any change");
	}
	if (checkedMerges > 0) runtime.debug.record("condenser", "checked", { merges: checkedMerges, rejected: checkRejected });
	if (used.size === 0) {
		runtime.debug.record("condenser", "empty", { toolCalls: result.toolCallCount, rejected: runRejected });
		return undefined;
	}
	const firstSource = (reflection: Reflection) => poolIndex.get(reflection.condensedFromIds?.[0] ?? "") ?? 0;
	const replacements = Array.from(merged.values()).sort((a, b) => firstSource(a) - firstSource(b));
	const retiredReflectionIds = Array.from(used).sort(byPoolOrder);
	const retiredTokens = retiredReflectionIds.reduce((total, id) => total + (listed.get(id)?.tokenCount ?? 0), 0);
	runtime.debug.record("condenser", "recorded", {
		merged: replacements.length,
		retired: retiredReflectionIds.length,
		obsolete: retiredWithoutReplacement,
		tokensBefore: metrics.reflectionTokens,
		tokensAfter: metrics.reflectionTokens - retiredTokens + replacements.reduce((total, reflection) => total + reflection.tokenCount, 0),
		turns: result.turns,
	});
	return { reflections: replacements, retiredReflectionIds };
}

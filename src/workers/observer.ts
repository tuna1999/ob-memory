import { completeSimple, type TJsonSchema } from "@oh-my-pi/pi-ai";
import { OBSERVATION_TIMESTAMP_PATTERN } from "../constants";
import { hashMemoryId, normalizeRecordContent } from "../util/ids";
import { formatLocalTimestamp } from "../util/time";
import { observationLineTokens, type Observation, type Reflection } from "../ledger/types";
import { isLowValueRecordContent } from "../ledger/quality";
import { renderMemory } from "../ledger/render";
import { redactText } from "../security/redact";
import type { SessionRuntime } from "../runtime";
import { formatRejections, runWorkerLoop, type WorkerToolResult } from "./loop";
import type { ResolvedWorkerModel } from "./model";
import { OBSERVER_SYSTEM } from "./prompts";
import { resolveWorkerMemoryMaxTokens } from "../config";

const OBSERVATIONS_SCHEMA: TJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["observations"],
	properties: {
		observations: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["timestamp", "content", "relevance", "sourceEntryIds"],
				properties: {
					timestamp: {
						type: "string",
						pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$",
						description: "Observation time in local YYYY-MM-DD HH:MM format.",
					},
					content: {
						type: "string",
						minLength: 1,
						description: "One line of plain prose. No markdown, timestamp, or relevance field.",
					},
					relevance: { type: "string", enum: ["low", "medium", "high", "critical"] },
					sourceEntryIds: {
						type: "array",
						minItems: 1,
						items: { type: "string", minLength: 1 },
						description: "Exact source entry ids from the chunk that support this observation.",
					},
				},
			},
		},
	},
};

export interface RunObserverOptions {
	runtime: SessionRuntime;
	resolved: ResolvedWorkerModel;
	reflections: readonly Reflection[];
	observations: readonly Observation[];
	chunk: string;
	allowedSourceEntryIds: readonly string[];
	existingObservations?: readonly Observation[];
	signal: AbortSignal;
	complete?: typeof completeSimple;
	/**
	 * The worker did not finish the chunk: it hit maxTurns while still proposing
	 * tool calls, an output-length stop cut it off, or a later provider call
	 * failed after records were accepted. Coverage must then advance only as far
	 * as the accepted records cite.
	 */
	onExhausted?: () => void;
	/** Reports how the run ended, including runs that accept nothing. */
	onOutcome?: (outcome: ObserverRunOutcome) => void;
}

export interface ObserverRunOutcome {
	accepted: number;
	rejected: number;
	duplicates: number;
	/** Tool results returned as errors (malformed, truncated, or unknown calls). */
	toolErrors: number;
	exhausted: boolean;
	truncated: boolean;
	/** A later provider call failed and the run kept earlier accepted records. */
	failed: boolean;
	/**
	 * The model never called the tool and its reply is not a bare "nothing new"
	 * (see `isNothingNewReply`): it likely wrote observations as prose or tried
	 * to call the tool in text.
	 */
	proseReply?: boolean;
	/**
	 * The model stopped on its own: no output-length stop, no exhausted turn
	 * budget, no failure, nothing rejected, and either it used the tool or it
	 * answered with a bare "nothing new". A clean run that accepts nothing means
	 * the chunk holds nothing new.
	 */
	clean: boolean;
}

/**
 * Longest tool-less reply still read as "nothing new". The prompt asks for
 * exactly "Nothing new."; anything longer is treated as observations written
 * as prose, which must not be mistaken for an empty chunk. Length alone is
 * never enough: the reply must also say "nothing new" (see `isNothingNewReply`).
 */
export const NOTHING_NEW_REPLY_MAX_CHARS = 200;
/**
 * A line that looks like a record or a tool call written out instead of made:
 * the tool name or its argument names, tool-call tags, JSON, an observation
 * timestamp (date and time), a relevance tag, a list item, or an
 * "Observations:" heading. A bare date is not enough ("as of 2026-10-29").
 */
const RECORD_LIKE_LINE =
	/record_observations|sourceEntryIds|<\/?tool_call|\{\s*"|\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\b|\[(?:critical|high|medium|low)\]|^(?:[-*•]|\d+[.)])\s|^(?:new\s+)?observations?\s*:/i;
/**
 * The words of a "nothing new" verdict: "Nothing new", "Nothing noteworthy",
 * "No new observations", "Observations: none", "There is nothing new to
 * record", "The chunk contains nothing new", "All of this is already in
 * memory", with optional trailing qualifiers ("here", "to record", "in this
 * chunk", "as of 2026-10-29"). Only a whitelisted lead-in may precede it, so
 * a sentence about the conversation ("The user found no new information",
 * "the index is already in memory") is never a verdict.
 */
const NOTHING_NEW_WORDS =
	"(?:(?:there\\s+(?:is|was|are|were)|i\\s+(?:have|had|found|see)|(?:the|this)\\s+chunk\\s+(?:contains|has|adds|holds))\\s+)?" +
	"(?:nothing(?:\\s+(?:new|noteworthy|notable|relevant))?" +
	"|no\\s+(?:(?:new|additional|further)\\s+)?(?:observations?|information|facts|details)" +
	"|(?:new\\s+)?observations?\\s*:\\s*(?:none|nothing(?:\\s+new)?)" +
	"|(?:(?:all\\s+of\\s+)?(?:this|it|everything)(?:\\s+here)?|(?:the|this)\\s+chunk)\\s+is\\s+already\\s+(?:(?:recorded|covered|captured)\\s+)?in\\s+(?:the\\s+)?memory)" +
	"(?:\\s+(?:here|else|needed|worth\\s+(?:record|add|not|keep)\\w*|to\\s+(?:record|add|observe|note|keep)|(?:in|from)\\s+(?:this|the)\\s+(?:chunk|source|conversation|entries)|as\\s+of\\s+[\\w:-]+))*";
/** Optional list marker and Markdown emphasis or quotes around a verdict. */
const VERDICT_OPEN = "^(?:(?:[-*\u2022]|\\d+[.)])\\s+)?[*_`\"']*";
const VERDICT_CLOSE = "[*_`\"']*";
/**
 * A whole line that is a verdict ("Nothing new.", "- **No new observations.**").
 * It is checked before the record markers, which it may otherwise trip.
 */
const NOTHING_NEW_VERDICT = new RegExp(`${VERDICT_OPEN}${NOTHING_NEW_WORDS}[.!]?${VERDICT_CLOSE}$`, "i");
/**
 * A verdict with its explanation on the same line ("Nothing new. Just small
 * talk.", "Nothing new - the user only said thanks."); group 1 is the
 * explanation.
 */
const NOTHING_NEW_VERDICT_WITH_REASON = new RegExp(
	`${VERDICT_OPEN}${NOTHING_NEW_WORDS}(?:[.!:;]|\\s+[-\u2013\u2014])${VERDICT_CLOSE}\\s+(\\S.*)$`,
	"i",
);
/**
 * A qualifier that turns an explanation into a carrier for a fact ("Except
 * that the user chose Postgres.", "But the deploy region changed.").
 */
const NOTHING_NEW_EXCEPTION =
	/\b(?:except|but|however|although|though|apart\s+from|aside\s+from|other\s+than|besides|only\s+that|still|now)\b/i;
/**
 * Words that say why nothing is new: the chunk repeats memory, is small talk,
 * or only acknowledges. An explanation must give such a reason; a plain
 * statement ("User chose Postgres 16.") is a fact, not an explanation.
 */
const NOTHING_NEW_RATIONALE =
	/\b(?:only|just|merely|already|repeat\w*|restate\w*|duplicate\w*|same|small\s+talk|chit-?chat|greeting\w*|thanks|thank\s+you|acknowledg\w*|routine|trivial|nothing|no\s+(?:new|durable|lasting))\b/i;

/** An explanation after a verdict: a reason why nothing is new, carrying no fact. */
function isVerdictExplanation(line: string): boolean {
	return (
		NOTHING_NEW_VERDICT.test(line) ||
		(NOTHING_NEW_RATIONALE.test(line) && !NOTHING_NEW_EXCEPTION.test(line) && !RECORD_LIKE_LINE.test(line))
	);
}

/**
 * Whether a reply made without any tool call is a bare "nothing new": short
 * (at most NOTHING_NEW_REPLY_MAX_CHARS after trimming) and non-empty, and a
 * verdict (NOTHING_NEW_VERDICT), optionally followed, on the same line or the
 * next ones, by a brief explanation of why nothing is new
 * (`isVerdictExplanation`). Any other reply, however short, holds facts
 * written as prose ("The user chose eu-west-1."). Without the tool the reply
 * is the only "nothing new" signal, so a model that answers with its
 * observations in prose, or with no visible text at all (a provider or
 * template that swallowed the call), must count as an unproductive attempt
 * instead of a clean empty run that would mark the chunk covered: a retried
 * chunk ends as a `retry_limit` span that compaction keeps, while a clean one
 * is summarized away. The check is a heuristic; it errs toward retrying.
 */
export function isNothingNewReply(text: string): boolean {
	const reply = text.trim();
	if (reply.length === 0 || reply.length > NOTHING_NEW_REPLY_MAX_CHARS) return false;
	const lines = reply
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const [first, ...rest] = lines;
	if (first === undefined) return false;
	if (!NOTHING_NEW_VERDICT.test(first)) {
		const reason = NOTHING_NEW_VERDICT_WITH_REASON.exec(first)?.[1];
		if (reason === undefined || !isVerdictExplanation(reason)) return false;
	}
	return rest.every(isVerdictExplanation);
}

interface RawObservation {
	timestamp?: unknown;
	content?: unknown;
	relevance?: unknown;
	sourceEntryIds?: unknown;
}

function isRawObservation(value: unknown): value is RawObservation {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceIds(value: unknown, allowed: readonly string[]): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const allowedSet = new Set(allowed);
	const order = new Map(allowed.map((id, index) => [id, index]));
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || !allowedSet.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function observationSignature(
	observation: Pick<Observation, "content" | "timestamp" | "sourceEntryIds">,
): string {
	return `${observation.content}\u0000${observation.timestamp}\u0000${observation.sourceEntryIds.join(",")}`;
}

function makeRecord(
	raw: RawObservation,
	allowedSourceIds: readonly string[],
	existingIds: ReadonlySet<string>,
	redact: boolean,
): { observation?: Observation; reason?: string } {
	if (typeof raw.timestamp !== "string" || !OBSERVATION_TIMESTAMP_PATTERN.test(raw.timestamp)) {
		return { reason: "invalid timestamp; use YYYY-MM-DD HH:MM" };
	}
	if (typeof raw.content !== "string" || !raw.content.trim()) return { reason: "empty content" };
	if (
		raw.relevance !== "low" &&
		raw.relevance !== "medium" &&
		raw.relevance !== "high" &&
		raw.relevance !== "critical"
	) {
		return { reason: "invalid relevance" };
	}
	const sourceEntryIds = normalizeSourceIds(raw.sourceEntryIds, allowedSourceIds);
	if (!sourceEntryIds) return { reason: "invalid sourceEntryIds; cite only ids shown in the chunk" };
	const normalized = normalizeRecordContent(raw.content);
	const content = redact ? redactText(normalized) : normalized;
	if (!content) return { reason: "empty content" };
	if (isLowValueRecordContent(content)) return { reason: "content is empty filler" };
	const id = hashMemoryId(content, raw.timestamp, sourceEntryIds, existingIds);
	return {
		observation: {
			id,
			content,
			timestamp: raw.timestamp,
			relevance: raw.relevance,
			sourceEntryIds,
			tokenCount: observationLineTokens({ id, content, timestamp: raw.timestamp, relevance: raw.relevance }),
		},
	};
}

/**
 * Distill one source chunk into observations. The model never controls ids or
 * token counts, and every proposal is validated against the exact source ids
 * that were sent in this chunk.
 */
export async function runObserver(options: RunObserverOptions): Promise<Observation[] | undefined> {
	const { runtime, resolved, reflections, observations, chunk, allowedSourceEntryIds, signal } = options;
	const priorMemory = renderMemory(reflections, observations, {
		maxTokens: resolveWorkerMemoryMaxTokens(runtime.config, resolved.model.contextWindow),
		estimate: runtime.estimator,
	}).text;
	const accepted = new Map<string, Observation>();
	const allExisting = [...observations, ...(options.existingObservations ?? [])];
	const existingIds = new Set(allExisting.map((observation) => observation.id));
	const seenSignatures = new Set(allExisting.map(observationSignature));
	const currentTime = formatLocalTimestamp();
	// Run totals feed diagnostics and the outcome; each tool result reports
	// only its own call so a later valid call is not blamed for earlier ones.
	let runRejected = 0;
	let runDuplicates = 0;

	const tool = {
		name: "record_observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk. Call again if content remains uncovered; stop calling and reply briefly when the chunk is covered.",
		parameters: OBSERVATIONS_SCHEMA,
		execute: async (args: Record<string, unknown>): Promise<WorkerToolResult> => {
			const rawList = args.observations;
			if (!Array.isArray(rawList)) {
				runRejected++;
				return {
					text: "Invalid arguments: observations must be an array of observation objects. Nothing was recorded.",
					isError: true,
				};
			}
			let added = 0;
			let rejected = 0;
			let duplicates = 0;
			const reasons: string[] = [];
			for (let index = 0; index < rawList.length; index++) {
				const raw: unknown = rawList[index];
				if (!isRawObservation(raw)) {
					rejected++;
					reasons.push(`#${index + 1}: not an observation object`);
					continue;
				}
				const result = makeRecord(
					raw,
					allowedSourceEntryIds,
					new Set([...existingIds, ...accepted.keys()]),
					runtime.config.redactSecrets,
				);
				if (!result.observation) {
					rejected++;
					reasons.push(`#${index + 1}: ${result.reason ?? "invalid fields"}`);
					continue;
				}
				const signature = observationSignature(result.observation);
				if (seenSignatures.has(signature)) {
					duplicates++;
					continue;
				}
				seenSignatures.add(signature);
				accepted.set(result.observation.id, result.observation);
				added++;
			}
			runRejected += rejected;
			runDuplicates += duplicates;
			const nothingAccepted = added === 0 && rejected > 0;
			return {
				text:
					`Recorded ${added} new observation${added === 1 ? "" : "s"}` +
					(duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "") +
					(rejected > 0 ? `; ${rejected} rejected: ${formatRejections(reasons)}` : "") +
					`. Total this run: ${accepted.size}.` +
					(nothingAccepted
						? " Fix the listed fields and call again, or stop if the chunk holds nothing new."
						: " Continue if content remains; otherwise reply briefly and stop."),
				details: { added, duplicates, rejected, total: accepted.size },
				...(nothingAccepted ? { isError: true } : {}),
			};
		},
	};

	const rawUser = `Current local time: ${currentTime}

CURRENT MEMORY:
${priorMemory || "(none yet)"}

NEW CONVERSATION CHUNK:
${chunk}`;
	const user = runtime.config.redactSecrets ? redactText(rawUser) : rawUser;

	const result = await runWorkerLoop({
		stage: "observer",
		model: resolved.model,
		auth: resolved.auth,
		thinking: resolved.thinking,
		maxTokens: Math.min(runtime.config.agentMaxTokens, resolved.maxTokens),
		maxTurns: runtime.config.agentMaxTurns,
		system: OBSERVER_SYSTEM,
		user,
		tool,
		signal,
		sessionId: runtime.sessionId,
		beforeTurn: runtime.beforePass,
		complete: options.complete,
		// Log each turn as it completes so failed or aborted runs still report cost.
		onUsage: (item) => runtime.debug.usage("observer", resolved.label, item),
		// A later turn failing must not discard records already accepted.
		keepPartialOnError: () => accepted.size > 0,
	});
	const failed = result.failed === true;
	if (result.exhausted || result.truncated || failed) {
		options.onExhausted?.();
		runtime.debug.record("observer", failed ? "partial_after_error" : "turn_budget_exhausted", {
			turns: result.turns,
			toolCalls: result.toolCallCount,
			exhausted: result.exhausted,
			truncated: result.truncated,
			...(failed ? { error: result.errorMessage } : {}),
		});
	}
	const values = Array.from(accepted.values());
	const toolErrors = result.records.filter((record) => record.isError === true).length;
	const proseReply = result.toolCallCount === 0 && !isNothingNewReply(result.finalText);
	options.onOutcome?.({
		accepted: values.length,
		rejected: runRejected,
		duplicates: runDuplicates,
		toolErrors,
		exhausted: result.exhausted,
		truncated: result.truncated,
		failed,
		proseReply,
		clean: !result.exhausted && !result.truncated && !failed && runRejected === 0 && toolErrors === 0 && !proseReply,
	});
	if (values.length === 0) {
		runtime.debug.record("observer", "empty", {
			toolCalls: result.toolCallCount,
			rejected: runRejected,
			duplicates: runDuplicates,
			toolErrors,
			...(proseReply ? { proseReply, replyChars: result.finalText.length } : {}),
		});
		return undefined;
	}
	runtime.debug.record("observer", "recorded", {
		count: values.length,
		tokens: values.reduce((total, observation) => total + observation.tokenCount, 0),
		turns: result.turns,
	});
	return values;
}

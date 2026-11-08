import { describe, expect, test } from "bun:test";
import {
	COMPACTION_RECOVERY_BAND,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	type AgentMessage,
} from "@oh-my-pi/pi-agent-core";
import { isTranscriptUsageAnchor } from "@oh-my-pi/pi-agent-core/compaction";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { handleSessionBeforeCompact } from "../src/hooks/compaction";
import { createContextTokenCounter, type CompactionReason } from "../src/hooks/cut";
import {
	compactionMinimumSummaryTokens,
	compactionRetainedBudget,
	hostRecoveryBandTokens,
	hostResidualCheck,
	hostRetryFitTokens,
	recordAutoCompactionStart,
	type HostCompactionSettings,
} from "../src/hooks/policy";
import type { LedgerEntry, MemoryDetails } from "../src/ledger/types";
import { ZERO_USAGE, makeHarness, messageEntry, observationEntry, observationRecord } from "./helpers";

describe("host recovery band", () => {
	const windows = [16_000, 32_000, 64_000, 128_000, 200_000, 1_000_000];
	const settingsCases: HostCompactionSettings[] = [
		{},
		{ thresholdPercent: -1, thresholdTokens: -1 },
		{ thresholdPercent: 50 },
		{ thresholdPercent: 150 },
		{ thresholdTokens: 50_000 },
		{ thresholdTokens: 2_000_000 },
		{ baseWindowTokens: 200_000 },
		{ baseWindowTokens: 200_000, thresholdPercent: 85 },
		{ reserveTokens: 8_000 },
		{ reserveTokens: 16_384 },
		{ reserveTokens: 50_000 },
	];

	test("matches the host's resolveThresholdTokens × COMPACTION_RECOVERY_BAND", () => {
		for (const window of windows) {
			for (const settings of settingsCases) {
				const host = Math.floor(
					resolveThresholdTokens(window, { enabled: true, keepRecentTokens: 20_000, ...settings }) *
						COMPACTION_RECOVERY_BAND,
				);
				expect({ window, settings, band: hostRecoveryBandTokens(window, settings) }).toEqual({
					window,
					settings,
					band: host,
				});
			}
		}
	});

	test("matches the host's retry fit budget (window less resolveBudgetReserveTokens)", () => {
		for (const window of windows) {
			for (const settings of settingsCases) {
				const host = Math.max(
					0,
					window - resolveBudgetReserveTokens(window, { enabled: true, keepRecentTokens: 20_000, ...settings }),
				);
				expect({ window, settings, fit: hostRetryFitTokens(window, settings) }).toEqual({ window, settings, fit: host });
			}
		}
	});

	test("checks the band only after threshold passes and the window fit only after retries", () => {
		expect(hostResidualCheck("threshold")).toBe("band");
		expect(hostResidualCheck("incomplete")).toBe("fit");
		expect(hostResidualCheck("overflow")).toBe("fit");
		expect(hostResidualCheck("idle")).toBeUndefined();
		expect(hostResidualCheck("manual")).toBeUndefined();
	});

	test("caps the retained budget by the band less fixed context, under the configured maximum", () => {
		const { runtime } = makeHarness({ compactionMaxRetainedTokens: 20_000 });
		// 128k window: 10% threshold is 12,800 and its band 10,240.
		expect(compactionRetainedBudget(runtime)).toBe(20_000);
		expect(compactionRetainedBudget(runtime, { settings: {} })).toBe(20_000);
		expect(compactionRetainedBudget(runtime, { settings: { thresholdPercent: 50 } })).toBe(20_000);
		expect(compactionRetainedBudget(runtime, { settings: { thresholdPercent: 10 } })).toBe(10_240);
		expect(compactionRetainedBudget(runtime, { settings: { thresholdPercent: 10 }, fixedContextTokens: 5_000 })).toBe(
			5_240,
		);
		expect(compactionRetainedBudget(runtime, { settings: { thresholdPercent: 10 }, fixedContextTokens: 20_000 })).toBe(0);
	});
});

describe("owned compaction respects the host recovery band", () => {
	/** Four ~7.5k-token gap entries (each under the 40k-char worker rendering cap). */
	function gapBranch(): LedgerEntry[] {
		const big = (id: string, role: "user" | "assistant") =>
			messageEntry(id, role, `${id}: ${"schema migration output line. ".repeat(1_000)}`);
		return [
			messageEntry("m1", "user", "Please use Postgres for this project."),
			messageEntry("m2", "assistant", "Understood."),
			observationEntry(
				"o1",
				[observationRecord("aaaaaaaaaaaa", ["m1"], "m2", "User chose Postgres for the project database.")],
				"m2",
			),
			big("m3", "user"),
			big("m4", "assistant"),
			big("m5", "user"),
			big("m6", "assistant"),
			messageEntry("m7", "user", "Keep this tail."),
		];
	}

	function event(
		entries: LedgerEntry[],
		settings: Record<string, unknown>,
		recentMessages: unknown[] = [],
	): SessionBeforeCompactEvent {
		return {
			type: "session_before_compact",
			branchEntries: entries,
			preparation: {
				firstKeptEntryId: "m7",
				tokensBefore: 40_000,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				recentMessages,
				isSplitTurn: false,
				fileOps: { read: new Set(), edited: new Set() },
				settings,
			},
			signal: new AbortController().signal,
		} as unknown as SessionBeforeCompactEvent;
	}

	function harness() {
		const harnessed = makeHarness({ compactionCatchUpMaxChunks: 0 });
		harnessed.entries.push(...gapBranch());
		return harnessed;
	}

	test("retains the tail under the default threshold", async () => {
		const { runtime, ctx, entries } = harness();
		const result = await handleSessionBeforeCompact(runtime, event([...entries], {}), ctx);
		expect(result?.compaction?.firstKeptEntryId).toBe("m2");
	});

	test("delegates when the tail would exceed a lower configured threshold's band", async () => {
		const { runtime, ctx, entries } = harness();
		// 128k window at 25%: threshold 32,000, band 25,600 < ~30k retained.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], { thresholdPercent: 25 }), ctx);
		expect(result).toBeUndefined();
		expect(runtime.lastCompactionOwned).toBe(false);
	});

	test("delegates when a per-model base window lowers the threshold", async () => {
		const { runtime, ctx, entries } = harness();
		// Base window 40k: threshold 34,000 (prompt budget), band 27,200.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], { baseWindowTokens: 40_000 }), ctx);
		expect(result).toBeUndefined();
	});

	test("subtracts the system prompt from the band", async () => {
		const { runtime, ctx, entries } = harness();
		const withPrompt = Object.assign(ctx, {
			getSystemPrompt: () => ["system prompt and tool docs ".repeat(8_600)],
		}) as ExtensionContext;
		// Band 87,040 less a ~60k-token system prompt leaves less than the tail.
		const result = await handleSessionBeforeCompact(runtime, event([...entries], {}), withPrompt);
		expect(result).toBeUndefined();
	});

	/**
	 * Host 18.13.3 `getContextUsage()` (session-stats.ts `#anchoredUsedTokens`):
	 * the newest settled assistant with usage anchors it, and its provider
	 * prompt tokens cover the fixed context plus every message before it, but
	 * not the anchor's own content; the messages after it are counted locally.
	 * Without an anchor it is fixed context plus every message.
	 */
	function hostContextUsage(
		messages: readonly unknown[],
		fixedTokens: number,
		count: (message: unknown) => number,
	): number {
		let total = fixedTokens;
		for (const message of messages) total += count(message);
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as AgentMessage;
			if (isTranscriptUsageAnchor(message)) return total - count(message);
		}
		return total;
	}

	/** A settled assistant turn whose provider usage can anchor host context usage. */
	function withUsage(entry: LedgerEntry): LedgerEntry {
		return {
			...entry,
			message: {
				...(entry.message as Record<string, unknown>),
				stopReason: "stop",
				usage: { ...ZERO_USAGE, input: 40_000, output: 8_000, totalTokens: 48_000 },
			},
		};
	}

	async function runWithUsage(
		branch: LedgerEntry[],
		fixedTokens: (counts: { retained: number; anchor: number; band: number }) => number,
	) {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0 });
		entries.push(...branch);
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const counter = createContextTokenCounter(runtime);
		const anchorMessage = messages.findLast((message) => isTranscriptUsageAnchor(message as AgentMessage));
		const counts = {
			// The unobserved tail retained from m2 (the safe cut before the gap).
			retained: entries.slice(1).reduce<number>((total, entry) => total + counter.entry(entry), 0),
			anchor: anchorMessage ? counter.message(anchorMessage) : 0,
			band: hostRecoveryBandTokens(128_000, {}),
		};
		const fixed = fixedTokens(counts);
		const usage = hostContextUsage(messages, fixed, (message) => counter.message(message));
		const withContextUsage = Object.assign(ctx, {
			getContextUsage: () => ({ tokens: usage, contextWindow: 128_000, percent: 0 }),
		}) as ExtensionContext;
		const result = await handleSessionBeforeCompact(runtime, event([...entries], {}, messages), withContextUsage);
		return { result, counts, fixed, summaryTokens: runtime.estimator(result?.compaction?.summary ?? "") };
	}

	test("derives fixed context from context usage beyond the prepared messages", async () => {
		// No usage anchor (no settled assistant reported usage): usage is fixed
		// context plus every message.
		expect((await runWithUsage(gapBranch(), () => 1_000)).result?.compaction?.firstKeptEntryId).toBe("m2");
		// ~60k of system prompt + tool schemas leaves no room for the ~30k tail.
		expect((await runWithUsage(gapBranch(), () => 60_000)).result).toBeUndefined();
	});

	test("does not subtract the usage-anchor assistant turn, which host usage never counted", async () => {
		const branch = () => {
			const entries = gapBranch();
			// A large final assistant answer is the host's usage anchor.
			entries.push(
				withUsage(messageEntry("m8", "assistant", `m8: ${"final report paragraph on the migration. ".repeat(800)}`)),
			);
			return entries;
		};
		// Messages counted in usage are not overhead.
		const small = await runWithUsage(branch(), () => 1_000);
		expect(small.counts.anchor).toBeGreaterThan(5_000);
		expect(small.result?.compaction?.firstKeptEntryId).toBe("m2");
		// True fixed context leaves less than the retained tail, but counting
		// the anchor as a usage message would hide half of the anchor's size.
		const tight = await runWithUsage(branch(), ({ retained, anchor, band }) => band - retained + Math.floor(anchor / 2));
		expect(tight.fixed + tight.counts.retained).toBeGreaterThan(tight.counts.band);
		expect(tight.result).toBeUndefined();
	});

	test("with little room, a retained-tail compaction owns only when the summary keeps every record about the compacted range", async () => {
		const withRecords = (sourceEntryId: string) => {
			const branch = gapBranch();
			const index = branch.findIndex((entry) => entry.id === "o1");
			branch[index] = observationEntry(
				"o1",
				[
					observationRecord("aaaaaaaaaaaa", ["m1"], "m2", "User chose Postgres for the project database."),
					...Array.from({ length: 100 }, (_, i) =>
						observationRecord(
							`b${i.toString(16).padStart(11, "0")}`,
							[sourceEntryId],
							"m2",
							`Discussed step ${i} of the database setup checklist.`,
						),
					),
				],
				"m2",
			);
			return branch;
		};
		// ~800 tokens of room, below the minimum summary. Records about m2 are
		// redundant with the retained tail (it starts at m2), so the summary
		// about the compacted m1 still fits whole.
		const redundant = await runWithUsage(withRecords("m2"), ({ retained, band }) => band - retained - 800);
		expect(redundant.result?.compaction?.firstKeptEntryId).toBe("m2");
		expect(redundant.result?.compaction?.summary).toContain("Postgres");
		expect(redundant.summaryTokens).toBeLessThanOrEqual(800);
		// The same room cannot hold the records about m1: native does better.
		const essential = await runWithUsage(withRecords("m1"), ({ retained, band }) => band - retained - 800);
		expect(essential.result).toBeUndefined();
	});

	test("an aborted final assistant turn does not anchor usage", async () => {
		const branch = gapBranch();
		const last = branch[branch.length - 2]!;
		branch[branch.length - 2] = {
			...withUsage(last),
			message: { ...(withUsage(last).message as Record<string, unknown>), stopReason: "aborted" },
		};
		// Host usage then counts every message, so fixed context is exact.
		const run = await runWithUsage(branch, ({ retained, band }) => band - retained + 1_000);
		expect(run.counts.anchor).toBe(0);
		expect(run.result).toBeUndefined();
	});
});

describe("owned compaction without a gap respects the host recovery band", () => {
	function hex(n: number): string {
		return n.toString(16).padStart(12, "0");
	}

	/** Eight turns and a ~10k-token ledger whose observer covers the whole branch. */
	function coveredBranch(): LedgerEntry[] {
		const entries: LedgerEntry[] = [];
		for (let i = 1; i <= 8; i++) {
			entries.push(
				messageEntry(
					`m${i}`,
					i % 2 ? "user" : "assistant",
					`Turn ${i}: ${"we refactored the billing module and ran the test suite. ".repeat(40)}`,
				),
			);
		}
		const records = Array.from({ length: 260 }, (_, i) =>
			observationRecord(
				hex(i + 1),
				["m1"],
				"m8",
				`User decided billing rule number ${i} applies to invoices over ${i * 10} dollars in region ${i % 7} with rounding mode ${i % 3}.`,
			),
		);
		entries.push(observationEntry("o1", records, "m8"));
		return entries;
	}

	function noGapEvent(entries: LedgerEntry[], settings: Record<string, unknown>, messages: unknown[]) {
		return {
			type: "session_before_compact",
			branchEntries: entries,
			preparation: {
				firstKeptEntryId: "m7",
				tokensBefore: 40_000,
				messagesToSummarize: messages.slice(0, 6),
				turnPrefixMessages: [],
				recentMessages: messages.slice(6),
				isSplitTurn: false,
				fileOps: { read: new Set(), edited: new Set() },
				settings,
			},
			signal: new AbortController().signal,
		} as unknown as SessionBeforeCompactEvent;
	}

	async function run(
		settings: Record<string, unknown>,
		fixedTokens: (band: number, kept: number) => number,
		reason: CompactionReason = "threshold",
	) {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0 });
		entries.push(...coveredBranch());
		if (reason !== "manual") {
			recordAutoCompactionStart(runtime, { type: "auto_compaction_start", reason, action: "context-full" });
		}
		const counter = createContextTokenCounter(runtime);
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const kept = entries
			.filter((entry) => entry.id === "m7" || entry.id === "m8")
			.reduce<number>((total, entry) => total + counter.entry(entry), 0);
		const band = hostRecoveryBandTokens(128_000, settings);
		const fixed = fixedTokens(band, kept);
		// Unanchored host usage: fixed context plus every message.
		const usage = messages.reduce<number>((total, message) => total + counter.message(message), fixed);
		const withUsage = Object.assign(ctx, {
			getContextUsage: () => ({ tokens: usage, contextWindow: 128_000, percent: 0 }),
		}) as ExtensionContext;
		const result = await handleSessionBeforeCompact(runtime, noGapEvent([...entries], settings, messages), withUsage);
		const summaryTokens = runtime.estimator(result?.compaction?.summary ?? "");
		const details = result?.compaction?.details as MemoryDetails | undefined;
		return { result, band, kept, fixed, summaryTokens, rendered: details?.observations.length ?? 0, runtime };
	}

	test("keeps the full summary when the band has room", async () => {
		const { result, rendered, summaryTokens, fixed, kept, band } = await run({}, () => 10_500);
		expect(result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(rendered).toBe(260);
		expect(fixed + kept + summaryTokens).toBeLessThanOrEqual(band);
	});

	test("shrinks a threshold compaction's summary to fit a low threshold's band", async () => {
		// 128k at 20%: threshold 25,600, band 20,480; the full ~10k summary
		// plus ~10.5k fixed context and the kept tail would exceed it.
		const { result, rendered, summaryTokens, fixed, kept, band, runtime } = await run(
			{ thresholdPercent: 20 },
			() => 10_500,
		);
		expect(result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(260);
		expect(summaryTokens).toBeGreaterThanOrEqual(compactionMinimumSummaryTokens(runtime));
		expect(fixed + kept + summaryTokens).toBeLessThanOrEqual(band);
	});

	test("manual and idle compactions keep the full summary: the host never checks their residual", async () => {
		for (const reason of ["manual", "idle"] as const) {
			const { result, rendered, fixed, kept, summaryTokens, band } = await run(
				{ thresholdPercent: 20 },
				() => 10_500,
				reason,
			);
			expect({ reason, kept: result?.compaction?.firstKeptEntryId, rendered }).toEqual({ reason, kept: "m7", rendered: 260 });
			expect(fixed + kept + summaryTokens).toBeGreaterThan(band);
		}
	});

	test("an incomplete-turn retry is held to the window fit, not the band", async () => {
		const settings = { thresholdPercent: 20 };
		const roomy = await run(settings, () => 10_500, "incomplete");
		expect(roomy.rendered).toBe(260);
		const fit = hostRetryFitTokens(128_000, settings);
		const tight = await run(settings, (_band, kept) => fit - kept - 5_000, "incomplete");
		expect(tight.result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(tight.rendered).toBeLessThan(260);
		expect(tight.fixed + tight.kept + tight.summaryTokens).toBeLessThanOrEqual(fit);
	});

	test("shrinks below the minimum instead of delegating: native would keep the same tail", async () => {
		const { result, runtime, summaryTokens, fixed, kept, band } = await run(
			{ thresholdPercent: 20 },
			(band, kept) => band - kept - 1_000,
		);
		expect(compactionMinimumSummaryTokens(runtime)).toBeGreaterThan(1_000);
		expect(result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(summaryTokens).toBeLessThanOrEqual(1_000);
		expect(fixed + kept + summaryTokens).toBeLessThanOrEqual(band);
	});

	test("owns with a fallback-sized summary when the host's kept tail already fills the band", async () => {
		// 128k with thresholdTokens 20k: band 16,000 < fixed context + kept tail.
		const { result, runtime, summaryTokens, fixed, kept, band, rendered } = await run({ thresholdTokens: 20_000 }, () => 15_000);
		expect(fixed + kept).toBeGreaterThan(band);
		expect(result?.compaction?.firstKeptEntryId).toBe("m7");
		expect(rendered).toBeGreaterThan(0);
		expect(summaryTokens).toBeLessThanOrEqual(compactionMinimumSummaryTokens(runtime));
	});

	test("a shrunk summary keeps the records about the compacted range before those about the kept tail", async () => {
		const { runtime, ctx, entries } = makeHarness({ compactionCatchUpMaxChunks: 0 });
		entries.push(...coveredBranch().filter((entry) => entry.type === "message"));
		// The observer is past the host's cut: half the records describe m1..m6,
		// which leave context, half describe m7..m8, which stay verbatim.
		entries.push(
			observationEntry(
				"o1",
				Array.from({ length: 150 }, (_, i) =>
					observationRecord(hex(i + 1), [`m${(i % 6) + 1}`], "m6", `OLD fact ${i}: invoices over ${i * 10} dollars round in mode ${i % 3}.`),
				),
				"m6",
			),
			observationEntry(
				"o2",
				Array.from({ length: 150 }, (_, i) =>
					observationRecord(hex(i + 1_001), [i % 2 ? "m7" : "m8"], "m8", `KEPT fact ${i}: test run ${i} passed on shard ${i % 5}.`),
				),
				"m8",
			),
		);
		recordAutoCompactionStart(runtime, { type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		const counter = createContextTokenCounter(runtime);
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const kept = entries
			.filter((entry) => entry.id === "m7" || entry.id === "m8")
			.reduce<number>((total, entry) => total + counter.entry(entry), 0);
		const settings = { thresholdPercent: 20 };
		const room = (fixed: number) => hostRecoveryBandTokens(128_000, settings) - kept - fixed;
		const contents = async (fixed: number) => {
			const usage = messages.reduce<number>((total, message) => total + counter.message(message), fixed);
			const withUsage = Object.assign(ctx, {
				getContextUsage: () => ({ tokens: usage, contextWindow: 128_000, percent: 0 }),
			}) as ExtensionContext;
			const result = await handleSessionBeforeCompact(runtime, noGapEvent([...entries], settings, messages), withUsage);
			expect(runtime.estimator(result?.compaction?.summary ?? "")).toBeLessThanOrEqual(room(fixed));
			return ((result?.compaction?.details as MemoryDetails | undefined)?.observations ?? []).map((o) => o.content);
		};
		// ~4k of room: only records about the compacted range.
		const tight = await contents(hostRecoveryBandTokens(128_000, settings) - kept - 4_000);
		expect(tight.length).toBeGreaterThan(50);
		expect(tight.every((content) => content.startsWith("OLD"))).toBe(true);
		// ~6.5k of room: every record about the compacted range, then the newest kept-tail records.
		const roomier = await contents(hostRecoveryBandTokens(128_000, settings) - kept - 6_500);
		const old = roomier.filter((content) => content.startsWith("OLD"));
		const recent = roomier.filter((content) => content.startsWith("KEPT"));
		expect(old.length).toBe(150);
		expect(recent.length).toBeGreaterThan(0);
		expect(recent.length).toBeLessThan(150);
		expect(recent[recent.length - 1]).toStartWith("KEPT fact 149:");
		// Chronological order is kept.
		expect(roomier.indexOf(old[old.length - 1]!)).toBeLessThan(roomier.indexOf(recent[0]!));
	});
});

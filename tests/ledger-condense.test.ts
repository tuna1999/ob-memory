import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "../src/constants";
import { compactionProjection, foldLedger, fullProjection, visibleProjection } from "../src/ledger/fold";
import { recallMemory } from "../src/ledger/recall";
import { isReflection, isReflectionsCondensedData, reflectionTier, type LedgerEntry, type Observation, type Reflection } from "../src/ledger/types";
import { messageEntry } from "./helpers";

const CONDENSED = "ob-memory.reflections.condensed";

function obs(id: string, sourceId: string, content = `User decided detail ${id} about the storage layer.`): Observation {
	return { id, content, timestamp: "2026-10-29 10:00", relevance: "high", sourceEntryIds: [sourceId], tokenCount: estimateTextTokens(content) };
}

function refl(id: string, content: string, support: string[], condensedFromIds?: string[]): Reflection {
	return {
		id,
		content,
		supportingObservationIds: support,
		tokenCount: estimateTextTokens(content),
		...(condensedFromIds ? { condensedFromIds } : {}),
	};
}

function recorded(id: string, observations: Observation[], coversUpToId: string): LedgerEntry {
	return { type: "custom", id, customType: "ob-memory.observations.recorded", data: { observations, coversUpToId } };
}

function reflected(id: string, reflections: Reflection[], coversUpToId: string): LedgerEntry {
	return { type: "custom", id, customType: "ob-memory.reflections.recorded", data: { reflections, coversUpToId } };
}

function condensed(id: string, reflections: Reflection[], retiredReflectionIds: string[], coversUpToId: string): LedgerEntry {
	return { type: "custom", id, customType: CONDENSED, data: { reflections, retiredReflectionIds, coversUpToId } };
}

const O1 = "a00000000001";
const O2 = "a00000000002";
const O3 = "a00000000003";
const R1 = "b00000000001";
const R2 = "b00000000002";
const R3 = "b00000000003";
const R4 = "b00000000004";
const M1 = "c00000000001";

/** m1..m3 observed, reflections R1..R3 recorded, then R4 later. */
function baseLedger(): LedgerEntry[] {
	return [
		messageEntry("m1", "user", "Use Postgres 16 for the ledger."),
		messageEntry("m2", "user", "The schedule timezone field moves to the combobox."),
		messageEntry("m3", "user", "The timezone field now uses the combobox."),
		recorded("o1", [obs(O1, "m1"), obs(O2, "m2"), obs(O3, "m3")], "m3"),
		reflected("r1", [
			refl(R1, "The ledger store is Postgres 16, chosen for its JSONB support.", [O1]),
			refl(R2, "The schedule editor timezone field is being replaced by the Base UI combobox.", [O2]),
			refl(R3, "WIP was parked in /tmp/hotpath-wip.patch because git stash is blocked.", [O3]),
		], "m3"),
		messageEntry("m4", "user", "Next task."),
		reflected("r2", [refl(R4, "The user wants every schedule change covered by an e2e test.", [O3])], "m3"),
	];
}

const MERGED = refl(M1, "The schedule editor timezone field is the Base UI combobox.", [O2, O3], [R2]);

describe("reflection condense records", () => {
	test("validates that every merged reflection names only retired sources", () => {
		expect(isReflectionsCondensedData({ reflections: [MERGED], retiredReflectionIds: [R2, R3], coversUpToId: "m3" })).toBe(true);
		expect(isReflectionsCondensedData({ reflections: [], retiredReflectionIds: [R3], coversUpToId: "m3" })).toBe(true);
		expect(isReflectionsCondensedData({ reflections: [MERGED], retiredReflectionIds: [R3], coversUpToId: "m3" })).toBe(false);
		expect(isReflectionsCondensedData({ reflections: [refl(M1, "x".repeat(20), [O2])], retiredReflectionIds: [R2], coversUpToId: "m3" })).toBe(false);
		expect(isReflectionsCondensedData({ reflections: [], retiredReflectionIds: [], coversUpToId: "m3" })).toBe(false);
		expect(isReflectionsCondensedData({ reflections: [], retiredReflectionIds: ["not-an-id"], coversUpToId: "m3" })).toBe(false);
	});

	test("accepts a positive integer tier and treats a condensed record without one as tier 1", () => {
		expect(isReflection({ ...MERGED, tier: 2 })).toBe(true);
		expect(isReflection({ ...MERGED, tier: 0 })).toBe(false);
		expect(isReflection({ ...MERGED, tier: 1.5 })).toBe(false);
		expect(reflectionTier(MERGED)).toBe(1);
		expect(reflectionTier({ ...MERGED, tier: 3 })).toBe(3);
		expect(reflectionTier(refl(R1, "Raw reflection.", [O1]))).toBe(0);
	});

	test("fold hides retired reflections and places a merged one where its oldest source was", () => {
		const entries = [...baseLedger(), condensed("c1", [MERGED], [R2, R3], "m3")];
		const fold = foldLedger(entries);
		expect(fold.reflections.map((reflection) => reflection.id)).toEqual([R1, M1, R4]);
		expect(Array.from(fold.retiredReflectionIds).sort()).toEqual([R2, R3]);
		expect(fullProjection(entries).reflections.map((reflection) => reflection.id)).toEqual([R1, M1, R4]);
		expect(visibleProjection(entries).reflections.map((reflection) => reflection.id)).toEqual([R1, M1, R4]);
	});

	test("a merged reflection can itself be condensed again", () => {
		const second = refl("c00000000002", "Schedule edits use the Base UI combobox and need e2e coverage.", [O2, O3], [M1, R4]);
		const entries = [
			...baseLedger(),
			condensed("c1", [MERGED], [R2, R3], "m3"),
			condensed("c2", [second], [M1, R4], "m3"),
		];
		expect(foldLedger(entries).reflections.map((reflection) => reflection.id)).toEqual([R1, second.id]);
	});

	test("an invalid condense record changes nothing", () => {
		const entries = [...baseLedger(), condensed("c1", [MERGED], [R3], "m3")];
		expect(foldLedger(entries).reflections.map((reflection) => reflection.id)).toEqual([R1, R2, R3, R4]);
	});

	test("compaction applies a condense record written after the cut, so merged memory is not lost", () => {
		const entries = [...baseLedger(), messageEntry("m5", "user", "Later work."), condensed("c1", [MERGED], [R2, R3], "m5")];
		const projection = compactionProjection(entries, "m4");
		expect(projection.reflections.map((reflection) => reflection.id)).toEqual([R1, M1, R4]);
		expect(projection.details.reflections.map((reflection) => reflection.id)).toEqual([R1, M1, R4]);
	});

	test("after /clear, merged reflections from before the boundary are cleared and their retirements still hold", () => {
		const entries = [
			...baseLedger(),
			condensed("c1", [MERGED], [R2, R3], "m3"),
			{ type: "reset_boundary", id: "reset", timestamp: "2026-10-29T10:30:00.000Z" } satisfies LedgerEntry,
		];
		const fold = foldLedger(entries);
		expect(fold.reflections).toEqual([]);
		expect(fold.retiredReflectionIds.has(R2)).toBe(true);
	});

	test("recall reports a retired reflection and where it was merged", () => {
		const entries = [...baseLedger(), condensed("c1", [MERGED], [R2, R3], "m3")];
		const retired = recallMemory(entries, R2, { redact: false });
		expect(retired.found).toBe(true);
		expect(retired.text).toContain(`Reflection [${R2}] [retired, merged into ${M1}]`);
		const obsolete = recallMemory(entries, R3, { redact: false });
		expect(obsolete.text).toContain(`Reflection [${R3}] [retired]`);
		const merged = recallMemory(entries, M1, { redact: false });
		expect(merged.found).toBe(true);
		expect(merged.text).toContain(`Reflection [${M1}] [active] ${MERGED.content}`);
		expect(merged.text).toContain(`condensed from: ${R2}`);
		expect(merged.observationIds.sort()).toEqual([O2, O3]);
	});
});

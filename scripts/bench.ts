import { performance } from "node:perf_hooks";
import { estimateTextTokens } from "../src/constants";
import { compactionProjection, foldLedger, fullProjection } from "../src/ledger/fold";
import { renderMemory } from "../src/ledger/render";
import { chunkUnobservedEntries } from "../src/ledger/serialize";
import type { LedgerEntry, Observation } from "../src/ledger/types";

const ENTRY_COUNT = 10_000;
const COMPACTIONS = 100;

function observation(index: number): Observation {
	const content = `Observation ${index}: user preference, file path src/module-${index}.ts, decision and completion marker.`;
	return {
		id: index.toString(16).padStart(12, "0").slice(-12),
		content,
		timestamp: "2026-10-29 10:00",
		relevance: index % 17 === 0 ? "critical" : index % 5 === 0 ? "high" : "medium",
		sourceEntryIds: [`s${index.toString(16).padStart(8, "0")}`],
		tokenCount: estimateTextTokens(content),
	};
}

function buildEntries(): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	for (let i = 0; i < ENTRY_COUNT; i++) {
		if (i % 10 === 0) {
			const obs = observation(i);
			entries.push({
				type: "custom",
				id: `r${i.toString(16).padStart(8, "0")}`,
				customType: "ob-memory.observations.recorded",
				timestamp: "2026-10-29T10:00:00Z",
				data: { observations: [obs], coversUpToId: `m${(i - 1).toString(16).padStart(8, "0")}` },
			});
		} else {
			entries.push({
				type: "message",
				id: `m${i.toString(16).padStart(8, "0")}`,
				timestamp: "2026-10-29T10:00:00Z",
				message: {
					role: i % 2 === 0 ? "user" : "assistant",
					content: [{ type: "text", text: `Message ${i} with source content for the memory ledger benchmark.` }],
					timestamp: Date.parse("2026-10-29T10:00:00Z"),
				},
			});
		}
	}
	return entries;
}

function time(label: string, iterations: number, run: () => void): number {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) run();
	const elapsed = performance.now() - start;
	console.log(`${label.padEnd(38)} ${(elapsed / iterations).toFixed(3)} ms/op (${iterations} ops)`);
	return elapsed;
}

const entries = buildEntries();
console.log(`entries=${entries.length} compactions=${COMPACTIONS}`);
time("foldLedger (tip)", 10, () => void foldLedger(entries));
time("fullProjection (tip)", 10, () => void fullProjection(entries));
const fold = foldLedger(entries);
time("renderMemory (all records)", 10, () =>
	void renderMemory(fold.reflections, fold.activeObservations, { maxTokens: 8_000 }),
);
time("renderMemory (4k budget)", 10, () =>
	void renderMemory(fold.reflections, fold.activeObservations, { maxTokens: 4_000 }),
);
time("chunkUnobserved (12k budget)", 10, () =>
	void chunkUnobservedEntries(entries, undefined, 12_000),
);
time(`compactionProjection x${COMPACTIONS}`, COMPACTIONS, () =>
	void compactionProjection(entries, entries[Math.floor(entries.length * 0.9)]!.id),
);
console.log(`active observations=${fold.activeObservations.length} reflections=${fold.reflections.length}`);

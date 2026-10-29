import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "../src/constants";
import { observationLineTokens, type Observation } from "../src/ledger/types";
import { serializeSourceEntries } from "../src/ledger/serialize";
import { runObserver } from "../src/workers/observer";
import { makeAssistant, makeHarness, makeModel, makeToolCall, scriptedComplete, text } from "./helpers";

const FIXTURES = ["coding-session.md", "tool-heavy.md"] as const;

describe("transcript fixtures", () => {
	for (const fixture of FIXTURES) {
		test(`observes ${fixture} with source provenance`, async () => {
			const chunk = readFileSync(join(import.meta.dir, "fixtures", "transcripts", fixture), "utf8");
			const sourceIds = Array.from(chunk.matchAll(/\[Source entry id: ([^\]]+)\]/g), (match) => match[1]!);
			expect(sourceIds.length).toBeGreaterThan(0);
			const content = fixture === "coding-session.md"
				? "User requires pnpm and Postgres for the project."
				: "The auth test fails with TS2322 at src/auth.ts:47.";
			const observation: Observation = {
				id: "aaaaaaaaaaaa",
				content,
				timestamp: "2026-10-29 10:00",
				relevance: "high",
				sourceEntryIds: [sourceIds[0]!],
				tokenCount: observationLineTokens({ id: "aaaaaaaaaaaa", content, timestamp: "2026-10-29 10:00", relevance: "high" }),
			};
			const { runtime } = makeHarness({ redactSecrets: false });
			const call = makeAssistant(
				[
					makeToolCall("record_observations", {
						observations: [
							{
								timestamp: observation.timestamp,
								content: observation.content,
								relevance: observation.relevance,
								sourceEntryIds: observation.sourceEntryIds,
							},
						],
					}),
				],
				"toolUse",
			);
			const records = await runObserver({
				runtime,
				resolved: {
					model: makeModel(),
					auth: { apiKey: "test" },
					thinking: "low",
					maxTokens: 1024,
					label: "test/test-model",
					fallbackUsed: false,
				},
				reflections: [],
				observations: [],
				chunk,
				allowedSourceEntryIds: sourceIds,
				signal: new AbortController().signal,
				complete: scriptedComplete([call, makeAssistant([text("done")])]),
			});
			expect(records?.[0]?.content).toBe(content);
			expect(records?.[0]?.sourceEntryIds).toEqual([sourceIds[0]!]);
		});
	}

	test("source serialization labels fixture entries", () => {
		const chunk = readFileSync(join(import.meta.dir, "fixtures", "transcripts", "coding-session.md"), "utf8");
		const entries = Array.from(chunk.matchAll(/\[Source entry id: ([^\]]+)\]/g), (match, index) => ({
			type: "message",
			id: match[1]!,
			message: {
				role: index % 2 === 0 ? "user" : "assistant",
				content: [{ type: "text", text: `fixture block ${index}` }],
				timestamp: Date.now(),
			},
		}));
		const serialized = serializeSourceEntries(entries);
		for (const entry of entries) expect(serialized.text).toContain(`[Source entry id: ${entry.id}]`);
		expect(estimateTextTokens(serialized.text)).toBeGreaterThan(0);
	});
});

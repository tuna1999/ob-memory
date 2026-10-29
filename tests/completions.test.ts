import { describe, expect, test } from "bun:test";
import { getMemoryCommandCompletions, MEMORY_SUBCOMMANDS } from "../src/commands/completions";

describe("/ob-memory argument completions", () => {
	test("lists every subcommand on an empty prefix", () => {
		const items = getMemoryCommandCompletions("");
		expect(items?.map((item) => item.label)).toEqual(MEMORY_SUBCOMMANDS.map((sub) => sub.name));
		expect(items?.[0]?.value).toBe("view ");
	});

	test("filters by prefix case-insensitively", () => {
		expect(getMemoryCommandCompletions("ST")?.map((item) => item.label)).toEqual(["status"]);
	});

	test("stops after the levels the command understands", () => {
		expect(getMemoryCommandCompletions("status now")).toBeNull();
		expect(getMemoryCommandCompletions("nope ")).toBeNull();
		expect(getMemoryCommandCompletions("nope")).toBeNull();
	});

	test("offers view full only once a tail prefix is typed", () => {
		expect(getMemoryCommandCompletions("view ")).toBeNull();
		const items = getMemoryCommandCompletions("view f");
		expect(items?.map((item) => item.label)).toEqual(["full"]);
		// The editor replaces the whole argument text, so the value keeps `view`.
		expect(items?.[0]?.value).toBe("view full ");
	});

	test("offers passive on/off immediately", () => {
		expect(getMemoryCommandCompletions("passive ")?.map((item) => item.label)).toEqual(["on", "off"]);
		const items = getMemoryCommandCompletions("passive o");
		expect(items?.map((item) => item.label)).toEqual(["on", "off"]);
		expect(items?.[0]?.value).toBe("passive on ");
	});
});

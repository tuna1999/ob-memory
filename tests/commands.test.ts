import { describe, expect, test } from "bun:test";
import { handleConfig } from "../src/commands/status";
import { handleView } from "../src/commands/view";
import { makeHarness, messageEntry, observationEntry, observationRecord } from "./helpers";

function capture(runtime: ReturnType<typeof makeHarness>["runtime"]): string[] {
	const notifications: string[] = [];
	Object.assign(runtime.ctx, {
		hasUI: true,
		mode: "rpc",
	});
	Object.assign(runtime.ctx.ui, {
		notify: (message: string) => notifications.push(message),
	});
	return notifications;
}

describe("memory commands", () => {
	test("config reports derived effective budgets", () => {
		const { runtime } = makeHarness();
		const notifications = capture(runtime);
		handleConfig(runtime, runtime.ctx);
		const output = notifications.join("\n");
		expect(output).toContain("observerChunkMaxTokens");
		expect(output).toContain("workerMemoryMaxTokens");
		expect(output).toContain("sessionModel");
		expect(output).toContain("compactionSummaryMaxTokens");
	});

	test("view redacts stored content when redaction is enabled", async () => {
		const { runtime, entries } = makeHarness({ redactSecrets: true });
		const content = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
		entries.push(messageEntry("e1", "user", "source text"));
		entries.push(
			observationEntry("o1", [observationRecord("0123456789ab", ["e1"], "e1", content)], "e1"),
		);
		const notifications = capture(runtime);
		await handleView(runtime, runtime.ctx, "");
		const output = notifications.join("\n");
		expect(output).not.toContain("dXNlcjpwYXNzd29yZA==");
		expect(output).toContain("REDACTED AUTHORIZATION HEADER");
	});
});

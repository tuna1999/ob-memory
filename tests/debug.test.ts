import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { DebugLog } from "../src/debug-log";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ob-memory-debug-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("debug log", () => {
	test("writes NDJSON only when enabled and redacts fields", () => {
		const agentDir = tempDir();
		const disabled = new DebugLog({ enabled: false, agentDir, sessionId: "disabled" });
		disabled.record("test", "event", { value: 1 });
		expect(() => readFileSync(disabled.path)).toThrow();

		const log = new DebugLog({ enabled: true, agentDir, sessionId: "session" });
		log.record("test", "event", { apiKey: "secret", tokenCount: 3, message: "sk-abcdefghijklmnopqrstuvwx" });
		const lines = readFileSync(log.path, "utf8").trim().split("\n");
		const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(payload.stage).toBe("test");
		expect(payload.apiKey).toBe("[REDACTED]");
		expect(payload.tokenCount).toBe(3);
		expect(payload.message).toBe("[REDACTED API KEY]");
	});
});

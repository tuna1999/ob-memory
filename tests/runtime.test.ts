import { describe, expect, test } from "bun:test";
import { makeHarness } from "./helpers";
import { consolidate } from "../src/workers/trigger";
import { MAX_FAILURE_BACKOFF_MS } from "../src/runtime";

describe("session runtime", () => {
	test("runs one pass at a time and rejects overlap", async () => {
		const { runtime } = makeHarness();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runtime.runExclusive("test", async () => {
			await gate;
		});
		expect(runtime.busy).toBe(true);
		const second = await runtime.runExclusive("test", async () => {});
		expect(second).toBe(false);
		release?.();
		expect(await first).toBe(true);
		expect(runtime.busy).toBe(false);
	});

	test("aborts the active signal and refuses appends after dispose", async () => {
		const { runtime } = makeHarness();
		let observedAbort = false;
		const run = runtime.runExclusive("test", async (signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					observedAbort = true;
					resolve();
				});
			});
		});
		runtime.abort("test");
		await run;
		expect(observedAbort).toBe(true);
		runtime.dispose("test");
		expect(runtime.append("ob-memory.test", {})).toBe(false);
	});

	test("a busy pass is not reported as failed because of an old error", async () => {
		const { runtime } = makeHarness();
		const gate = Promise.withResolvers<void>();
		const holder = runtime.runExclusive("hold", async () => {
			await gate.promise;
		});
		runtime.recordError("prior", new Error("old failure"));
		const result = await consolidate(runtime, "test", { force: true });
		expect(result.skipped).toBe("busy");
		gate.resolve();
		await holder;
	});

	test("failure backoff doubles and reaches the 5 minute cap", () => {
		const { runtime } = makeHarness();
		const delays: number[] = [];
		for (let i = 0; i < 12; i++) {
			const before = Date.now();
			runtime.noteFailure("test", new Error("boom"));
			delays.push(runtime.failureBackoffUntil - before);
		}
		expect(delays[0]).toBeGreaterThanOrEqual(2_000);
		expect(delays[0]).toBeLessThan(3_000);
		expect(delays[7]).toBeLessThan(MAX_FAILURE_BACKOFF_MS);
		expect(delays[8]).toBeGreaterThanOrEqual(MAX_FAILURE_BACKOFF_MS - 50);
		expect(delays[11]).toBeLessThanOrEqual(MAX_FAILURE_BACKOFF_MS + 50);
		runtime.noteSuccess();
		expect(runtime.isFailureBackoffActive()).toBe(false);
	});
});

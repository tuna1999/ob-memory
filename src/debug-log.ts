import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactValue } from "./security/redact";

export interface DebugLogOptions {
	enabled: boolean;
	agentDir: string;
	sessionId: string;
}

/**
 * Best-effort NDJSON diagnostic log. A logging failure must never affect the
 * session, so every filesystem operation is swallowed after the first error.
 */
export class DebugLog {
	readonly #enabled: boolean;
	readonly #path: string;
	#failed = false;

	constructor(options: DebugLogOptions) {
		this.#enabled = options.enabled;
		this.#path = join(options.agentDir, "ob-memory", "debug", `${options.sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	get path(): string {
		return this.#path;
	}

	record(stage: string, event: string, fields: Record<string, unknown> = {}): void {
		if (!this.#enabled || this.#failed) return;
		try {
			mkdirSync(dirname(this.#path), { recursive: true });
			const payload = {
				ts: new Date().toISOString(),
				stage,
				event,
				...((redactValue(fields) as Record<string, unknown>) ?? {}),
			};
			appendFileSync(this.#path, `${JSON.stringify(payload)}\n`, "utf8");
		} catch {
			this.#failed = true;
		}
	}

	usage(stage: string, model: string, usage: unknown, durationMs?: number): void {
		this.record(stage, "usage", { model, usage, durationMs });
	}
}

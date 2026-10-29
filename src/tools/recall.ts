import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { recallMemory } from "../ledger/recall";
import type { LedgerEntry } from "../ledger/types";
import type { SessionRuntime } from "../runtime";

export function registerRecallTool(pi: ExtensionAPI, getRuntime: () => SessionRuntime | undefined): void {
	const z = pi.zod;
	pi.registerTool({
		name: "ob_recall",
		label: "Recall observational memory",
		description:
			"Recover one observational-memory record by exact id and, for observations, its original source evidence. Use this only when a memory id in compacted context needs verification or more precision; do not use it as a broad search.",
		parameters: z.object({
			id: z.string().min(12).max(12).describe("Exact 12-character observation or reflection id."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const runtime = getRuntime();
			if (!runtime) {
				return {
					content: [{ type: "text" as const, text: "Observational memory is not initialized for this session." }],
					isError: true,
				};
			}
			const id = params && typeof params === "object" && "id" in params && typeof params.id === "string" ? params.id : "";
			if (id.length !== 12) {
				return {
					content: [{ type: "text" as const, text: "ob_recall needs an exact 12-character memory id." }],
					isError: true,
				};
			}
			const entries = ctx.sessionManager.getBranch() as LedgerEntry[];
			const result = recallMemory(entries, id, {
				redact: runtime.config.redactSecrets,
				lookupEntry: (entryId) => ctx.sessionManager.getEntry(entryId) as LedgerEntry | undefined,
			});
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
				isError: !result.found,
			};
		},
	});
}

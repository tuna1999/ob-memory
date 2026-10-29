import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { estimateTextTokens } from "../constants";

export type TokenEstimator = (text: string) => number;

/**
 * Prefer the host tokenizer so budgets track the active model. Fall back to the
 * deterministic byte/4 estimate when there is no model (unit tests, early load)
 * or the catalog lacks an encoding for it.
 */
export function createTokenEstimator(model?: unknown): TokenEstimator {
	if (!model) return estimateTextTokens;
	try {
		const tokenizer = new Tokenizer(model as never);
		return (text: string) => tokenizer.countTokens(text, "approximate");
	} catch {
		return estimateTextTokens;
	}
}

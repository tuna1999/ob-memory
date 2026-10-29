export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

export interface ObMemoryConfig {
	enabled: boolean;
	model?: ModelChoice;
	fallbackModel?: ModelChoice;
	/** Run the observer when this many raw source tokens remain unobserved. */
	observeAfterTokens: number;
	/** Run the reflector when active observations reach this many tokens. */
	reflectAfterTokens: number;
	/** Maximum size of one source chunk sent to the observer. Unset derives from the resolved worker model. */
	observerChunkMaxTokens?: number;
	/** Active-observation pool size above which the dropper is considered. */
	observationsPoolMaxTokens: number;
	/** Soft active-observation target used by the dropper. */
	observationsPoolTargetTokens: number;
	/** Maximum rendered size of the memory summary. Unset derives from the context window. */
	compactionSummaryMaxTokens?: number;
	/** Maximum raw tail retained when the observer has not covered the proposed cut. */
	compactionMaxRetainedTokens?: number;
	/** Synchronous observer chunks attempted inside session_before_compact. */
	compactionCatchUpMaxChunks: number;
	/** Wall-clock budget for synchronous catch-up inside session_before_compact. */
	compactionCatchUpBudgetMs: number;
	/** Maximum prior memory sent with one worker request. Unset derives from the resolved worker model. */
	workerMemoryMaxTokens?: number;
	/** Maximum assistant turns in one worker tool loop. */
	agentMaxTurns: number;
	/** Maximum output tokens for one worker request. */
	agentMaxTokens: number;
	/** Run workers only when the main session is idle. */
	consolidateWhenIdle: boolean;
	/** Include attachment metadata in source chunks. Images are never decoded. */
	observeAttachments: boolean;
	/** Redact credentials and tokens before worker input and debug output. */
	redactSecrets: boolean;
	/** Disable automatic consolidation and compaction ownership. */
	passive: boolean;
	ownManualCompaction: boolean;
	ownAutoCompaction: boolean;
	debugLog: boolean;
	/** Show automatic warnings/status; explicit command output is always shown. */
	showNotifications: boolean;
}

export const DEFAULT_CONFIG: ObMemoryConfig = {
	enabled: true,
	observeAfterTokens: 6_000,
	reflectAfterTokens: 4_000,
	observationsPoolMaxTokens: 16_000,
	observationsPoolTargetTokens: 10_000,
	compactionCatchUpMaxChunks: 2,
	compactionCatchUpBudgetMs: 18_000,
	agentMaxTurns: 8,
	agentMaxTokens: 4_096,
	consolidateWhenIdle: true,
	observeAttachments: false,
	redactSecrets: true,
	passive: false,
	ownManualCompaction: true,
	ownAutoCompaction: true,
	debugLog: false,
	showNotifications: true,
};

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

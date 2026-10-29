/**
 * One dropdown row. `AutocompleteItem` lives in `@oh-my-pi/pi-tui`, which is a
 * transitive dependency here, so this names the subset the command emits; the
 * structural shape satisfies the extension API's `AutocompleteItem[]`.
 */
export interface CommandCompletionItem {
	value: string;
	label: string;
	description?: string;
	/** Ghost text appended after the cursor while this row is selected. */
	hint?: string;
}

interface MemorySubcommand {
	name: string;
	description: string;
}

/** Canonical first-level subcommands, in help order. */
export const MEMORY_SUBCOMMANDS: readonly MemorySubcommand[] = [
	{ name: "view", description: "Show the visible memory" },
	{ name: "status", description: "Counts, coverage, pressure, errors" },
	{ name: "observe-now", description: "Run one consolidation pass immediately" },
	{ name: "passive", description: "Pause or resume automatic memory work" },
	{ name: "config", description: "Show effective config" },
	{ name: "help", description: "List commands" },
];

interface SubcommandOptions {
	/**
	 * The bare subcommand is a complete invocation (`/ob-memory view`), so the
	 * dropdown stays closed until a prefix is typed; otherwise Enter on
	 * `/ob-memory view ` would silently accept `full` instead of submitting.
	 */
	optional: boolean;
	items: readonly MemorySubcommand[];
}

const SUBCOMMAND_OPTIONS: Readonly<Record<string, SubcommandOptions>> = {
	view: {
		optional: true,
		items: [{ name: "full", description: "Show the full branch ledger" }],
	},
	passive: {
		optional: false,
		items: [
			{ name: "on", description: "Pause automatic memory work" },
			{ name: "off", description: "Resume automatic memory work" },
		],
	},
};

function complete(
	prefix: string,
	items: readonly MemorySubcommand[],
	valuePrefix = "",
): CommandCompletionItem[] | null {
	const lower = prefix.toLowerCase();
	const matches: CommandCompletionItem[] = [];
	for (const item of items) {
		if (!item.name.startsWith(lower)) continue;
		const remainder = item.name.slice(lower.length);
		matches.push({
			// Deep levels replace the whole argument text, so the accepted value
			// must carry the tokens already typed (`view ` + `full`).
			value: `${valuePrefix}${item.name} `,
			label: item.name,
			description: item.description,
			...(remainder ? { hint: remainder } : {}),
		});
	}
	return matches.length > 0 ? matches : null;
}

/**
 * Argument completions for `/ob-memory`: first-level subcommands, then the
 * `view full` and `passive on|off` tails. Mirrors the editor contract — `null`
 * past the level this command understands, so the prompt falls back to file
 * completion instead of showing stale rows.
 */
export function getMemoryCommandCompletions(argumentPrefix: string): CommandCompletionItem[] | null {
	const spaceIndex = argumentPrefix.indexOf(" ");
	if (spaceIndex === -1) return complete(argumentPrefix, MEMORY_SUBCOMMANDS);
	const options = SUBCOMMAND_OPTIONS[argumentPrefix.slice(0, spaceIndex).toLowerCase()];
	if (!options) return null;
	const tail = argumentPrefix.slice(spaceIndex + 1);
	if (tail.includes(" ")) return null;
	if (options.optional && tail.length === 0) return null;
	return complete(tail, options.items, `${argumentPrefix.slice(0, spaceIndex)} `);
}

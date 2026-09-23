import { rankItem } from '../CommandPalette/fuzzyMatch';
import type { TypeaheadItem } from '../Typeahead';
import type { HarnessAgent, HarnessCommand } from '../../../shared/types';

/**
 * Turning a harness's commands and agents into rows for the inline menu.
 *
 * The trigger character is part of the label so what is highlighted is exactly
 * what will be inserted, and so the fuzzy matcher scores against the same
 * string the user is looking at.
 */

/** Rows show at most this many matches; more than a screenful helps nobody. */
const MAX_RESULTS = 50;

/**
 * Claude prefixes a plugin's commands with `(plugin-name)` and marks
 * user-level ones with a trailing `(user)`. Both are useful, but they bury the
 * sentence that actually says what the command does, so the marker is lifted
 * out and shown separately.
 */
const PLUGIN_PREFIX = /^\(([^)]+)\)\s*/;
const USER_SUFFIX = /\s*\(user\)$/;

interface SplitDescription {
    source?: string;
    description: string;
}

export function splitCommandDescription(raw: string): SplitDescription {
    const withoutUser = raw.replace(USER_SUFFIX, '');
    const plugin = withoutUser.match(PLUGIN_PREFIX);
    if (plugin) {
        return { source: plugin[1], description: withoutUser.replace(PLUGIN_PREFIX, '') };
    }
    return {
        source: raw === withoutUser ? undefined : 'user',
        description: withoutUser,
    };
}

export function commandItems(commands: HarnessCommand[]): TypeaheadItem[] {
    return commands.map((command) => {
        const { description } = splitCommandDescription(command.description);
        return {
            id: `command:${command.name}`,
            label: `/${command.name}`,
            description,
            hint: command.argumentHint || undefined,
        };
    });
}

export function agentItems(agents: HarnessAgent[]): TypeaheadItem[] {
    return agents.map((agent) => ({
        id: `agent:${agent.name}`,
        label: `@${agent.name}`,
        description: agent.description,
    }));
}

/**
 * Rank rows against what has been typed after the trigger.
 *
 * An empty query keeps the CLI's own order, which puts built-ins and the
 * user's own commands before the long tail of plugin ones.
 */
export function rankTypeaheadItems(items: TypeaheadItem[], query: string): TypeaheadItem[] {
    if (!query) return items.slice(0, MAX_RESULTS);

    return items
        .map((item) => ({ item, match: rankItem(query, item.label, item.description) }))
        .filter((scored): scored is { item: TypeaheadItem; match: { score: number; indices: number[] } } =>
            scored.match !== null
        )
        .sort((a, b) => b.match.score - a.match.score)
        .slice(0, MAX_RESULTS)
        .map((scored) => scored.item);
}

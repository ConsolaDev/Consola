/**
 * The names a session's CLI sees for Consola's MCP server and its tools.
 *
 * Shared because a driver that restricts a session has to allow some of
 * these by name in its CLI's own permission rules, and the host is what
 * chooses them: one definition, or a rename quietly locks a read-only
 * session out of its only window on the item.
 */

/** The server's key in every session's MCP config. */
export const CONSOLA_MCP_SERVER = 'consola';

/** A registry tool's name as the session sees it: `list_sessions` → `consola_list_sessions`. */
export function mcpToolName(tool: string): string {
    return `consola_${tool}`;
}

/**
 * The Consola tools a read-only session may call without asking: reading
 * the item it is about, and the Inbox. Both are main's to fetch, with the
 * token main holds — the session itself holds none, so this is its only way
 * to see a pull request beyond the files in its folder.
 */
export const READ_ONLY_CONSOLA_TOOLS = ['work_item_context', 'list_inbox'] as const;

/**
 * A conversation as the Automations side panel shows it: flat and read-only,
 * with none of the CLI's own rendering. Read from a transcript on disk, so
 * showing one never starts a process.
 */
export type ConversationEntry =
    | { kind: 'prompt'; text: string; at?: string }
    | { kind: 'step'; tool: string; detail?: string; at?: string }
    | { kind: 'text'; text: string; at?: string };

export interface ConversationRecord {
    entries: ConversationEntry[];
    /** More records existed than `entries` holds. */
    truncated: boolean;
}

/** The slice of a conversation to keep, by record timestamp (ISO). Both ends optional. */
export interface ConversationWindow {
    since?: string;
    until?: string;
}

/** What the side panel can show of a run's conversation. */
export type RunConversation =
    | { readable: false }
    | { readable: true; conversation: ConversationRecord | null };

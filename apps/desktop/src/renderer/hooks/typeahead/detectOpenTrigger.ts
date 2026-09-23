/**
 * Deciding whether the caret sits inside an unfinished `/` or `@` token.
 *
 * Deliberately separate from `commandHighlighter`, which answers a different
 * question: that one classifies finished `/word` mentions inside written prose
 * so they can be styled. This one is about a token still being typed, where
 * the caret's position is the whole point and the text after it is irrelevant.
 */

/** Where a trigger character is allowed to open a menu. */
export type TypeaheadPosition =
    /** Only as the first thing in the message, like a command line. */
    | 'message-start'
    /** Anywhere a new word starts, so it can be used mid-sentence. */
    | 'word-boundary';

export interface TypeaheadTriggerConfig {
    char: string;
    position: TypeaheadPosition;
}

export interface OpenTypeahead {
    trigger: TypeaheadTriggerConfig;
    /** Index of the trigger character itself. */
    start: number;
    /** What has been typed after it, so far. */
    query: string;
}

/**
 * Find the trigger the caret is currently inside, if any.
 *
 * Scans left from the caret. Whitespace ends the search: typing a space always
 * finishes a command or mention attempt, which is what stops the menu
 * reopening halfway through an ordinary sentence.
 */
export function detectOpenTrigger(
    text: string,
    caretIndex: number,
    triggers: TypeaheadTriggerConfig[]
): OpenTypeahead | null {
    const caret = Math.max(0, Math.min(caretIndex, text.length));

    for (let index = caret - 1; index >= 0; index--) {
        const char = text[index];
        if (/\s/.test(char)) return null;

        const trigger = triggers.find((candidate) => candidate.char === char);
        if (!trigger) continue;

        if (trigger.position === 'message-start' && text.slice(0, index).trim().length > 0) {
            // A slash that is not the first thing typed is part of something
            // else — a path, a fraction, a URL — not a command.
            return null;
        }
        if (trigger.position === 'word-boundary' && index > 0 && !/\s/.test(text[index - 1])) {
            // Keeps an email address from opening the agent menu.
            return null;
        }

        return { trigger, start: index, query: text.slice(index + 1, caret) };
    }

    return null;
}

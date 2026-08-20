import type { OpenTypeahead } from './detectOpenTrigger';

export interface SplicedText {
    value: string;
    /** Where the caret belongs afterwards: just past the inserted text. */
    caretIndex: number;
}

/**
 * Replace the token being typed with the one that was picked.
 *
 * A trailing space is part of the insertion, both so the next word can be
 * typed straight away and because it closes the menu: `detectOpenTrigger`
 * stops at whitespace, so the popover shuts without any separate signal.
 */
export function spliceTypeaheadSelection(
    text: string,
    open: OpenTypeahead,
    insertText: string
): SplicedText {
    const before = text.slice(0, open.start);
    const after = text.slice(open.start + 1 + open.query.length);
    const insertion = `${open.trigger.char}${insertText} `;

    return {
        value: `${before}${insertion}${after}`,
        caretIndex: before.length + insertion.length,
    };
}

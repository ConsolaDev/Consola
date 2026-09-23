import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
    detectOpenTrigger,
    type OpenTypeahead,
    type TypeaheadTriggerConfig,
} from './detectOpenTrigger';

export interface UseTypeaheadOptions<T> {
    /** The composer's current text. */
    text: string;
    /** Where the caret is in it. */
    caretIndex: number;
    triggers: TypeaheadTriggerConfig[];
    /**
     * The rows to offer for an open trigger.
     *
     * Taken as a callback rather than a list because the rows depend on which
     * trigger is open and what has been typed after it — the hook works that
     * out, so it has to be the one to ask.
     */
    buildItems: (open: OpenTypeahead) => T[];
    onSelect: (item: T, open: OpenTypeahead) => void;
}

export interface UseTypeaheadResult<T> {
    open: OpenTypeahead | null;
    items: T[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    /** Returns true when the key was used, so the caller can stop handling it. */
    handleKeyDown: (event: React.KeyboardEvent) => boolean;
    /** Take the row at an index, as a click would. */
    select: (index: number) => void;
    /** Close until the token changes, without touching the text. */
    dismiss: () => void;
}

/** Identifies the token being typed, so a dismissal can be aimed at just it. */
function signatureOf(open: OpenTypeahead | null): string | null {
    return open ? `${open.trigger.char}:${open.start}:${open.query}` : null;
}

/**
 * Open/closed state and keyboard handling for an inline `/` or `@` menu.
 *
 * Knows nothing about commands, agents, or where rows come from — it is
 * generic over whatever the caller builds. That is what lets one hook drive
 * both menus here, and a third somewhere else later, without acquiring a
 * vocabulary of its own.
 */
export function useTypeahead<T>({
    text,
    caretIndex,
    triggers,
    buildItems,
    onSelect,
}: UseTypeaheadOptions<T>): UseTypeaheadResult<T> {
    const [activeIndex, setActiveIndex] = useState(0);
    // Which token Escape closed. State rather than a ref because `open` is
    // derived from it during render: a ref would be updated without anything
    // re-rendering, and the menu would stay on screen after Escape.
    const [dismissedToken, setDismissedToken] = useState<string | null>(null);

    const detected = useMemo(
        () => detectOpenTrigger(text, caretIndex, triggers),
        [text, caretIndex, triggers]
    );
    const signature = signatureOf(detected);

    // Editing the token — another letter, a deletion — is a fresh request, so
    // the menu comes back. Only the exact token that was dismissed stays shut.
    const open = signature && dismissedToken === signature ? null : detected;

    const items = useMemo(() => (open ? buildItems(open) : []), [open, buildItems]);

    // Keep the highlight inside the list as it changes under the cursor,
    // without an effect: deriving it avoids a render showing a stale index.
    const boundedIndex = activeIndex < items.length ? activeIndex : 0;

    // A different token means a different list, so start from the top.
    const lastSignature = useRef<string | null>(signature);
    if (lastSignature.current !== signature) {
        lastSignature.current = signature;
        if (activeIndex !== 0) setActiveIndex(0);
    }

    const dismiss = useCallback(() => {
        setDismissedToken(signature);
    }, [signature]);

    const select = useCallback(
        (index: number) => {
            const item = items[index];
            if (!open || item === undefined) return;
            onSelect(item, open);
        },
        [items, open, onSelect]
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent): boolean => {
            if (!open) return false;

            if (event.key === 'Escape') {
                dismiss();
                return true;
            }

            // Everything below needs a row to act on. Enter especially must
            // fall through to the composer while the list is empty or still
            // loading, or a stray `/` would stop the message being sent.
            if (items.length === 0) return false;

            if (event.key === 'ArrowDown') {
                setActiveIndex((current) => (current + 1) % items.length);
                return true;
            }
            if (event.key === 'ArrowUp') {
                setActiveIndex((current) => (current - 1 + items.length) % items.length);
                return true;
            }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                select(boundedIndex);
                return true;
            }

            return false;
        },
        [open, items.length, boundedIndex, select, dismiss]
    );

    return {
        open,
        items,
        activeIndex: boundedIndex,
        setActiveIndex,
        handleKeyDown,
        select,
        dismiss,
    };
}

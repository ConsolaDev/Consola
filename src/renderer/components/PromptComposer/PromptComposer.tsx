import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { Harness } from '../../../shared/harness';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';
import {
    spliceTypeaheadSelection,
    useTypeahead,
    type OpenTypeahead,
    type TypeaheadTriggerConfig,
} from '../../hooks/typeahead';
import { TypeaheadPopover, rowElementId, type TypeaheadItem } from '../Typeahead';
import { agentItems, commandItems, rankTypeaheadItems } from './typeaheadCandidates';
import './styles.css';

interface PromptComposerProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    /** Harness the conversation will run on; its commands fill the menus. */
    harness: Harness | undefined;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
}

/**
 * A slash is only a command when it starts the message, which is how Claude
 * itself reads one — anything else is a path. An at-sign is a mention and can
 * start any word.
 */
const TRIGGERS: TypeaheadTriggerConfig[] = [
    { char: '/', position: 'message-start' },
    { char: '@', position: 'word-boundary' },
];

/** Tallest the box grows before it scrolls instead. */
const MAX_HEIGHT_PX = 200;

/**
 * The prompt box, with the harness's own commands and agents behind `/` and `@`.
 *
 * Picking a command only writes text. The composer already hands whatever is
 * typed here to the CLI, and the CLI is what runs it — so this menu adds no
 * execution path of its own, it only saves people remembering names.
 */
export function PromptComposer({
    value,
    onChange,
    onSubmit,
    harness,
    placeholder = 'Ask anything...',
    disabled,
    autoFocus,
}: PromptComposerProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Set when a selection moves the caret, applied once React has rendered
    // the new value — setting it any earlier would be overwritten.
    const pendingCaret = useRef<number | null>(null);
    const [caretIndex, setCaretIndex] = useState(0);

    // Asked for as soon as the composer appears. The probe takes about a
    // second, comfortably less than the time it takes to type a prompt, so the
    // menu is usually ready before anyone wants it.
    const { loading, capabilities, unavailable } = useHarnessCapabilities(harness, true);

    const commands = useMemo(
        () => (capabilities ? commandItems(capabilities.commands) : []),
        [capabilities]
    );
    const agents = useMemo(
        () => (capabilities ? agentItems(capabilities.agents) : []),
        [capabilities]
    );

    const buildItems = useCallback(
        (open: OpenTypeahead): TypeaheadItem[] =>
            rankTypeaheadItems(open.trigger.char === '@' ? agents : commands, open.query),
        [agents, commands]
    );

    const handleSelect = useCallback(
        (item: TypeaheadItem, open: OpenTypeahead) => {
            // The label carries the trigger character so it matches what was
            // typed and highlights cleanly; the splice re-adds it.
            const spliced = spliceTypeaheadSelection(value, open, item.label.slice(1));
            pendingCaret.current = spliced.caretIndex;
            onChange(spliced.value);
        },
        [value, onChange]
    );

    const typeahead = useTypeahead<TypeaheadItem>({
        text: value,
        caretIndex,
        triggers: TRIGGERS,
        buildItems,
        onSelect: handleSelect,
    });

    useEffect(() => {
        if (autoFocus) textareaRef.current?.focus();
    }, [autoFocus]);

    // Grow with the content, up to a limit.
    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT_PX)}px`;
    }, [value]);

    useLayoutEffect(() => {
        const caret = pendingCaret.current;
        if (caret === null) return;
        pendingCaret.current = null;
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
        setCaretIndex(caret);
    }, [value]);

    const syncCaret = () => {
        const textarea = textareaRef.current;
        if (textarea) setCaretIndex(textarea.selectionStart ?? 0);
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        // The menu gets first refusal on the keys it shares with the composer.
        // It declines Enter whenever it has nothing to select, so a `/` typed
        // with no match never stops a message being sent.
        if (typeahead.handleKeyDown(event)) {
            event.preventDefault();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
        }
    };

    // Nothing to show before a harness is known, and nothing to say when the
    // menu would only report that a probe is still running for a token the
    // user has already finished typing.
    const open = Boolean(typeahead.open) && Boolean(harness);
    // Points assistive technology at the row the keyboard is on, since focus
    // never leaves the textarea for the menu to announce itself.
    const activeItemId = open ? typeahead.items[typeahead.activeIndex]?.id : undefined;

    return (
        <TypeaheadPopover
            open={open}
            anchor={
                <div className="prompt-composer">
                    <textarea
                        ref={textareaRef}
                        className="prompt-composer-input"
                        value={value}
                        onChange={(event) => {
                            onChange(event.target.value);
                            setCaretIndex(event.target.selectionStart ?? 0);
                        }}
                        onKeyDown={handleKeyDown}
                        onKeyUp={syncCaret}
                        onClick={syncCaret}
                        onSelect={syncCaret}
                        placeholder={placeholder}
                        rows={1}
                        disabled={disabled}
                        role="combobox"
                        aria-expanded={open}
                        aria-autocomplete="list"
                        aria-activedescendant={
                            activeItemId ? rowElementId(activeItemId) : undefined
                        }
                    />
                    <button
                        className="prompt-composer-submit"
                        onClick={onSubmit}
                        disabled={!value.trim() || disabled}
                        aria-label="Send message"
                    >
                        <Send size={18} />
                    </button>
                </div>
            }
            items={typeahead.items}
            query={typeahead.open?.query ?? ''}
            activeIndex={typeahead.activeIndex}
            loading={loading}
            unavailable={unavailable}
            emptyMessage={
                typeahead.open?.trigger.char === '@' ? 'No matching agents' : 'No matching commands'
            }
            onHover={typeahead.setActiveIndex}
            onSelect={typeahead.select}
        />
    );
}

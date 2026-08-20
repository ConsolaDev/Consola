import { useEffect, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { HighlightMatch } from '../HighlightMatch';
import './styles.css';

export interface TypeaheadItem {
    id: string;
    /** What is matched against and shown, e.g. `/commit`. */
    label: string;
    description?: string;
    /** Trailing dim text, e.g. a command's argument hint. */
    hint?: string;
}

interface TypeaheadPopoverProps {
    open: boolean;
    /** The element to hang the menu under; usually the composer box. */
    anchor: React.ReactNode;
    items: TypeaheadItem[];
    query: string;
    activeIndex: number;
    loading?: boolean;
    /** Shown instead of rows when the harness could not be asked. */
    unavailable?: string;
    emptyMessage?: string;
    onHover: (index: number) => void;
    onSelect: (index: number) => void;
}

export function rowElementId(itemId: string): string {
    return `typeahead-option-${encodeURIComponent(itemId)}`;
}

/**
 * The menu that drops out of a composer when a trigger character is typed.
 *
 * Anchored to the composer box rather than the caret itself. Tracking the
 * caret would mean mirroring the textarea into a hidden element to measure it,
 * which is a lot of machinery for a prompt box a few lines tall — and every
 * mention menu people already use behaves this way.
 *
 * Open state is owned entirely by the caller, which knows where the caret is.
 * Radix is told when to show, never asked.
 */
export function TypeaheadPopover({
    open,
    anchor,
    items,
    query,
    activeIndex,
    loading,
    unavailable,
    emptyMessage = 'No matches',
    onHover,
    onSelect,
}: TypeaheadPopoverProps) {
    const listRef = useRef<HTMLDivElement>(null);

    // Follow the keyboard when the selection moves past the visible rows.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const row = list.querySelector<HTMLElement>('[data-active="true"]');
        row?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex, items]);

    const hasRows = items.length > 0;

    return (
        <Popover.Root open={open}>
            <Popover.Anchor asChild>{anchor}</Popover.Anchor>
            <Popover.Portal>
                <Popover.Content
                    className="typeahead-popover"
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    // The composer keeps the focus throughout. Without both of
                    // these Radix pulls focus into the menu on open, and the
                    // next character typed would never reach the textarea.
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    // Typing is not an interaction with the menu, and neither
                    // is clicking back into the composer: the caller closes
                    // this when the caret leaves the token.
                    onInteractOutside={(event) => event.preventDefault()}
                >
                    <div className="typeahead-list" role="listbox" ref={listRef}>
                        {unavailable && (
                            <div className="typeahead-notice typeahead-notice--error">
                                {unavailable}
                            </div>
                        )}

                        {!unavailable && loading && (
                            // Said out loud rather than shown as an empty list,
                            // which would read as "this harness has nothing".
                            <div className="typeahead-notice">Loading…</div>
                        )}

                        {!unavailable && !loading && !hasRows && (
                            <div className="typeahead-notice">{emptyMessage}</div>
                        )}

                        {!unavailable &&
                            items.map((item, index) => (
                                <div
                                    key={item.id}
                                    id={rowElementId(item.id)}
                                    role="option"
                                    aria-selected={index === activeIndex}
                                    data-active={index === activeIndex}
                                    className={`typeahead-row ${
                                        index === activeIndex ? 'selected' : ''
                                    }`}
                                    // mousemove, not mouseenter: a row
                                    // scrolling under a still cursor would
                                    // otherwise steal the keyboard's place.
                                    onMouseMove={() => onHover(index)}
                                    // Selection happens on mousedown so the
                                    // composer never loses focus first, which
                                    // would close the menu before the click.
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        onSelect(index);
                                    }}
                                >
                                    <span className="typeahead-row-label">
                                        <span className="typeahead-row-name">
                                            <HighlightMatch
                                                label={item.label}
                                                query={query}
                                            />
                                        </span>
                                        {item.hint && (
                                            <span className="typeahead-row-hint">
                                                {item.hint}
                                            </span>
                                        )}
                                    </span>
                                    {item.description && (
                                        <span className="typeahead-row-description">
                                            {item.description}
                                        </span>
                                    )}
                                </div>
                            ))}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

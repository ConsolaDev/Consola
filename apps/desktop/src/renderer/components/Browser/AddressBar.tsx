import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveAddressInput, type BrowserHistoryEntry } from '../../../shared/browser';
import { suggestFromHistory } from '../../../shared/browserTools';
import { browserBridge } from '../../services/browserBridge';
import {
  addressFocusAnswer,
  settleAddressFocus,
  useAddressFocusStore,
} from '../../stores/addressFocusStore';

interface AddressBarProps {
  /** The tab the bar is for; none while the session has no tab. */
  tabId: string | null;
  /** What the bar shows while nobody is editing it. */
  address: string;
  /** Opens a resolved address. Resolves false when Consola refused it. */
  onOpen: (url: string) => Promise<boolean>;
}

/**
 * The address bar. Enter turns what was typed into a page or a search
 * (`resolveAddressInput`); anything else with a scheme is refused here, with
 * the reason under the bar, and never reaches a page. Escape or leaving the
 * bar puts the page's own address back.
 *
 * While typing, pages this workspace visited that match are suggested
 * (arrow keys move, Enter opens the highlighted one). History is read when the
 * field takes focus, so a page visited meanwhile shows from the next focus.
 *
 * Returns two grid items for the toolbar: the field, and the message row
 * that spans the whole toolbar beneath it.
 */
export function AddressBar({ tabId, address, onOpen }: AddressBarProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A click that focuses the field would place the caret on mouseup and lose
  // the select-all that focusing does.
  const selectingOnFocus = useRef(false);
  const messageId = useId();
  const listId = useId();
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  // -1 is the typed text itself: Enter submits it rather than a suggestion.
  const [highlighted, setHighlighted] = useState(-1);

  const suggestions = suggestFromHistory(history, draft ?? '', { exclude: address });
  const listShown = suggestions.length > 0 && inputRef.current !== null;

  // The one place focus moves into the panel, and only for the person's own
  // ⌘L, "+" or palette row (an agent's doing never reaches this store). A
  // request for a tab just opened is taken once its bar is here.
  useEffect(() => {
    const act = (answer: ReturnType<typeof addressFocusAnswer>) => {
      if (answer === 'leave') return;
      settleAddressFocus();
      if (answer === 'take') inputRef.current?.focus();
    };
    act(addressFocusAnswer(useAddressFocusStore.getState(), tabId, 'shown'));
    return useAddressFocusStore.subscribe((state, previous) => {
      if (state.requests !== previous.requests) act(addressFocusAnswer(state, tabId, 'asked'));
    });
  }, [tabId]);

  const reset = () => {
    setDraft(null);
    setMessage(null);
    setHighlighted(-1);
  };

  const openSuggestion = async (url: string) => {
    if (!(await onOpen(url))) {
      setMessage('Consola could not open that address.');
      return;
    }
    reset();
    inputRef.current?.blur();
  };

  const submit = async () => {
    const resolution = resolveAddressInput(draft ?? address);
    if (resolution.kind === 'rejected') {
      setMessage(resolution.reason);
      return;
    }
    if (!(await onOpen(resolution.url))) {
      setMessage('Consola could not open that address.');
      return;
    }
    reset();
    inputRef.current?.blur();
  };

  return (
    <>
      <input
        ref={inputRef}
        className="browser-address-input"
        type="text"
        value={draft ?? address}
        placeholder="Search or enter an address"
        aria-label="Address"
        aria-invalid={message !== null}
        aria-describedby={message ? messageId : undefined}
        // Stays a textbox: existing tests and assistive tech find it by that role.
        // It names the list only while there is one.
        aria-controls={listShown ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onFocus={(event) => {
          event.currentTarget.select();
          browserBridge
            .history()
            .then(setHistory)
            .catch(() => setHistory([]));
        }}
        onMouseDown={(event) => {
          selectingOnFocus.current = document.activeElement !== event.currentTarget;
        }}
        onMouseUp={(event) => {
          if (selectingOnFocus.current) event.preventDefault();
          selectingOnFocus.current = false;
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setMessage(null);
          setHighlighted(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (suggestions.length === 0) return;
            event.preventDefault();
            const count = suggestions.length;
            // One step past either end returns to the typed text.
            setHighlighted((current) => {
              const next = current + (event.key === 'ArrowDown' ? 1 : -1);
              return next >= count ? -1 : next < -1 ? count - 1 : next;
            });
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const chosen = suggestions[highlighted];
            if (chosen) void openSuggestion(chosen.url);
            else void submit();
          } else if (event.key === 'Escape') {
            // Taken here: it must not also close a panel listening on the window.
            event.stopPropagation();
            reset();
            event.currentTarget.blur();
          }
        }}
        onBlur={reset}
      />
      {listShown &&
        inputRef.current &&
        createPortal(
          <SuggestionList
            id={listId}
            anchor={inputRef.current}
            entries={suggestions}
            highlighted={highlighted}
            onChoose={(url) => void openSuggestion(url)}
          />,
          document.body,
        )}
      {message && (
        <p id={messageId} className="browser-address-message" role="alert">
          {message}
        </p>
      )}
    </>
  );
}

interface SuggestionListProps {
  id: string;
  anchor: HTMLElement;
  entries: BrowserHistoryEntry[];
  highlighted: number;
  onChoose: (url: string) => void;
}

/** Under the field, drawn above the page (`--z-dropdown`) because the panel's own layer is below it. */
function SuggestionList({ id, anchor, entries, highlighted, onChoose }: SuggestionListProps) {
  const box = anchor.getBoundingClientRect();
  return (
    <div
      id={id}
      className="browser-suggestions"
      role="listbox"
      aria-label="Suggestions"
      style={{ left: box.left, top: box.bottom + 2, width: box.width }}
    >
      {entries.map((entry, index) => (
        // biome-ignore lint/a11y/useFocusableInteractive: the field keeps focus; the options are chosen by its arrow keys (aria-activedescendant)
        // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the field's, not the option's
        <div
          key={entry.url}
          id={`${id}-${index}`}
          className="browser-suggestion"
          role="option"
          aria-selected={index === highlighted}
          // Before the field's blur, which would discard the list and the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(entry.url)}
        >
          <span className="browser-suggestion-title">{entry.title || entry.url}</span>
          {entry.title && <span className="browser-suggestion-url">{entry.url}</span>}
        </div>
      ))}
    </div>
  );
}

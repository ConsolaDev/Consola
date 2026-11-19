import { useEffect, useId, useRef, useState } from 'react';
import { resolveAddressInput } from '../../../shared/browser';
import { useAddressFocusStore } from '../../stores/addressFocusStore';

interface AddressBarProps {
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
 * Returns two grid items for the toolbar: the field, and the message row
 * that spans the whole toolbar beneath it.
 */
export function AddressBar({ address, onOpen }: AddressBarProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A click that focuses the field would place the caret on mouseup and lose
  // the select-all that focusing does.
  const selectingOnFocus = useRef(false);
  const messageId = useId();

  // The one place focus moves into the panel, and only because the person
  // pressed ⌘L (an agent's input never reaches this store).
  useEffect(
    () =>
      useAddressFocusStore.subscribe((state, previous) => {
        if (state.requests !== previous.requests) inputRef.current?.focus();
      }),
    [],
  );

  const reset = () => {
    setDraft(null);
    setMessage(null);
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
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onFocus={(event) => event.currentTarget.select()}
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
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            // Taken here: it must not also close a panel listening on the window.
            event.stopPropagation();
            reset();
            event.currentTarget.blur();
          }
        }}
        onBlur={reset}
      />
      {message && (
        <p id={messageId} className="browser-address-message" role="alert">
          {message}
        </p>
      )}
    </>
  );
}

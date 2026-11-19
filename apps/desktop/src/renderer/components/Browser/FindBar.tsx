import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { findResultText, type FindResult } from '../../../shared/browserTools';
import { browserBridge } from '../../services/browserBridge';
import { useBrowserFindStore } from '../../stores/browserFindStore';

/**
 * Typing waits this long before searching. Chromium drops the reply to a
 * search started while the page is still being resized, which is exactly when
 * the bar has just opened and shrunk the slot; it also saves a search per key.
 */
const TYPING_DELAY_MS = 150;

interface FindBarProps {
  tabId: string;
  onClose: () => void;
}

/**
 * Find on page. Sits in flow between the toolbar and the page: anything
 * drawn over the slot would be under the page. Typing searches; Enter and
 * Shift+Enter step to the next and previous match; Escape closes and clears
 * the highlights. The search highlights without taking the keyboard from this
 * field.
 *
 * Key it by tab: a search belongs to one page, and leaving the tab ends it.
 */
export function FindBar({ tabId, onClose }: FindBarProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = () => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  };

  // Opened by the person's own chord or menu choice, so taking focus is theirs.
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    return useBrowserFindStore.subscribe((state, previous) => {
      if (state.requests !== previous.requests) focus();
    });
  }, []);

  useEffect(
    () =>
      browserBridge.onFound((message) => {
        if (message.tabId === tabId) setResult({ active: message.active, total: message.total });
      }),
    [tabId],
  );

  // The highlights belong to the bar: they go when it does.
  useEffect(() => () => void browserBridge.stopFind(tabId).catch(() => {}), [tabId]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  const step = (forward: boolean) => {
    cancelPending();
    if (query) void browserBridge.find(tabId, query, { forward, next: true });
  };

  return (
    <search className="browser-find" data-testid="browser-find">
      <input
        ref={inputRef}
        className="browser-find-input"
        type="text"
        value={query}
        placeholder="Find on page"
        aria-label="Find on page"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const text = event.target.value;
          setQuery(text);
          setResult(null);
          cancelPending();
          if (!text) {
            void browserBridge.stopFind(tabId);
            return;
          }
          pending.current = setTimeout(() => {
            pending.current = null;
            void browserBridge.find(tabId, text, { forward: true, next: false });
          }, TYPING_DELAY_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(!event.shiftKey);
          } else if (event.key === 'Escape') {
            // Taken here: it must not also close a panel listening on the window.
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="browser-find-count" data-testid="browser-find-count" aria-live="polite">
        {findResultText(query, result)}
      </span>
      <button
        type="button"
        className="browser-toolbar-button"
        aria-label="Previous match"
        disabled={!result?.total}
        onClick={() => step(false)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="browser-toolbar-button"
        aria-label="Next match"
        disabled={!result?.total}
        onClick={() => step(true)}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="browser-toolbar-button"
        aria-label="Close find"
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </search>
  );
}

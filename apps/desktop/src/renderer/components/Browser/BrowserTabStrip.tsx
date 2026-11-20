import { useLayoutEffect, useRef } from 'react';
import { Bot, Plus, X } from 'lucide-react';
import {
  MAX_TABS_PER_SESSION,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
} from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { requestAddressFocus } from '../../stores/addressFocusStore';
import { stripScrollToShow, stripWheelDelta, tabLabel } from './browserView';
import './styles.css';

interface BrowserTabStripProps {
  sessionId: string;
  snapshot: BrowserSessionSnapshot;
}

/** A failed tab action leaves the tabs as main has them: nothing to undo. */
function noteFailure(action: Promise<unknown>): void {
  action.catch((error: unknown) => console.warn('In-app browser action failed:', error));
}

/**
 * The session's tabs, in the look of the file preview's tab bar. Each action
 * goes to main, which owns the list and answers with a fresh snapshot; the
 * strip holds no state of its own. The `+` opens a blank tab, puts the caret
 * in its address bar, and stops at the cap. A tab an agent's call is on carries a
 * small marker for as long as the call runs.
 *
 * Tabs shrink to a narrow minimum before the strip scrolls, and the `+` sits
 * outside the scrolling part, so it is always in reach: it is the only way to
 * a blank tab. The active tab is kept in view, since a new tab, or one a link
 * opened, lands at the end.
 */
export function BrowserTabStrip({ sessionId, snapshot }: BrowserTabStripProps) {
  const atCap = snapshot.tabs.length >= MAX_TABS_PER_SESSION;
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabId = snapshot.activeTabId;

  // Before paint, so a new tab never shows cut off for a frame.
  useLayoutEffect(() => {
    const strip = tabsRef.current;
    if (!strip || !activeTabId) return;
    const active = strip.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!active) return;
    const stripBox = strip.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    const start = box.left - stripBox.left + strip.scrollLeft;
    strip.scrollLeft = stripScrollToShow(
      { scrollLeft: strip.scrollLeft, width: strip.clientWidth },
      { start, end: start + box.width },
    );
  }, [activeTabId]);

  return (
    <div className="browser-tab-strip">
      <div
        ref={tabsRef}
        className="browser-tabs"
        role="tablist"
        aria-label="Browser tabs"
        onWheel={(event) => {
          const strip = event.currentTarget;
          strip.scrollLeft += stripWheelDelta(event, strip.clientWidth);
        }}
      >
        {snapshot.tabs.map((tab) => (
          <StripTab key={tab.id} tab={tab} active={tab.id === activeTabId} />
        ))}
      </div>
      <button
        type="button"
        className="browser-tab-new"
        aria-label="New tab"
        title={atCap ? `At most ${MAX_TABS_PER_SESSION} tabs` : 'New tab'}
        disabled={atCap}
        onClick={() =>
          noteFailure(
            browserBridge.open(sessionId, '').then((opened) => {
              // The person's own click: the caret goes where the address is typed.
              if (opened) requestAddressFocus(opened.id);
            }),
          )
        }
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * One tab. Its × is for the pointer only: a tab's content is presentational,
 * so a button inside it would be a control nobody's assistive technology
 * could reach. The keyboard closes the focused tab with Delete (Backspace on
 * a Mac keyboard), on every platform, as a tab list's own key for it.
 */
function StripTab({ tab, active }: { tab: BrowserTabSnapshot; active: boolean }) {
  const label = tabLabel(tab);
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-keyshortcuts="Delete Backspace"
      className="browser-tab"
      data-tab-id={tab.id}
      onClick={() => noteFailure(browserBridge.activate(tab.id))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          noteFailure(browserBridge.activate(tab.id));
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          noteFailure(browserBridge.close(tab.id));
        }
      }}
      // A middle press would start the platform's autoscroll; the close is on release.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        noteFailure(browserBridge.close(tab.id));
      }}
    >
      {tab.agentActive && (
        <span className="browser-tab-agent" role="img" aria-label="An agent is using this tab">
          <Bot size={12} aria-hidden="true" />
        </span>
      )}
      <span className="browser-tab-label">{label}</span>
      <span
        className="browser-tab-close"
        aria-hidden="true"
        title="Close tab"
        onClick={(event) => {
          event.stopPropagation();
          noteFailure(browserBridge.close(tab.id));
        }}
      >
        <X size={12} />
      </span>
    </div>
  );
}

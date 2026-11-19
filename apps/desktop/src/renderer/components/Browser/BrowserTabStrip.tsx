import { Plus, X } from 'lucide-react';
import {
  MAX_TABS_PER_SESSION,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
} from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { tabLabel } from './browserView';
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
 * strip holds no state of its own. The `+` opens a blank tab for the address
 * bar to fill, and stops at the cap.
 */
export function BrowserTabStrip({ sessionId, snapshot }: BrowserTabStripProps) {
  const atCap = snapshot.tabs.length >= MAX_TABS_PER_SESSION;
  return (
    <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
      {snapshot.tabs.map((tab) => (
        <StripTab key={tab.id} tab={tab} active={tab.id === snapshot.activeTabId} />
      ))}
      <button
        type="button"
        className="browser-tab-new"
        aria-label="New tab"
        title={atCap ? `At most ${MAX_TABS_PER_SESSION} tabs` : 'New tab'}
        disabled={atCap}
        onClick={() => noteFailure(browserBridge.open(sessionId, ''))}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function StripTab({ tab, active }: { tab: BrowserTabSnapshot; active: boolean }) {
  const label = tabLabel(tab);
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      className="browser-tab"
      data-tab-id={tab.id}
      onClick={() => noteFailure(browserBridge.activate(tab.id))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          noteFailure(browserBridge.activate(tab.id));
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
      <span className="browser-tab-label">{label}</span>
      <button
        type="button"
        className="browser-tab-close"
        aria-label={`Close ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          noteFailure(browserBridge.close(tab.id));
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

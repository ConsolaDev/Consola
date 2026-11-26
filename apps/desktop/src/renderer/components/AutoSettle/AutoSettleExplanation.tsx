import * as Dialog from '@radix-ui/react-dialog';
import { preferencesBridge } from '../../services/preferencesBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { AutoSettleControl } from './AutoSettleControl';
import { settledSessionsFor } from './settledSessions';
import '../Dialogs/styles.css';

const LISTED = 6;

/**
 * Tells the person, the first time it happens, that sessions were moved out of
 * their list on their own. A panel rather than a toast: the surprise of a
 * session leaving the list is the bug, and a message that vanishes in five
 * seconds fixes nothing. Main holds what is unexplained until someone
 * acknowledges it, so this fires once per install, in whichever window is
 * open first, and survives the app being closed before anyone looked.
 */
export function AutoSettleExplanation() {
  const pending = usePreferencesStore((state) => state.pendingAutoSettle);
  const explained = usePreferencesStore((state) => state.hasExplainedAutoSettle);
  const days = usePreferencesStore((state) => state.autoSettleDays);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const moved = explained ? [] : settledSessionsFor(pending, workspaces);
  const open = moved.length > 0;

  const acknowledge = () => void preferencesBridge.acknowledgeAutoSettle();
  const showShelf = () => {
    useNavigationStore.getState().setSidebarHidden(false);
    useSettingsStore.getState().toggleSidebarShelf('settled', true);
    acknowledge();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) acknowledge();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="auto-settle-explanation">
          <Dialog.Title className="dialog-title">
            {moved.length === 1 ? 'A session was settled' : `${moved.length} sessions were settled`}
          </Dialog.Title>
          <div id="auto-settle-explanation" className="dialog-description">
            <p>
              Sessions that sit idle for {days === 1 ? 'a day' : `${days} days`} move to the{' '}
              <strong>Settled</strong> shelf at the bottom of the sidebar, so the list stays about
              what is happening now. <strong>Nothing you worked in was deleted:</strong> only a
              session that never had a message, and has no page open, is removed. Open one, or send
              it a message, and it comes straight back.
            </p>
            <p>Just moved:</p>
            <ul className="auto-settle-list">
              {moved.slice(0, LISTED).map((session) => (
                <li key={session.id}>
                  {session.name}{' '}
                  <span className="auto-settle-workspace">{session.workspaceName}</span>
                </li>
              ))}
              {moved.length > LISTED && <li>and {moved.length - LISTED} more</li>}
            </ul>
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="auto-settle-days">
                Settle idle sessions
              </label>
              <AutoSettleControl id="auto-settle-days" />
              <span className="auto-settle-hint">
                You can change this any time in Settings, or keep one session out of Settled from
                its menu.
              </span>
            </div>
          </div>
          <div className="dialog-actions">
            <button type="button" className="dialog-button-secondary" onClick={showShelf}>
              Show Settled
            </button>
            <button type="button" className="dialog-button-primary" onClick={acknowledge}>
              Got it
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { useId, useState } from 'react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ClearBrowsingDataDialog } from '../Browser/ClearBrowsingDataDialog';

/**
 * The workspace's in-app browser: whether its agents may use it, and its
 * logins, which live in a partition of their own, shared by the workspace's
 * sessions and by nothing else.
 */
export function BrowserSettingsPanel({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const [confirming, setConfirming] = useState(false);
  const id = useId();
  const agentsAllowed = workspace.browserAgentAccess !== 'off';

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Browser</h3>
      </div>
      <label className="ws-switch-row" htmlFor={`${id}-agents`}>
        <input
          id={`${id}-agents`}
          type="checkbox"
          role="switch"
          checked={agentsAllowed}
          aria-checked={agentsAllowed}
          // Absent means on: turning it back on removes the field.
          onChange={(event) =>
            void updateWorkspace(workspace.id, {
              browserAgentAccess: event.target.checked ? undefined : 'off',
            })
          }
        />
        <span className="ws-switch-text">
          <span className="ws-switch-label">Let agents use this workspace's browser</span>
          <span className="ws-switch-hint">
            A session's agent can open, read and screenshot pages in its own session's tabs. It
            never opens the panel or takes your keyboard. Read-only sessions never can.
          </span>
        </span>
      </label>
      <div className="ws-danger-row">
        <p className="ws-panel-hint">
          Sites you sign in to are remembered for this workspace only: its sessions share them, no
          other workspace sees them, and neither does Consola. Clearing removes the cookies, site
          storage, cache, visited pages and approved certificates.
        </p>
        <button
          type="button"
          className="dialog-button-secondary"
          onClick={() => setConfirming(true)}
        >
          Clear browsing data…
        </button>
      </div>
      <ClearBrowsingDataDialog open={confirming} onOpenChange={setConfirming} />
    </section>
  );
}

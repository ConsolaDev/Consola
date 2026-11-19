import { useState } from 'react';
import { ClearBrowsingDataDialog } from '../Browser/ClearBrowsingDataDialog';

/**
 * The workspace's in-app browser. Its logins live in a partition of their own,
 * shared by the workspace's sessions and by nothing else.
 */
export function BrowserSettingsPanel() {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Browser</h3>
      </div>
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

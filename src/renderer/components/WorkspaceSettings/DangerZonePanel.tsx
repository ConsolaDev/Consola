import { useState } from 'react';
import { type Workspace } from '../../stores/workspaceStore';
import { DeleteWorkspaceDialog } from '../Dialogs/DeleteWorkspaceDialog';

interface DangerZonePanelProps {
  workspace: Workspace;
}

/** One quiet, deliberate way out. The confirmation names what goes and what stays. */
export function DangerZonePanel({ workspace }: DangerZonePanelProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="ws-panel ws-panel--danger">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Danger zone</h3>
      </div>
      <div className="ws-danger-row">
        <p className="ws-panel-hint">
          Removes this workspace and its session records from Consola. Folders on
          disk and conversation transcripts stay where they are.
        </p>
        <button type="button" className="ws-danger-button" onClick={() => setConfirming(true)}>
          Delete workspace…
        </button>
      </div>

      <DeleteWorkspaceDialog
        workspace={workspace}
        open={confirming}
        onOpenChange={setConfirming}
      />
    </section>
  );
}

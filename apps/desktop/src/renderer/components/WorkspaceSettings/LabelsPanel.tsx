import { useState } from 'react';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import type { Label } from '../../../shared/workspace';
import { EditLabelDialog } from '../Dialogs/EditLabelDialog';
import { NewLabelDialog } from '../Dialogs/NewLabelDialog';

interface LabelsPanelProps {
  workspace: Workspace;
}

/**
 * The workspace's labels: add, rename, set an emoji, delete. A label is a
 * filter on the sidebar list, so the panel says how many sessions carry each.
 * Deleting one takes its id off the sessions that had it and nothing else;
 * the sessions themselves stay.
 */
export function LabelsPanel({ workspace }: LabelsPanelProps) {
  const deleteLabel = useWorkspaceStore((state) => state.deleteLabel);
  const [editing, setEditing] = useState<Label | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const memberCountFor = (labelId: string) =>
    workspace.sessions.filter((session) => session.labelIds?.includes(labelId)).length;

  const remove = async (label: Label) => {
    setError('');
    try {
      await deleteLabel(workspace.id, label.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Labels</h3>
        <button
          type="button"
          className="dialog-button-secondary ws-panel-action"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} />
          Add label
        </button>
      </div>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {workspace.labels.length === 0 ? (
        <p className="ws-panel-hint">
          No labels yet. A label tags sessions that belong together, and narrows the sidebar list to
          them from the filter bar.
        </p>
      ) : (
        <div className="ws-row-list">
          {workspace.labels.map((label) => {
            const members = memberCountFor(label.id);
            return (
              <div key={label.id} className="ws-row">
                <span className="ws-row-icon">
                  <span className="group-emoji" aria-hidden="true">
                    {label.emoji || <Tag size={13} />}
                  </span>
                </span>
                <span className="ws-row-name">{label.name}</span>
                {members > 0 && (
                  <span className="ws-row-chip">
                    {members} session{members === 1 ? '' : 's'}
                  </span>
                )}
                <button
                  type="button"
                  className="ws-row-action"
                  onClick={() => setEditing(label)}
                  aria-label={`Rename label ${label.name}`}
                  title="Rename label"
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="ws-row-action"
                  onClick={() => void remove(label)}
                  aria-label={`Delete label ${label.name}`}
                  title="Delete label — its sessions stay, without it"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <EditLabelDialog
          workspaceId={workspace.id}
          label={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {creating && <NewLabelDialog workspaceId={workspace.id} onClose={() => setCreating(false)} />}
    </section>
  );
}

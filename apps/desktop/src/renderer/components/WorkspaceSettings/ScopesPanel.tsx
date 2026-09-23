import { useState } from 'react';
import { Folder, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react';
import { type Scope, type Workspace } from '../../stores/workspaceStore';
import { addScopeViaDialog, deleteScopeCompletely } from '../../utils/scopeActions';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';
import { ScopeEditor } from './ScopeEditor';

interface ScopesPanelProps {
  workspace: Workspace;
}

/** The folders this workspace's sessions run in. */
export function ScopesPanel({ workspace }: ScopesPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAddScope = async () => {
    setError(null);
    try {
      await addScopeViaDialog(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sessionCountFor = (scopeId: string) =>
    workspace.sessions.filter((session) => session.scopeId === scopeId).length;

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Scopes</h3>
        <button type="button" className="dialog-button-secondary ws-panel-action" onClick={() => void handleAddScope()}>
          <Plus size={14} />
          Add scope
        </button>
      </div>
      <p className="ws-panel-hint">
        {workspace.scopes.length === 0
          ? 'No scopes yet. Add a scope to start a session in this workspace.'
          : 'Edit a scope to change its name or folder location. Deleting a scope never deletes the folder on disk.'}
      </p>
      <div className="ws-row-list">
        {workspace.scopes.map((scope) => {
          const sessionCount = sessionCountFor(scope.id);
          return (
            <div key={scope.id} className="ws-scope-card">
              <div className="ws-row ws-scope-row">
                <span className="ws-row-icon">
                  {scope.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                </span>
                <div className="ws-scope-details">
                  <span className="ws-row-name">{scope.name}</span>
                  <span className="ws-row-path" title={scope.path}>{scope.path}</span>
                </div>
                {sessionCount > 0 && (
                  <span className="ws-row-chip">{sessionCount} session{sessionCount === 1 ? '' : 's'}</span>
                )}
                <button type="button" className="dialog-button-secondary ws-panel-action"
                  onClick={() => setEditingId(scope.id)} aria-label={`Edit scope ${scope.name}`}
                  disabled={editingId !== null}>
                  <Pencil size={13} /> Edit
                </button>
                <button type="button" className="dialog-button-secondary ws-panel-action ws-scope-remove"
                  onClick={() => setRemoving(scope)} disabled={editingId !== null}
                  aria-label={`Delete scope ${scope.name}`}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
              {editingId === scope.id && (
                <ScopeEditor workspaceId={workspace.id} scope={scope} onClose={() => setEditingId(null)} />
              )}
            </div>
          );
        })}
      </div>
      {error && <span className="dialog-error">{error}</span>}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Delete scope “${removing?.name ?? ''}”?`}
        description={
          `This will delete this scope and all ${removing ? sessionCountFor(removing.id) : 0} of its sessions from Consola, ` +
          'including sessions in groups. Running sessions will be stopped. This cannot be undone. ' +
          'Groups, folders on disk, and conversation transcripts will be kept.'
        }
        confirmLabel="Delete scope"
        destructive
        confirmationText="delete"
        onConfirm={async () => {
          if (removing) await deleteScopeCompletely(workspace.id, removing.id);
        }}
      />
    </section>
  );
}

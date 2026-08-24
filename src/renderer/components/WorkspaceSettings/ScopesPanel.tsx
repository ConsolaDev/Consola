import { useState } from 'react';
import { Folder, GitBranch, Pencil, Plus, X } from 'lucide-react';
import { useWorkspaceStore, type Scope, type Workspace } from '../../stores/workspaceStore';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';
import { InlineRename } from './InlineRename';

interface ScopesPanelProps {
  workspace: Workspace;
}

/**
 * The folders this workspace's sessions run in. Add and remove reuse the
 * sidebar's exact flows and guards; rename is new. A scope that cannot be
 * removed says why in place instead of hiding the button.
 */
export function ScopesPanel({ workspace }: ScopesPanelProps) {
  const updateScope = useWorkspaceStore((state) => state.updateScope);
  const removeScope = useWorkspaceStore((state) => state.removeScope);

  const [renamingId, setRenamingId] = useState<string | null>(null);
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
        The folders sessions run in. Removing one never touches the folder itself.
      </p>
      <div className="ws-row-list">
        {workspace.scopes.map((scope) => {
          const sessionCount = sessionCountFor(scope.id);
          const isLastScope = workspace.scopes.length <= 1;
          const removable = !isLastScope && sessionCount === 0;
          const removeReason = isLastScope
            ? 'A workspace needs at least one scope.'
            : sessionCount > 0
              ? `${sessionCount} session${sessionCount === 1 ? '' : 's'} still run${sessionCount === 1 ? 's' : ''} here — close ${sessionCount === 1 ? 'it' : 'them'} first.`
              : `Remove scope ${scope.name}`;
          return (
            <div key={scope.id} className="ws-row" title={scope.path}>
              <span className="ws-row-icon">
                {scope.isGitRepo ? <GitBranch size={13} /> : <Folder size={13} />}
              </span>
              {renamingId === scope.id ? (
                <InlineRename
                  value={scope.name}
                  ariaLabel={`Rename scope ${scope.name}`}
                  onSubmit={(name) => updateScope(workspace.id, scope.id, { name })}
                  onClose={() => setRenamingId(null)}
                />
              ) : (
                <>
                  <span className="ws-row-name">{scope.name}</span>
                  <span className="ws-row-path">{scope.path}</span>
                  {sessionCount > 0 && (
                    <span className="ws-row-chip">
                      {sessionCount} session{sessionCount === 1 ? '' : 's'}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ws-row-action"
                    onClick={() => setRenamingId(scope.id)}
                    aria-label={`Rename scope ${scope.name}`}
                    title="Rename"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="ws-row-action ws-row-action-danger"
                    onClick={() => setRemoving(scope)}
                    disabled={!removable}
                    aria-label={`Remove scope ${scope.name}`}
                    title={removeReason}
                  >
                    <X size={13} />
                  </button>
                </>
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
        title={`Remove scope “${removing?.name ?? ''}”?`}
        description="Sessions can no longer be started here. The folder on disk is untouched."
        confirmLabel="Remove scope"
        destructive
        onConfirm={async () => {
          if (removing) await removeScope(workspace.id, removing.id);
        }}
      />
    </section>
  );
}

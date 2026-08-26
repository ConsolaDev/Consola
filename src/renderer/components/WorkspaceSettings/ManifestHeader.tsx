import { useEffect, useState } from 'react';
import { PROVIDER_META } from '../../../shared/providers';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useHarnessStore } from '../../stores/harnessStore';

interface ManifestHeaderProps {
  workspace: Workspace;
}

/**
 * The workspace's passport: its name, editable in place, over a quiet
 * monospace row of its vital facts. The panels below are the editors of each
 * fact; this header is what they add up to.
 */
export function ManifestHeader({ workspace }: ManifestHeaderProps) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const harnesses = useHarnessStore((state) => state.harnesses);

  const [draftName, setDraftName] = useState(workspace.name);
  const [isSaving, setIsSaving] = useState(false);

  // Follow the stored name whenever it changes elsewhere — another window
  // renaming this workspace must not lose to a stale draft here.
  useEffect(() => {
    setDraftName(workspace.name);
  }, [workspace.id, workspace.name]);

  const trimmed = draftName.trim();
  const isDirty = trimmed.length > 0 && trimmed !== workspace.name;

  const save = async () => {
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    try {
      await updateWorkspace(workspace.id, { name: trimmed });
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      void save();
    } else if (event.key === 'Escape') {
      setDraftName(workspace.name);
    }
  };

  const harness = harnesses.find((candidate) => candidate.id === workspace.defaultHarnessId);
  const scopeCount = workspace.scopes.length;
  const sessionCount = workspace.sessions.length;

  return (
    <div className="ws-manifest">
      <div className="ws-manifest-name-row">
        <input
          type="text"
          className="ws-manifest-name-input"
          aria-label="Workspace name"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        {isDirty && (
          <button
            type="button"
            className="dialog-button-primary ws-manifest-save"
            onClick={() => void save()}
            disabled={isSaving}
          >
            Rename
          </button>
        )}
      </div>
      <div className="ws-manifest-facts" aria-label="Workspace summary">
        <span className="ws-fact">
          {scopeCount} scope{scopeCount === 1 ? '' : 's'}
        </span>
        <span className="ws-fact">
          {sessionCount} session{sessionCount === 1 ? '' : 's'}
        </span>
        <span className="ws-fact">
          {harness && (
            <span
              className="workspace-harness-dot"
              style={{ background: harness.accentColor }}
              aria-hidden="true"
            />
          )}
          {harness?.name ?? workspace.defaultHarnessId}
        </span>
        {workspace.provider && (
          <span className="ws-fact">
            {PROVIDER_META[workspace.provider.id].cliName} {workspace.provider.accountLogin}
          </span>
        )}
      </div>
    </div>
  );
}

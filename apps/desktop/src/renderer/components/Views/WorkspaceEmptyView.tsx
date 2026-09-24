import { useState } from 'react';
import { Folder, FolderPlus, GitFork, Inbox } from 'lucide-react';
import type { Workspace, Scope } from '../../../shared/workspace';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { createQuickSession, openNewSessionDialog } from '../../utils/sessionActions';
import './styles.css';
import './new-session.css';

export function WorkspaceEmptyView({ workspace }: { workspace: Workspace }) {
  const selectedScopeId = useHomeStore(state => state.scopeIds[workspace.id]);
  const scope = homeScope(workspace, selectedScopeId);
  return <div className="workspace-empty-view">
    <div className="workspace-empty-content">
      <h1 className="workspace-empty-heading">{workspace.name}</h1>
      <p>Start a session or select one from the sidebar.</p>
      <div className="dialog-actions">
        <button className="dialog-button-primary" disabled={!scope} onClick={() => void createQuickSession(workspace.id)}>New session</button>
        <button className="dialog-button-secondary" onClick={() => openNewSessionDialog(workspace.id)}>New session with options…</button>
      </div>
      {workspace.sessions.length === 0 && scope && <FirstSessionTips workspace={workspace} scope={scope} />}
    </div>
  </div>;
}

/**
 * Workspace pointers, shown only before a workspace's first
 * session. Derived from the workspace rather than dismissed: it goes away by
 * itself once there is a session, which is exactly when it stops being news.
 */
function FirstSessionTips({ workspace, scope }: { workspace: Workspace; scope: Scope }) {
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const [error, setError] = useState('');
  const addScope = async () => {
    setError('');
    try {
      const added = await addScopeViaDialog(workspace.id);
      if (added) useHomeStore.getState().selectScope(workspace.id, added.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <section className="first-session-tips" aria-label="Before your first session">
    <div className="first-session-tip">
      <Folder size={14} aria-hidden="true" />
      <p>Runs in the <strong>{scope.name}</strong> scope.{' '}
        {workspace.scopes.length > 1
          ? 'Choose a different folder from the scope menu in the sidebar.'
          : <>Working across repos? <button type="button" className="first-session-link" onClick={() => void addScope()}><FolderPlus size={12} aria-hidden="true" />Add another folder</button> as a scope.</>}
      </p>
    </div>
    {scope.isGitRepo && <div className="first-session-tip">
      <GitFork size={14} aria-hidden="true" />
      <p>Running several sessions at once? Choose <strong>New worktree</strong> in session options so they don't edit the same checkout.</p>
    </div>}
    {!workspace.provider && <div className="first-session-tip">
      <Inbox size={14} aria-hidden="true" />
      <p><button type="button" className="first-session-link" onClick={() => openWorkspaceSettings(workspace.id, 'provider')}>Connect GitHub</button> to get an Inbox of issues and pull requests you can start sessions from.</p>
    </div>}
    {error && <p className="sidebar-error" role="alert">{error}</p>}
  </section>;
}

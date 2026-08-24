import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { GitHubBindingPanel } from '../GitHub';
import { ManifestHeader } from './ManifestHeader';
import { HarnessPanel } from './HarnessPanel';
import { ScopesPanel } from './ScopesPanel';
import { GroupsPanel } from './GroupsPanel';
import { DangerZonePanel } from './DangerZonePanel';
import './styles.css';

/**
 * The Workspace settings section: everything one workspace is, in the order
 * the domain model tells it — identity, engine, places, allegiance, history,
 * end of life. Scoped to the active workspace, like the GitHub binding
 * always was.
 *
 * Keyed by workspace id so switching workspaces remounts every panel: no
 * draft, open rename or pending confirmation survives into another
 * workspace's record.
 */
export function WorkspaceSettingsSection() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;

  if (!workspace) {
    return (
      <div className="settings-modal-section">
        <h2 className="settings-modal-section-title">Workspace</h2>
        <p className="ws-panel-hint">Open a workspace to manage it here.</p>
      </div>
    );
  }

  return (
    <div className="settings-modal-section" key={workspace.id}>
      <h2 className="settings-modal-section-title">Workspace</h2>
      <ManifestHeader workspace={workspace} />
      <HarnessPanel workspace={workspace} />
      <ScopesPanel workspace={workspace} />
      <section className="ws-panel">
        <GitHubBindingPanel workspace={workspace} />
      </section>
      <GroupsPanel workspace={workspace} />
      <DangerZonePanel workspace={workspace} />
    </div>
  );
}

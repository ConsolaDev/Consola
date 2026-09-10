import { Plus } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { dialogBridge } from '../../services/dialogBridge';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { isMac } from '../../utils/platform';
import { WorkspaceIcon } from '../WorkspaceIcon';

export function WorkspaceRail() {
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const setActiveWorkspace = useNavigationStore(state => state.setActiveWorkspace);
  const terminals = useTerminalStore(state => state.terminals);

  const addWorkspace = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    const workspace = await useWorkspaceStore.getState().createWorkspace(folder.name, folder.path, folder.isGitRepo);
    await setActiveWorkspace(workspace.id);
  };

  return (
    <Tooltip.Provider delayDuration={200}>
      <nav className="workspace-rail" aria-label="Workspaces">
        {workspaces.map((workspace, index) => {
          const needsAttention = workspace.sessions.some(
            session => sessionStatusFor(terminals[session.instanceId]) === 'needs-attention'
          );
          const shortcut = index < 9 ? index + 1 : null;
          return (
            <Tooltip.Root key={workspace.id}>
              <Tooltip.Trigger asChild>
                <button
                  className="workspace-rail-item"
                  aria-label={workspace.name}
                  aria-current={workspace.id === activeWorkspaceId ? 'true' : undefined}
                  aria-description={needsAttention ? 'A prompt needs your attention' : undefined}
                  aria-keyshortcuts={shortcut ? `${isMac ? 'Meta' : 'Control'}+${shortcut}` : undefined}
                  onClick={() => void setActiveWorkspace(workspace.id)}
                >
                  <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={32} borderRadius={8} />
                  {needsAttention && <span className="workspace-rail-attention" aria-hidden="true" />}
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="workspace-tooltip" side="right" sideOffset={12} collisionPadding={8}>
                  <span className="workspace-tooltip-details">
                    <span className="workspace-tooltip-name">{workspace.name}</span>
                    {needsAttention && <span className="workspace-tooltip-attention">A prompt needs your attention</span>}
                  </span>
                  {shortcut && <span className="workspace-tooltip-shortcut">
                    <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>{shortcut}</kbd>
                  </span>}
                  <Tooltip.Arrow className="workspace-tooltip-arrow" width={10} height={6} />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
        <button className="workspace-rail-add" aria-label="Add workspace" title="Add workspace" onClick={() => void addWorkspace()}>
          <Plus size={24} />
        </button>
      </nav>
    </Tooltip.Provider>
  );
}

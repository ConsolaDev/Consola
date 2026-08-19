import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Plus,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { dialogBridge } from '../../services/dialogBridge';
import { windowBridge } from '../../services/windowBridge';
import { anyOtherWorkspaceNeedsAttention, workspaceStatusFor } from '../../utils/sessionStatus';

/**
 * The workspace this window holds, and the way to change it.
 *
 * It carries the one signal the sidebar used to own: that a session in a
 * workspace you are not looking at is waiting on you. Without the dot, scoping
 * a window to one workspace would make that invisible until you went looking.
 */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);
  const terminals = useTerminalStore((state) => state.terminals);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);

  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const elsewhere = anyOtherWorkspaceNeedsAttention(workspaces, activeWorkspaceId, terminals);
  const selectableHarnesses = harnesses.filter(isSelectableHarness);

  const handleAddWorkspace = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    const workspace = await useWorkspaceStore
      .getState()
      .createWorkspace(folder.name, folder.path, folder.isGitRepo);
    await setActiveWorkspace(workspace.id);
  };

  const handleDelete = async () => {
    if (!active) return;
    if (!window.confirm(`Are you sure you want to delete "${active.name}"?`)) return;
    // Main drops this window's workspace when the record disappears, so there
    // is nothing to clear here.
    await deleteWorkspace(active.id);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="workspace-switcher"
          aria-label={
            elsewhere
              ? 'Switch workspace — another workspace needs attention'
              : 'Switch workspace'
          }
        >
          <span className="workspace-switcher-icon">
            {active?.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
          </span>
          <span className="workspace-switcher-name">{active?.name ?? 'Select workspace'}</span>
          {/* Decorative: the button's own aria-label already carries this state.
              An ancestor's aria-label short-circuits the accessible-name
              computation before it descends into subtree content, so a label
              on this span would never reach assistive technology. */}
          {elsewhere && <span className="workspace-switcher-elsewhere" aria-hidden="true" />}
          <ChevronDown size={14} className="workspace-switcher-chevron" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={6} align="start">
          {workspaces.map((workspace) => {
            const status = workspaceStatusFor(workspace, terminals);
            return (
              <DropdownMenu.Item
                key={workspace.id}
                className="dropdown-item"
                onSelect={() => void setActiveWorkspace(workspace.id)}
              >
                <span className="workspace-switcher-item-icon">
                  {workspace.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                </span>
                <span className="workspace-switcher-item-name">{workspace.name}</span>
                {status && (
                  <span className={`session-status-indicator session-status-indicator--${status}`} />
                )}
                <span className="workspace-switcher-item-count">{workspace.sessions.length}</span>
                {workspace.id === activeWorkspaceId && <Check size={14} />}
              </DropdownMenu.Item>
            );
          })}

          {workspaces.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void windowBridge.openWindow(null)}
            >
              <SquareArrowOutUpRight size={14} />
              <span>Open new window</span>
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Item className="dropdown-item" onSelect={() => void handleAddWorkspace()}>
            <Plus size={14} />
            <span>Add workspace…</span>
          </DropdownMenu.Item>

          {active && selectableHarnesses.length > 1 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item">
                <Boxes size={14} />
                <span>Default harness</span>
                <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="dropdown-content" sideOffset={4}>
                  {selectableHarnesses.map((harness) => (
                    <DropdownMenu.Item
                      key={harness.id}
                      className="dropdown-item"
                      onSelect={() =>
                        void updateWorkspace(active.id, { defaultHarnessId: harness.id })
                      }
                    >
                      <span
                        className="workspace-harness-dot"
                        style={{ background: harness.accentColor }}
                      />
                      <span>{harness.name}</span>
                      {harness.id === active.defaultHarnessId && (
                        <Check size={14} style={{ marginLeft: 'auto' }} />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item dropdown-item-destructive"
              onSelect={() => void handleDelete()}
            >
              <Trash2 size={14} />
              <span>Delete workspace</span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

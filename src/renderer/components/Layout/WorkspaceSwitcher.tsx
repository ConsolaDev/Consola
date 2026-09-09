import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  Plus,
  Settings,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { WorkspaceIcon } from '../WorkspaceIcon';
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

  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const elsewhere = anyOtherWorkspaceNeedsAttention(workspaces, activeWorkspaceId, terminals);
  const { openWorkspaceSettings } = useWorkspaceSettings();
  // One-shot: set as the item is chosen, read as the
  // menu closes, cleared on the next open so an ordinary dismissal refocuses
  // the trigger again.
  const [openingSettings, setOpeningSettings] = useState(false);

  const handleAddWorkspace = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    const workspace = await useWorkspaceStore
      .getState()
      .createWorkspace(folder.name, folder.path, folder.isGitRepo);
    await setActiveWorkspace(workspace.id);
  };

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) setOpeningSettings(false);
      }}
    >
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
            <WorkspaceIcon icon={active?.icon} name={active?.name} size={14} />
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
        <DropdownMenu.Content
          className="dropdown-content"
          sideOffset={6}
          align="start"
          // Selecting Workspace settings opens a dialog; the menu
          // refocusing its trigger would race the dialog's own focus grab
          // (see NewMenu).
          onCloseAutoFocus={(event) => {
            if (openingSettings) event.preventDefault();
          }}
        >
          {workspaces.map((workspace) => {
            const status = workspaceStatusFor(workspace, terminals);
            return (
              <DropdownMenu.Item
                key={workspace.id}
                className="dropdown-item"
                onSelect={() => void setActiveWorkspace(workspace.id)}
              >
                <span className="workspace-switcher-item-icon">
                  <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={14} />
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
              onSelect={() => {
                setOpeningSettings(true);
                openWorkspaceSettings(active.id);
              }}
            >
              <Settings size={14} />
              <span>Workspace settings…</span>
            </DropdownMenu.Item>
          )}

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

        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

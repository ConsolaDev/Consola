import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { windowBridge } from '../../services/windowBridge';
import type { WorkspaceSettingsSectionId } from '../WorkspaceSettings/WorkspaceSettingsModal';
import { providerNavLabel } from '../WorkspaceSettings/navLabels';
import { WorkspaceIcon } from '../WorkspaceIcon';

/** The named workspace owns this menu; switching lives in the navigation rail. */
export function WorkspaceMenu() {
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const workspace = useWorkspaceStore(state => state.workspaces.find(item => item.id === activeWorkspaceId));
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const openingSettings = useRef(false);

  if (!workspace) return <span className="workspace-menu-placeholder">Select workspace</span>;

  const openSection = (section: WorkspaceSettingsSectionId) => {
    openingSettings.current = true;
    openWorkspaceSettings(workspace.id, section);
  };

  return (
    <DropdownMenu.Root onOpenChange={open => { if (open) openingSettings.current = false; }}>
      <DropdownMenu.Trigger asChild>
        <button className="workspace-menu-trigger" aria-label={`${workspace.name} workspace menu`}>
          <span className="workspace-menu-name">{workspace.name}</span>
          <ChevronDown size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content workspace-menu-content"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={event => { if (openingSettings.current) event.preventDefault(); }}
        >
          <DropdownMenu.Label className="workspace-menu-identity">
            <span className="workspace-menu-avatar"><WorkspaceIcon icon={workspace.icon} name={workspace.name} size={40} /></span>
            <span className="workspace-menu-details">
              <span className="workspace-menu-title">{workspace.name}</span>
              <span className="workspace-menu-summary">
                {workspace.scopes.length} {workspace.scopes.length === 1 ? 'scope' : 'scopes'}
                {' · '}{workspace.sessions.length} {workspace.sessions.length === 1 ? 'session' : 'sessions'}
              </span>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('scopes')}>
            Manage scopes…
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('general')}>
            Workspace settings…
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="dropdown-item workspace-menu-tools">
              Tools <ChevronRight size={14} />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="dropdown-content workspace-tools-content" sideOffset={4} collisionPadding={8}>
                <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('provider')}>
                  {providerNavLabel(workspace)} settings…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('actions')}>Actions…</DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('groups')}>Groups…</DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item className="dropdown-item" onSelect={() => void windowBridge.openWindow(null)}>
            Open new window
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

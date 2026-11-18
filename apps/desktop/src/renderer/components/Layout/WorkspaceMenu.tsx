import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { windowBridge } from '../../services/windowBridge';
import type { SettingsSection } from '../Dialogs/settingsSections';
import { providerNavLabel } from '../WorkspaceSettings/navLabels';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { MenuHint } from './MenuHint';

/** The named workspace owns this menu; switching lives in the navigation rail. */
export function WorkspaceMenu() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((item) => item.id === activeWorkspaceId),
  );
  const { openSettings } = useSettings();
  const openingSettings = useRef(false);
  const [isOpen, setOpen] = useState(false);

  if (!workspace) return <span className="workspace-menu-placeholder">Select workspace</span>;
  const sessionCount = workspace.sessions.length;

  const openSection = (section: SettingsSection) => {
    openingSettings.current = true;
    openSettings(section);
  };

  return (
    <DropdownMenu.Root
      open={isOpen}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) openingSettings.current = false;
      }}
    >
      <MenuHint
        menuOpen={isOpen}
        title="Workspace"
        content={
          <>
            <p className="title-hint-lead">
              Everything in this window: its scopes, sessions and settings. Switch workspaces in the
              rail.
            </p>
            <span className="title-hint-meta">
              {workspace.scopes.length} {workspace.scopes.length === 1 ? 'scope' : 'scopes'}
              {' · '}
              {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
            </span>
          </>
        }
      >
        <DropdownMenu.Trigger asChild>
          <button
            className="workspace-menu-trigger"
            aria-label={`${workspace.name} workspace menu`}
          >
            {/* The rail's tile for this workspace, so the two read as one
                thing and the scope beside it reads as a folder. */}
            <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={16} borderRadius={5} />
            <span className="workspace-menu-name">{workspace.name}</span>
            <ChevronDown size={14} />
          </button>
        </DropdownMenu.Trigger>
      </MenuHint>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content workspace-menu-content"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (openingSettings.current) event.preventDefault();
          }}
        >
          <DropdownMenu.Label className="workspace-menu-identity">
            <span className="workspace-menu-avatar">
              <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={28} />
            </span>
            <span className="workspace-menu-details">
              <span className="workspace-menu-title">{workspace.name}</span>
              <span className="workspace-menu-summary">
                {workspace.scopes.length} {workspace.scopes.length === 1 ? 'scope' : 'scopes'}
                {' · '}
                {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
              </span>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('scopes')}>
            Manage scopes…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('general')}>
            Workspace settings…
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="dropdown-item workspace-menu-tools">
              Tools <ChevronRight size={14} />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                className="dropdown-content workspace-tools-content"
                sideOffset={4}
                collisionPadding={8}
              >
                <DropdownMenu.Item
                  className="dropdown-item"
                  onSelect={() => openSection('provider')}
                >
                  {providerNavLabel(workspace)} settings…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="dropdown-item"
                  onSelect={() => openSection('actions')}
                >
                  Actions…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={() => openSection('labels')}>
                  Labels…
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={() => void windowBridge.openWindow(null)}
          >
            Open new window
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

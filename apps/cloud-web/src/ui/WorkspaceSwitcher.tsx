import { DropdownMenu } from '@radix-ui/themes';
import { ChevronDown, Plus, Settings } from 'lucide-react';
import { useRef, useState } from 'react';
import { messageForSwitchFailure, WORKSPACES_UNAVAILABLE } from '../domain/messages';
import { type MyWorkspace, regionName, roleName } from '../domain/workspace';
import { switchWorkspace } from '../services/api';
import { openSettingsPage } from '../services/settingsAddress';
import { WorkspaceIcon } from './WorkspaceIcon';

/** The settings page "Workspace settings…" opens: the workspace's own, General. */
const WORKSPACE_SETTINGS_PAGE = 'general';

/**
 * The workspace's menu, as the desktop app's (`Layout/WorkspaceMenu.tsx`): its trigger is the
 * workspace's icon and name, and it opens on who the workspace is, then Workspace settings…
 * (`withSettings`, only where Settings can open), then the person's other workspaces to switch
 * to, and Create workspace…. `workspaces` is null when they could not be listed. After a switch
 * the page loads again (`onSwitched`), since what it shows belongs to the workspace.
 */
export function WorkspaceSwitcher({
  active,
  workspaces,
  onSwitched,
  onCreate,
  withSettings = false,
}: {
  active: MyWorkspace | null;
  workspaces: MyWorkspace[] | null;
  onSwitched: () => Promise<void>;
  onCreate: () => void;
  withSettings?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Settings takes the keyboard as it opens, so the menu must not hand it back to its trigger.
  const openingSettings = useRef(false);

  async function open(workspaceId: string) {
    if (workspaceId === active?.id) return;
    setPending(true);
    setFailure(null);
    const answer = await switchWorkspace(workspaceId);
    if (answer.kind === 'not-found' || answer.kind === 'unavailable') {
      setFailure(messageForSwitchFailure(answer));
    }
    // A workspace not found may have left the list, and signed out shows the sign-in card.
    if (answer.kind !== 'unavailable') await onSwitched();
    setPending(false);
  }

  return (
    <>
      <DropdownMenu.Root
        onOpenChange={(isOpen) => {
          if (isOpen) openingSettings.current = false;
        }}
      >
        <DropdownMenu.Trigger disabled={pending}>
          <button
            type="button"
            className="switcher-trigger"
            aria-label={active ? `${active.name} workspace menu` : 'Open a workspace'}
          >
            {active && (
              <span className="icon-slot">
                <WorkspaceIcon icon={active.icon} name={active.name} size={16} />
              </span>
            )}
            <span className="switcher-name">{active?.name ?? 'Open a workspace'}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          align="start"
          variant="soft"
          color="gray"
          className="workspace-menu"
          onCloseAutoFocus={(event) => {
            if (openingSettings.current) event.preventDefault();
          }}
        >
          {active && (
            <>
              <div className="workspace-menu-identity">
                <span className="workspace-menu-avatar">
                  <WorkspaceIcon icon={active.icon} name={active.name} size={20} />
                </span>
                <span className="workspace-menu-details">
                  <span className="workspace-menu-title">{active.name}</span>
                  <span className="workspace-menu-summary">
                    {regionName(active.region)} region · {roleName(active.role)}
                  </span>
                </span>
              </div>
              {withSettings && (
                <DropdownMenu.Item
                  onSelect={() => {
                    openingSettings.current = true;
                    openSettingsPage(WORKSPACE_SETTINGS_PAGE);
                  }}
                >
                  <Settings size={16} aria-hidden="true" />
                  Workspace settings…
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator />
            </>
          )}
          {workspaces === null ? (
            <DropdownMenu.Label>{WORKSPACES_UNAVAILABLE}</DropdownMenu.Label>
          ) : (
            <>
              <DropdownMenu.Label>Switch workspace</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={active?.id ?? ''}
                onValueChange={(workspaceId) => void open(workspaceId)}
              >
                {workspaces.map((workspace) => (
                  <DropdownMenu.RadioItem key={workspace.id} value={workspace.id}>
                    <span className="icon-slot">
                      <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={16} />
                    </span>
                    <span className="switcher-item-name">{workspace.name}</span>
                    <span className="switcher-item-region">{regionName(workspace.region)}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={onCreate}>
            <Plus size={16} aria-hidden="true" />
            Create workspace…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

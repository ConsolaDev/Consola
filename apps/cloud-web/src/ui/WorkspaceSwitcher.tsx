import { DropdownMenu } from '@radix-ui/themes';
import { useState } from 'react';
import { messageForSwitchFailure, WORKSPACES_UNAVAILABLE } from '../domain/messages';
import { type MyWorkspace, regionName } from '../domain/workspace';
import { switchWorkspace } from '../services/api';

/**
 * The topbar's menu of the person's workspaces: picking one opens it, and the last item opens
 * the create form. `workspaces` is null when they could not be listed. After a switch the page
 * loads again (`onSwitched`), since what it shows belongs to the workspace.
 */
export function WorkspaceSwitcher({
  active,
  workspaces,
  onSwitched,
  onCreate,
}: {
  active: MyWorkspace | null;
  workspaces: MyWorkspace[] | null;
  onSwitched: () => Promise<void>;
  onCreate: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={pending}>
          <button type="button" className="switcher-trigger">
            <span className="switcher-name">{active?.name ?? 'Open a workspace'}</span>
            <DropdownMenu.TriggerIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" className="switcher-menu">
          {workspaces === null ? (
            <DropdownMenu.Label>{WORKSPACES_UNAVAILABLE}</DropdownMenu.Label>
          ) : (
            <DropdownMenu.RadioGroup
              value={active?.id ?? ''}
              onValueChange={(workspaceId) => void open(workspaceId)}
            >
              {workspaces.map((workspace) => (
                <DropdownMenu.RadioItem key={workspace.id} value={workspace.id}>
                  <span className="switcher-item-name">{workspace.name}</span>
                  <span className="switcher-item-region">{regionName(workspace.region)}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={onCreate}>Create workspace…</DropdownMenu.Item>
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

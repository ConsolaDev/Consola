import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { createQuickSession } from '../../utils/sessionActions';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { FanOutDialog } from '../Dialogs/FanOutDialog';
import { OrchestrationDialog } from '../Dialogs/OrchestrationDialog';

/**
 * The ＋ New menu: everything that creates work, in one place, in increasing
 * order of machinery — a session, a group, a fan-out, and an orchestration.
 * This is the whole creation surface a casual user ever sees.
 */
export function NewMenu() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  // The orchestration door generates a conductor directory inside a scope, so
  // a workspace with none has nowhere to put one.
  const scopeCount = useWorkspaceStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.scopes.length ?? 0
  );
  const [openDialog, setOpenDialog] = useState<'group' | 'fan-out' | 'orchestration' | null>(null);

  if (!activeWorkspaceId) return null;

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="new-menu-trigger" aria-label="New">
            <Plus size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content"
            sideOffset={6}
            align="start"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void createQuickSession(activeWorkspaceId)}
            >
              <span>New session…</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>⌘N</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => setOpenDialog('group')}>
              <span>New group</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => setOpenDialog('fan-out')}>
              <span>Fan-out…</span>
            </DropdownMenu.Item>
            {scopeCount === 0 ? (
              <Tooltip.Provider delayDuration={200}>
                <Tooltip.Root>
                  {/* Radix disables pointer events on a disabled item, so the
                      tooltip trigger is a wrapper that still receives hover. */}
                  <Tooltip.Trigger asChild>
                    <span style={{ display: 'block' }}>
                      <DropdownMenu.Item className="dropdown-item" disabled>
                        <span>Orchestration…</span>
                      </DropdownMenu.Item>
                    </span>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                      Add a scope first — the conductor needs somewhere to live
                      <Tooltip.Arrow className="tooltip-arrow" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            ) : (
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => setOpenDialog('orchestration')}
              >
                <span>Orchestration…</span>
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {openDialog === 'group' && (
        <NewGroupDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === 'fan-out' && (
        <FanOutDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === 'orchestration' && (
        <OrchestrationDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
    </>
  );
}

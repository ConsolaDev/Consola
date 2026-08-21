import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { createQuickSession } from '../../utils/sessionActions';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { FanOutDialog } from '../Dialogs/FanOutDialog';

/**
 * The ＋ New menu: everything that creates work, in one place, in increasing
 * order of machinery — a session, a group, a fan-out, and (Phase 3) an
 * orchestration. This is the whole creation surface a casual user ever sees.
 */
export function NewMenu() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const [openDialog, setOpenDialog] = useState<'group' | 'fan-out' | null>(null);

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
                    Coming soon
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {openDialog === 'group' && (
        <NewGroupDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === 'fan-out' && (
        <FanOutDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
    </>
  );
}

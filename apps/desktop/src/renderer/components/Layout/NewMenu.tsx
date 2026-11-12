import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ChevronDown, Folder, GitBranch, Plus } from 'lucide-react';
import { isMac } from '../../utils/platform';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { hasScopeChoice, newSessionScope, useHomeStore } from '../../stores/homeStore';
import { createQuickSession, openNewSessionDialog } from '../../utils/sessionActions';
import { scopeTrail } from '../../utils/scopeTrail';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { FanOutDialog } from '../Dialogs/FanOutDialog';
import { OrchestrationDialog } from '../Dialogs/OrchestrationDialog';

/**
 * The ＋ New menu: everything that creates work, in one place, in increasing
 * order of machinery — a session, a group, a fan-out, and an orchestration.
 * This is the whole creation surface a casual user ever sees.
 *
 * ＋ starts a session straight into its terminal and names where: the picked
 * scope, else the open session's, else the primary one. ▾ leads with every
 * scope, for the times a session belongs somewhere else.
 */
export function NewMenu() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  );
  const filterId = useHomeStore((state) => state.scopeFilters[activeWorkspaceId ?? '']);
  const [openDialog, setOpenDialog] = useState<'group' | 'fan-out' | 'orchestration' | null>(null);

  if (!activeWorkspaceId) return null;
  // The orchestration door generates a conductor directory inside a scope, so
  // a workspace with none has nowhere to put one.
  const scopeCount = workspace?.scopes.length ?? 0;
  const target = workspace && newSessionScope(workspace, filterId, activeSessionId);
  const plusTitle = target && workspace ? `New session in ${scopeTrail(workspace.scopes, target).label}` : 'New session';

  return (
    <>
      <div className="new-menu-buttons">
        <button className="new-menu-trigger" aria-label="New session" title={plusTitle} onClick={() => void createQuickSession(activeWorkspaceId)}><Plus size={14} /></button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="new-menu-trigger new-menu-more" aria-label="New">
              <ChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            {/* Hung from the control's right edge, so it opens over the
                sidebar it belongs to (or inside the window, from the title
                bar's far end) rather than out across the pane. */}
            <DropdownMenu.Content
              className="dropdown-content"
              sideOffset={6}
              align="end"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {workspace && hasScopeChoice(workspace) && <>
                <DropdownMenu.Label className="navigation-settings-label">New session in</DropdownMenu.Label>
                {workspace.scopes.map((scope) => {
                  const trail = scopeTrail(workspace.scopes, scope);
                  return (
                    <DropdownMenu.Item
                      key={scope.id}
                      className="dropdown-item"
                      title={scope.path}
                      onSelect={() => void createQuickSession(activeWorkspaceId, { scopeId: scope.id })}
                    >
                      {scope.isGitRepo ? <GitBranch size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
                      <span className="new-menu-scope">
                        {trail.parent && <span className="new-menu-scope-parent">{trail.parent} / </span>}
                        {trail.label}
                      </span>
                    </DropdownMenu.Item>
                  );
                })}
                <DropdownMenu.Separator className="dropdown-separator" />
              </>}
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => void createQuickSession(activeWorkspaceId)}
              >
                <span>New session</span>
                <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>{isMac ? '⌘N' : 'Ctrl+N'}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="dropdown-item" onSelect={() => openNewSessionDialog(activeWorkspaceId)}>
                <span>New session with options…</span>
                <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>{isMac ? '⇧⌘N' : 'Ctrl+Shift+N'}</span>
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
      </div>

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

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Archive, Boxes, ChevronDown, ChevronRight, MoreVertical, Plus } from 'lucide-react';
import type { Group } from '../../../shared/workspace';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkspaceStore, type Scope, type Session } from '../../stores/workspaceStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { formatGroupBadge, groupCountsFor } from '../../utils/groupCounts';
import { activateSession, moveSessionToGroup } from '../../utils/sessionActions';
import { droppedSessionId, isSessionDrag, leftDropTarget } from './sessionDrag';
import { SessionNavItem } from './SessionNavItem';

interface GroupNavItemProps {
  group: Group;
  sessions: Session[];
  workspaceId: string;
  /** The scope a member session belongs to, for its subtitle. */
  scopeFor: (scopeId: string) => Scope | undefined;
  activeSessionId: string | null;
  onNewSession: () => void;
}

/** A collapsible group of sessions in the selected scope, with live status counts. */
export function GroupNavItem({
  group,
  sessions,
  workspaceId,
  scopeFor,
  activeSessionId,
  onNewSession,
}: GroupNavItemProps) {
  const collapsed = useSettingsStore((state) =>
    state.collapsedSidebarSections.includes(group.id)
  );
  const toggleSidebarSection = useSettingsStore((state) => state.toggleSidebarSection);
  const terminals = useTerminalStore((state) => state.terminals);
  const counts = groupCountsFor(sessions, terminals);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  // The conductor sits at the head of its group's member list — the brain
  // above its workers — while the workers keep their existing relative order.
  const conductor = sessions.find((session) => session.kind === 'conductor');
  const orderedSessions = conductor
    ? [conductor, ...sessions.filter((session) => session !== conductor)]
    : sessions;

  // The scope is already selected above. Fan-out members still name the repo
  // they run in when their working folder differs from the scope's root.
  const subtitleFor = (session: Session): string | undefined => {
    const scope = scopeFor(session.scopeId);
    const folder =
      session.cwd && session.cwd !== scope?.path ? basename(session.cwd) : undefined;
    return folder;
  };

  // Archiving is how a group ends: the record outlives it so member sessions
  // keep their groupId, and the sidebar returns them to Ungrouped.
  const handleArchive = async () => {
    try {
      await useWorkspaceStore.getState().archiveGroup(workspaceId, group.id);
    } catch (error) {
      // Main refused; the group visibly staying put is the signal.
      console.error('Failed to archive group', error);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDropTarget(false);
    const sessionId = droppedSessionId(event);
    if (!sessionId) return;
    // Dropping a row back where it started should cost nothing, rather than a
    // write whose only effect is a re-render.
    if (sessions.some((member) => member.id === sessionId)) return;
    void moveSessionToGroup(workspaceId, sessionId, group.id);
  };

  return (
    <div className="group-nav-item">
      {/* The header collapses the group but also hosts the actions trigger,
          and a <button> may not contain another button — hence a row. */}
      <div
        className={`group-nav-header ${isDropTarget ? 'drop-target' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setActionsOpen(true);
        }}
        onDragOver={(event) => {
          if (!isSessionDrag(event)) return;
          // Without preventDefault the browser refuses the drop outright.
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setIsDropTarget(true);
        }}
        onDragLeave={(event) => {
          if (leftDropTarget(event)) setIsDropTarget(false);
        }}
        onDrop={handleDrop}
      >
        <button
          className="group-nav-toggle"
          aria-expanded={!collapsed}
          onClick={() => toggleSidebarSection(group.id)}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          {/* Decorative: the button names itself from this subtree, and the
              glyph adds nothing the group's name does not already say. */}
          <Boxes size={14} aria-hidden="true" />
          <span className="group-nav-name">{group.name}</span>
          <span className="group-nav-count">{formatGroupBadge(counts)}</span>
        </button>
        <div className="nav-row-actions" data-open={actionsOpen || undefined}>
          <DropdownMenu.Root open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                className="nav-row-action session-actions-trigger"
                onClick={(e) => e.stopPropagation()}
                aria-label={`Group actions for ${group.name}`}
                title="Group actions"
              >
                <MoreVertical size={12} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
                <DropdownMenu.Item
                  className="dropdown-item dropdown-item-destructive"
                  onSelect={() => void handleArchive()}
                >
                  <Archive size={14} />
                  <span>Archive group</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            type="button"
            className="nav-row-action"
            aria-label={`New session in ${group.name}`}
            title="New session"
            onClick={onNewSession}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
      {!collapsed &&
        orderedSessions.map((session) => (
          <SessionNavItem
            key={session.id}
            session={session}
            workspaceId={workspaceId}
            isActive={activeSessionId === session.id}
            onClick={() => activateSession(workspaceId, session.id)}
            subtitle={subtitleFor(session)}
          />
        ))}
    </div>
  );
}

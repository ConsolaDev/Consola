import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Archive, Boxes, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import type { Group } from '../../../shared/workspace';
import { type Session } from '../../stores/workspaceStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { workspaceBridge } from '../../services/workspaceBridge';
import { formatGroupBadge, groupCountsFor } from '../../utils/groupCounts';
import { activateSession } from '../../utils/sessionActions';
import { SessionNavItem } from './SessionNavItem';

interface GroupNavItemProps {
  group: Group;
  sessions: Session[];
  workspaceId: string;
  /** The scope name a member session shows as its subtitle. */
  scopeNameFor: (scopeId: string) => string | undefined;
  activeSessionId: string | null;
}

/**
 * One group in the sidebar: a collapsible header with a derived badge, and
 * its member sessions beneath, each subtitled with its scope.
 *
 * The badge is recomputed from the terminal store on every render — progress
 * is derived, never stored (see groupCounts.ts).
 */
export function GroupNavItem({
  group,
  sessions,
  workspaceId,
  scopeNameFor,
  activeSessionId,
}: GroupNavItemProps) {
  const [isOpen, setIsOpen] = useState(true);
  const terminals = useTerminalStore((state) => state.terminals);
  const counts = groupCountsFor(sessions, terminals);

  // Archiving is how a group ends: the record outlives it so member sessions
  // keep their groupId, and the sidebar hands them back to their scopes.
  const handleArchive = async () => {
    try {
      await workspaceBridge.archiveGroup(workspaceId, group.id);
    } catch (error) {
      // Main refused; the group visibly staying put is the signal.
      console.error('Failed to archive group', error);
    }
  };

  return (
    <div className="group-nav-item">
      {/* The header collapses the group but also hosts the actions trigger,
          and a <button> may not contain another button — hence a row. */}
      <div className="group-nav-header">
        <button className="group-nav-toggle" onClick={() => setIsOpen((open) => !open)}>
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Boxes size={14} />
          <span className="group-nav-name">{group.name}</span>
          <span className="group-nav-count">{formatGroupBadge(counts)}</span>
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="session-actions-trigger"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Group actions for ${group.name}`}
            >
              <MoreHorizontal size={14} />
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
      </div>
      {isOpen &&
        sessions.map((session) => (
          <SessionNavItem
            key={session.id}
            session={session}
            workspaceId={workspaceId}
            isActive={activeSessionId === session.id}
            onClick={() => activateSession(workspaceId, session.id)}
            subtitle={scopeNameFor(session.scopeId)}
          />
        ))}
    </div>
  );
}

import { useState } from 'react';
import { Boxes, ChevronDown, ChevronRight } from 'lucide-react';
import type { Group } from '../../../shared/workspace';
import { type Session } from '../../stores/workspaceStore';
import { useTerminalStore } from '../../stores/terminalStore';
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

  return (
    <div className="group-nav-item">
      <button className="group-nav-header" onClick={() => setIsOpen((open) => !open)}>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Boxes size={14} />
        <span className="group-nav-name">{group.name}</span>
        <span className="group-nav-count">{formatGroupBadge(counts)}</span>
      </button>
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

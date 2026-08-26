import { ChevronDown, ChevronRight, Folder, GitBranch, Plus, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { type Scope, type Session } from '../../stores/workspaceStore';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import { SessionNavItem } from './SessionNavItem';

interface ScopeNavItemProps {
  scope: Scope;
  /** The ungrouped sessions that run here; a grouped one renders under its group. */
  sessions: Session[];
  workspaceId: string;
  activeSessionId: string | null;
  /** Hidden rather than disabled while anything still references the scope. */
  removable: boolean;
  onRemove: (scope: Scope) => void;
}

/**
 * One scope in the sidebar: a collapsible header over the sessions that run
 * in it.
 *
 * Folded state lives in the settings store keyed by scope id, so it outlives
 * both a tab switch and a relaunch, the way the sidebar's width does. A
 * folded scope keeps its session count on the row — folded, the count is the
 * only thing left saying anything is in there.
 */
export function ScopeNavItem({
  scope,
  sessions,
  workspaceId,
  activeSessionId,
  removable,
  onRemove,
}: ScopeNavItemProps) {
  const collapsed = useSettingsStore((state) =>
    state.collapsedSidebarSections.includes(scope.id)
  );
  const toggleSidebarSection = useSettingsStore((state) => state.toggleSidebarSection);

  return (
    <div className="scope-group" data-testid={`scope-group-${scope.id}`}>
      {/* The row collapses the scope but also hosts the add and remove
          buttons, and a <button> may not contain another button — hence a
          row, exactly as a group header solves the same problem. */}
      <div className="scope-row" title={scope.path}>
        <button
          className="scope-row-toggle"
          aria-expanded={!collapsed}
          onClick={() => toggleSidebarSection(scope.id)}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          {/* Decorative: the folder glyph repeats what the name already says,
              and the button computes its accessible name from this subtree. */}
          <span className="scope-row-icon" aria-hidden="true">
            {scope.isGitRepo ? <GitBranch size={13} /> : <Folder size={13} />}
          </span>
          <span className="scope-row-name">{scope.name}</span>
          {collapsed && sessions.length > 0 && (
            <span className="scope-row-count">
              {sessions.length}
              {/* A bare numeral reads as part of the name when spoken. */}
              <span className="sr-only"> {sessions.length === 1 ? 'session' : 'sessions'}</span>
            </span>
          )}
        </button>
        <button
          className="scope-row-action"
          onClick={() => void createQuickSession(workspaceId, scope.id)}
          aria-label={`New session in ${scope.name}`}
        >
          <Plus size={12} />
        </button>
        {removable && (
          <button
            className="scope-row-action"
            onClick={() => onRemove(scope)}
            aria-label={`Remove scope ${scope.name}`}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {!collapsed &&
        sessions.map((session) => (
          <SessionNavItem
            key={session.id}
            session={session}
            workspaceId={workspaceId}
            isActive={activeSessionId === session.id}
            onClick={() => activateSession(workspaceId, session.id)}
          />
        ))}
    </div>
  );
}

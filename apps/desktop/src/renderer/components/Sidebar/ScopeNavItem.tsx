import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ChevronDown, ChevronRight, Folder, GitBranch, Plus, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { type Scope, type Session } from '../../stores/workspaceStore';
import {
  activateSession,
  createQuickSession,
  moveSessionToGroup,
} from '../../utils/sessionActions';
import { droppedSessionId, isSessionFromScope, leftDropTarget } from './sessionDrag';
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
 *
 * The row is also where a grouped session comes home: dropping one here is the
 * inverse of dropping it on a group header, and the only drop a scope accepts.
 * A scope never takes a session that belongs to a different one — that would
 * be a scope change, which the record refuses — so every other row stays inert
 * while this one lights up, and the highlight only ever promises what the
 * write will actually do.
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
  const expandSidebarSection = useSettingsStore((state) => state.expandSidebarSection);
  const [isDropTarget, setIsDropTarget] = useState(false);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDropTarget(false);
    const sessionId = droppedSessionId(event);
    if (!sessionId) return;
    // Presence semantics: the key is sent, and undefined, which main reads as
    // "leave the group" — the same single write the ⋯ menu makes.
    void moveSessionToGroup(workspaceId, sessionId, undefined);
    // Leaving a group reveals nothing on its own, deliberately. A drop is the
    // exception: the pointer named this scope, and a row that vanished into a
    // folded one would read as a drop that silently did nothing.
    expandSidebarSection(scope.id);
  };

  return (
    <div className="scope-group" data-testid={`scope-group-${scope.id}`}>
      {/* The row collapses the scope but also hosts the add and remove
          buttons, and a <button> may not contain another button — hence a
          row, exactly as a group header solves the same problem. */}
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={`scope-row ${isDropTarget ? 'drop-target' : ''}`}
            title={scope.path}
            onDragOver={(event) => {
              if (!isSessionFromScope(event, scope.id)) return;
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
            <div className="nav-row-actions">
              <button
                className="nav-row-action"
                onClick={() => void createQuickSession(workspaceId, scope.id)}
                aria-label={`New session in ${scope.name}`}
                title="New session"
              >
                <Plus size={12} aria-hidden="true" />
              </button>
              {removable && (
                <button
                  className="nav-row-action"
                  onClick={() => onRemove(scope)}
                  aria-label={`Remove scope ${scope.name}`}
                  title="Remove scope"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="dropdown-content">
            <ContextMenu.Item
              className="dropdown-item"
              onSelect={() => void createQuickSession(workspaceId, scope.id)}
            >
              <Plus size={14} />
              <span>New session</span>
            </ContextMenu.Item>
            {removable && (
              <ContextMenu.Item
                className="dropdown-item dropdown-item-destructive"
                onSelect={() => onRemove(scope)}
              >
                <X size={14} />
                <span>Remove scope</span>
              </ContextMenu.Item>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
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

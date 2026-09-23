import type { Session } from '../../../shared/workspace';

/**
 * The id of the foldable sidebar section a session's row sits in: its live
 * group, or else the scope it runs in.
 *
 * A live group owns its members' rows and an archived one hands them back to
 * their scopes, so "which section" is not simply "which group". The rule
 * lives here because two callers depend on it agreeing with itself — the
 * partition that draws the rows, and the reveal that unfolds a section when
 * the session inside it becomes active. If those two disagreed, activating a
 * session would open a section that does not contain it and leave the row
 * hidden in the one that does.
 */
export function sidebarSectionForSession(
  liveGroupIds: ReadonlySet<string>,
  session: Pick<Session, 'groupId' | 'scopeId'>
): string {
  return session.groupId && liveGroupIds.has(session.groupId)
    ? session.groupId
    : session.scopeId;
}

import type { Session, Workspace } from '../../shared/workspace';

/**
 * Sessions present in `before` and gone from `after`.
 *
 * Main deletes sessions on its own — a cleanup tool, an automation, a removed
 * scope — and announces it only through the next full snapshot. This is how
 * a window notices, so it can forget what it kept about them.
 */
export function vanishedSessions(before: Workspace[], after: Workspace[]): Session[] {
    const live = new Set(after.flatMap((workspace) => workspace.sessions.map((session) => session.id)));
    return before.flatMap((workspace) => workspace.sessions.filter((session) => !live.has(session.id)));
}

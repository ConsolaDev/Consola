/**
 * Where the Sessions section is, as the address names it: the person's sessions are `#/sessions`,
 * the form that starts one `#/sessions/new`, and one session `#/sessions/<sessionId>`. All of it
 * is the section's own part of the hash (`sections.ts`), so the dashboard opens Sessions for any.
 * A session's id is the API's UUID, so it is never `new`.
 */

export const SESSIONS_SECTION_ID = 'sessions';

const NEW = 'new';

export type SessionsRoute =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'session'; sessionId: string };

const SESSIONS_HASH = /^#\/sessions(?:\/([^?]*))?(?:\?.*)?$/s;

/** Where a hash puts the Sessions section; a hash outside it, or one it cannot read, is the list. */
export function sessionsRouteOfHash(hash: string): SessionsRoute {
  // One segment, a slash at its end allowed; an id's own slashes are escaped (`hashOfSession`).
  const path = (SESSIONS_HASH.exec(hash)?.[1] ?? '').replace(/\/+$/, '');
  if (path === NEW) return { kind: 'new' };
  if (path !== '' && !path.includes('/')) {
    try {
      return { kind: 'session', sessionId: decodeURIComponent(path) };
    } catch {
      // A malformed escape: no session, so the list.
    }
  }
  return { kind: 'list' };
}

/** The hash that shows the person's sessions. */
export function hashOfSessions(): string {
  return `#/${SESSIONS_SECTION_ID}`;
}

/** The hash that shows the form that starts a session. */
export function hashOfNewSession(): string {
  return `#/${SESSIONS_SECTION_ID}/${NEW}`;
}

/** The hash that shows one session. */
export function hashOfSession(sessionId: string): string {
  return `#/${SESSIONS_SECTION_ID}/${encodeURIComponent(sessionId)}`;
}

/** Someone signed in, as the API shows them. */
export type Person = { id: string; name: string; email: string; image: string | null };

/** A request's session: whose it is, and the workspace it has active, if any. */
export type SignedIn = { sessionId: string; person: Person; activeWorkspaceId: string | null };

/**
 * Who a session says is asking, as the rest of the app may know them: the person's id, the
 * session's own id and the workspace it has active. Nothing else of the account leaves accounts
 * this way: no name, no email. The session's id lets a step the person starts in one browser be
 * finished only there (a GitHub Connect).
 */
export type PersonAsking = {
  personId: string;
  sessionId: string;
  activeWorkspaceId: string | null;
};

/** The person a session names, by id alone, with the session's, or null when there is none. */
export function personAsking(session: SignedIn | null): PersonAsking | null {
  if (session === null) return null;
  return {
    personId: session.person.id,
    sessionId: session.sessionId,
    activeWorkspaceId: session.activeWorkspaceId,
  };
}

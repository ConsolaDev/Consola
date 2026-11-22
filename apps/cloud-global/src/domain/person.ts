/** Someone signed in, as the API shows them. */
export type Person = { id: string; name: string; email: string; image: string | null };

/** A request's session: whose it is, and the workspace it has active, if any. */
export type SignedIn = { sessionId: string; person: Person; activeWorkspaceId: string | null };

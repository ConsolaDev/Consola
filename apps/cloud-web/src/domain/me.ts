/** A workspace as the person signed in sees it: with their role in it. */
export type MyWorkspace = { id: string; name: string; slug: string; region: string; role: string };

/** Who is signed in, and the workspace their session has active, if any. */
export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  workspace: MyWorkspace | null;
};

export type MeState =
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

import type { Workspace } from '../../../shared/workspace';

export interface SettledSession {
  id: string;
  name: string;
  workspaceName: string;
}

/**
 * The sessions auto-settle moved that still exist, named for the person.
 * A deleted one is dropped: the explanation says where things are, and a
 * deleted session is not anywhere.
 */
export function settledSessionsFor(
  pendingIds: readonly string[],
  workspaces: readonly Workspace[],
): SettledSession[] {
  const found: SettledSession[] = [];
  for (const id of pendingIds) {
    for (const workspace of workspaces) {
      const session = workspace.sessions.find((candidate) => candidate.id === id);
      if (session)
        found.push({ id, name: session.name || 'Untitled session', workspaceName: workspace.name });
    }
  }
  return found;
}

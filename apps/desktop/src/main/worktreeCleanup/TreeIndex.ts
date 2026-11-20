import type { Session, Workspace } from '../../shared/workspace';

export interface TreeUser {
  workspace: Workspace;
  session: Session;
}

/**
 * Every Consola worktree some session uses, with the sessions using it, across
 * every workspace.
 *
 * A session uses the tree its `cwd` is in and the tree its `agentCwd` is in —
 * an agent can move itself into another checkout, and removing that one from
 * under it is the same loss. Paths are compared as real paths, so a symlinked
 * spelling of one folder is one tree. A session whose worktree a rule already
 * removed (`removedWorktree`) uses nothing until it is rebuilt.
 */
export function indexTrees(
  workspaces: readonly Workspace[],
  managedTreeOf: (dir: string) => string | null,
): Map<string, TreeUser[]> {
  const trees = new Map<string, TreeUser[]>();
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      for (const tree of treesOfSession(session, managedTreeOf)) {
        const users = trees.get(tree) ?? [];
        users.push({ workspace, session });
        trees.set(tree, users);
      }
    }
  }
  return trees;
}

/** The Consola worktrees one session uses: its own checkout's first. */
export function treesOfSession(
  session: Session,
  managedTreeOf: (dir: string) => string | null,
): string[] {
  if (session.removedWorktree) return [];
  const trees: string[] = [];
  for (const dir of [session.cwd, session.agentCwd]) {
    if (!dir) continue;
    const tree = managedTreeOf(dir);
    if (tree && !trees.includes(tree)) trees.push(tree);
  }
  return trees;
}

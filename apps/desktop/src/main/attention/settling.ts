import type { Session, Workspace } from '../../shared/workspace';
import { activityOf } from '../../shared/attention';
import type { Attention } from '../../shared/attention';
import type { BatchResult, Refusal, SettleMemento, SettleResult } from '../../shared/preferences';
import type { AttentionLedger, SettleTarget } from './AttentionLedger';

/** The sessions a person sees in the list: nothing still unnamed. */
export function settleable(workspace: Workspace): Session[] {
  return workspace.sessions.filter((session) => session.name.length > 0);
}

/**
 * Sessions as conductor trees, one level deep, the way the sidebar draws them:
 * a parent that does not resolve makes its session a root, anything deeper
 * rolls up under its top conductor, and a cycle breaks where it closes.
 * Each session is in exactly one tree.
 */
export function sessionTrees(sessions: readonly Session[]): Session[][] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const topOf = (session: Session) => conductorOf(byId, session);
  const trees = new Map<string, Session[]>();
  for (const session of sessions) {
    const top = topOf(session);
    trees.set(top.id, [...(trees.get(top.id) ?? []), session]);
  }
  return [...trees.values()];
}

/** The top of a session's tree, by the rules `sessionTrees` draws with. */
function conductorOf(byId: ReadonlyMap<string, Session>, session: Session): Session {
  const seen = new Set([session.id]);
  let current = session;
  while (current.parentSessionId !== undefined) {
    const next = byId.get(current.parentSessionId);
    if (!next) return current;
    if (seen.has(next.id)) return session;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** The root of the tree this session is drawn in, among `sessions`; undefined when it is not among them. */
export function treeRootOf(sessions: readonly Session[], sessionId: string): Session | undefined {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const session = byId.get(sessionId);
  return session && conductorOf(byId, session);
}

/** The session and everything beneath it. */
export function withDescendants(sessions: readonly Session[], sessionId: string): Session[] {
  const found = new Map<string, Session>();
  const queue = [sessionId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session || found.has(id)) continue;
    found.set(id, session);
    for (const child of sessions) if (child.parentSessionId === id) queue.push(child.id);
  }
  return [...found.values()];
}

/** What the ledger needs to shelve each of these. */
export function settleTargets(
  workspace: Workspace,
  sessions: readonly Session[],
  ledger: Pick<AttentionLedger, 'get'>,
): SettleTarget[] {
  return sessions.map((session) => ({
    sessionId: session.id,
    workspaceId: workspace.id,
    activityAt: activityOf(session, ledger.get(session.id)),
  }));
}

/**
 * The person settles a session: it and its descendants, in one write.
 * Order is derived from activity and never stored, so undoing this returns
 * every row to its exact slot with nothing to remember about position.
 */
export function settleSession(
  workspace: Workspace,
  sessionId: string,
  ledger: AttentionLedger,
  now: number,
): SettleMemento {
  const members = withDescendants(settleable(workspace), sessionId);
  return ledger.settle(settleTargets(workspace, members, ledger), now, { markSeen: true });
}

/** The person brings a session (and its descendants) back, holding auto-settle off until new activity. */
export function unsettleSession(
  workspace: Workspace,
  sessionId: string,
  ledger: AttentionLedger,
  now: number,
): SettleMemento {
  const members = withDescendants(settleable(workspace), sessionId);
  return ledger.unsettle(
    members.map((session) => session.id),
    now,
  );
}

/**
 * Settle by hand, then ask the derivation whether it took. The row cannot see
 * everything that keeps a session off the shelf (an open run holding it is
 * one), so main checks after writing: if any member does not read `settled`,
 * the write is taken back, so a stale `settledAt` cannot shelve the session
 * the moment the hold lifts, and the caller is told the truth.
 */
export function settleAndVerify(
  workspace: Workspace,
  sessionId: string,
  ledger: AttentionLedger,
  derive: () => ReadonlyMap<string, Attention>,
  now: number,
): SettleResult {
  const memento = settleSession(workspace, sessionId, ledger, now);
  const attention = derive();
  if (Object.keys(memento).every((id) => attention.get(id) === 'settled')) {
    return { settled: true, memento };
  }
  ledger.restore(memento);
  return { settled: false, memento: {} };
}

const BATCH_MESSAGES: Record<string, string> = {
  'not-found': 'It no longer exists.',
  unlisted: 'It is not in the list yet.',
  child: 'Settles with its conductor.',
  'in-use': 'It is still in use.',
  'not-settled': 'It is not settled.',
};

const refuse = (sessionId: string, reason: string): Refusal => ({
  sessionId,
  reason,
  message: BATCH_MESSAGES[reason] ?? reason,
});

/**
 * The trees a batch names: each chosen root with its members. A child chosen
 * beside its conductor is carried with it; one chosen alone is refused, since
 * a tree is placed by its root.
 */
function batchTrees(
  workspace: Workspace,
  sessionIds: string[],
): { trees: Map<string, Session[]>; refused: Refusal[] } {
  const listed = settleable(workspace);
  const selected = new Set(sessionIds);
  const trees = new Map<string, Session[]>();
  const refused: Refusal[] = [];
  for (const id of selected) {
    const session = workspace.sessions.find((candidate) => candidate.id === id);
    if (!session) refused.push(refuse(id, 'not-found'));
    else {
      const root = treeRootOf(listed, id);
      if (!root) refused.push(refuse(id, 'unlisted'));
      else if (root.id !== id) {
        if (!selected.has(root.id)) refused.push(refuse(id, 'child'));
      } else trees.set(id, withDescendants(listed, id));
    }
  }
  return { trees, refused };
}

/** The ids asked for whose tree was acted on: roots, and the children carried with them. */
function appliedOf(
  workspace: Workspace,
  sessionIds: string[],
  done: ReadonlySet<string>,
): string[] {
  const listed = settleable(workspace);
  return sessionIds.filter((id) => {
    const root = treeRootOf(listed, id);
    return root !== undefined && done.has(root.id);
  });
}

/**
 * Settle several sessions by hand, in one write with one memento, then ask
 * the derivation which took, exactly as `settleAndVerify` does for one: a
 * tree that did not reach the shelf is taken back and reported.
 */
export function settleMany(
  workspace: Workspace,
  sessionIds: string[],
  ledger: AttentionLedger,
  derive: () => ReadonlyMap<string, Attention>,
  now: number,
): BatchResult {
  const { trees, refused } = batchTrees(workspace, sessionIds);
  const members = [...trees.values()].flat();
  const memento =
    members.length > 0
      ? ledger.settle(settleTargets(workspace, members, ledger), now, { markSeen: true })
      : {};
  const attention = derive();
  const undo: SettleMemento = {};
  for (const [rootId, tree] of trees) {
    if (tree.every((member) => attention.get(member.id) === 'settled')) continue;
    trees.delete(rootId);
    refused.push(refuse(rootId, 'in-use'));
    for (const member of tree) {
      if (member.id in memento) {
        undo[member.id] = memento[member.id];
        delete memento[member.id];
      }
    }
  }
  if (Object.keys(undo).length > 0) ledger.restore(undo);
  return { applied: appliedOf(workspace, sessionIds, new Set(trees.keys())), refused, memento };
}

/** Bring several settled sessions back, in one write; one that is not settled is reported as such. */
export function unsettleMany(
  workspace: Workspace,
  sessionIds: string[],
  ledger: AttentionLedger,
  now: number,
): BatchResult {
  const { trees, refused } = batchTrees(workspace, sessionIds);
  for (const [rootId, tree] of trees) {
    if (tree.some((member) => ledger.get(member.id)?.settledAt !== undefined)) continue;
    trees.delete(rootId);
    refused.push(refuse(rootId, 'not-settled'));
  }
  const ids = [...trees.values()].flat().map((member) => member.id);
  const memento = ids.length > 0 ? ledger.unsettle(ids, now) : {};
  return { applied: appliedOf(workspace, sessionIds, new Set(trees.keys())), refused, memento };
}

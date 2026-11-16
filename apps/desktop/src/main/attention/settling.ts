import type { Session, Workspace } from '../../shared/workspace';
import { activityOf } from '../../shared/attention';
import type { Attention } from '../../shared/attention';
import type { SettleMemento, SettleResult } from '../../shared/preferences';
import type { AttentionLedger, SettleTarget } from './AttentionLedger';

/** The sessions a person sees in the list: no Assistant, and nothing still unnamed. */
export function settleable(workspace: Workspace): Session[] {
  return workspace.sessions.filter((session) => session.kind !== 'assistant' && session.name.length > 0);
}

/**
 * Sessions as conductor trees, one level deep, the way the sidebar draws them:
 * a parent that does not resolve makes its session a root, anything deeper
 * rolls up under its top conductor, and a cycle breaks where it closes.
 * Each session is in exactly one tree.
 */
export function sessionTrees(sessions: readonly Session[]): Session[][] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const topOf = (session: Session): Session => {
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
  };
  const trees = new Map<string, Session[]>();
  for (const session of sessions) {
    const top = topOf(session);
    trees.set(top.id, [...(trees.get(top.id) ?? []), session]);
  }
  return [...trees.values()];
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
  ledger: Pick<AttentionLedger, 'get'>
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
  now: number
): SettleMemento {
  const members = withDescendants(settleable(workspace), sessionId);
  return ledger.settle(settleTargets(workspace, members, ledger), now, { markSeen: true });
}

/** The person brings a session (and its descendants) back, holding auto-settle off until new activity. */
export function unsettleSession(
  workspace: Workspace,
  sessionId: string,
  ledger: AttentionLedger,
  now: number
): SettleMemento {
  const members = withDescendants(settleable(workspace), sessionId);
  return ledger.unsettle(members.map((session) => session.id), now);
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
  now: number
): SettleResult {
  const memento = settleSession(workspace, sessionId, ledger, now);
  const attention = derive();
  if (Object.keys(memento).every((id) => attention.get(id) === 'settled')) return { settled: true, memento };
  ledger.restore(memento);
  return { settled: false, memento: {} };
}

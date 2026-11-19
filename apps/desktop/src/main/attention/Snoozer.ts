import type { Attention, AttentionRecord, SnoozeReason, WakeCause } from '../../shared/attention';
import { activityOf } from '../../shared/attention';
import type {
  BatchResult,
  Preferences,
  Refusal,
  SettleMemento,
  SnoozeBatchResult,
} from '../../shared/preferences';
import type { Session, Workspace } from '../../shared/workspace';
import { findSessionById, findSessionByInstanceId } from '../attention';
import type { AttentionLedger, SnoozeTarget } from './AttentionLedger';
import { isPersonKey, pressesEnter } from './personInput';
import { settleable, treeRootOf, withDescendants } from './settling';
import { type ArmedTimer, armAt } from './wakeTimer';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The furthest an agent may park a session. The person's own custom date has no cap. */
export const AGENT_MAX_SNOOZE_MS = 30 * DAY_MS;

/** Who asked. An agent may not hide a question, and may not park anything for long. */
export type SnoozeActor = 'person' | 'agent';

export interface SnoozerDeps {
  getWorkspaces(): Workspace[];
  ledger: Pick<AttentionLedger, 'get' | 'snooze' | 'wake' | 'snoozed' | 'restore' | 'markSeen'>;
  /** What main derives for every entry, read fresh after a write. */
  attention(): ReadonlyMap<string, Attention>;
  /** Whether a focused window is showing this terminal: a session that comes back in front of the person is not news. */
  isViewedInFocusedWindow(instanceId: string): boolean;
  /** Whether this terminal is asking the person something right now. */
  isAsking(instanceId: string): boolean;
  preferences: { get(): Pick<Preferences, 'snoozeAtUsageLimit'> };
  /** The ledger changed under the derivation: say it may now read differently. */
  changed(): void;
  now?: () => number;
  arm?: typeof armAt;
}

/** One conductor tree, as a snooze sees it: everything is written on the root and its members. */
interface Tree {
  workspace: Workspace;
  root: Session;
  members: Session[];
}

/** How a wake is recorded: a cause marks the root Woke, `hold` is the person bringing it back. */
type WakeKind = WakeCause | 'hold';

const MESSAGES: Record<string, string> = {
  'not-found': 'It no longer exists.',
  unlisted: 'It is not in the list yet.',
  child: 'Snoozes with its conductor.',
  'too-soon': 'That time has passed. Pick another.',
  'too-far': 'An agent can snooze a session for at most 30 days.',
  'needs-you': 'It is waiting for the person to answer, so it stays in the list.',
  'no-reset-time': 'No reset time is known for its usage limit.',
  'in-use': 'An automation is using it.',
  'not-snoozed': 'It is not snoozed.',
};

const refusal = (sessionId: string, reason: string): Refusal => ({
  sessionId,
  reason,
  message: MESSAGES[reason] ?? reason,
});

/**
 * Parks sessions until a time and brings them back: the only writer of the
 * ledger's snooze fields.
 *
 * A snooze covers a whole conductor tree, written on every member, because
 * the sidebar places trees by their worst member. Snoozed is derived (from
 * `snoozedUntil` against the clock), so nothing here keeps state the ledger
 * does not; the one timer is re-armed for the earliest snooze after every
 * change. A session comes back early only when it needs the person: a new
 * question, a failure, a usage limit, or the person answering it.
 */
export class Snoozer {
  private timer?: ArmedTimer;
  private readonly now: () => number;
  private readonly arm: typeof armAt;
  /** Terminals where the person pressed a key at a question: the snooze ends when that question does. */
  private readonly answering = new Set<string>();
  /** Stopped for quit: the exits that closing Consola causes are not news. */
  private stopped = false;

  constructor(private readonly deps: SnoozerDeps) {
    this.now = deps.now ?? Date.now;
    this.arm = deps.arm ?? armAt;
  }

  /** Bring back everything whose time passed while Consola was closed, then wait for the next. */
  public start(): void {
    this.wakeDue();
  }

  public stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** The ledger's snoozes changed some other way (a settle, an undo): wait for the right one. */
  public rearm(): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = undefined;
    const next = this.deps.ledger.snoozed()[0]?.snoozedUntil;
    if (next === undefined) return;
    this.timer = this.arm(next, () => this.wakeDue(), this.now);
  }

  /** The machine woke: whatever came due while it slept comes back now. */
  public recheck(): void {
    if (this.stopped) return;
    this.wakeDue();
  }

  /**
   * Park sessions until `until`: a time, or one per root (a usage limit's
   * reset, which differs by harness). Only a root is snoozed, with its
   * whole tree; a child chosen beside its conductor is carried with it, and
   * one chosen alone is refused. One write, so one Undo.
   */
  public snooze(
    workspaceId: string,
    sessionIds: string[],
    until: number | ((rootId: string) => number | undefined),
    opts: { by: SnoozeActor; reason?: SnoozeReason },
  ): SnoozeBatchResult {
    const now = this.now();
    const workspace = this.workspace(workspaceId);
    if (!workspace)
      return {
        applied: [],
        refused: sessionIds.map((id) => refusal(id, 'not-found')),
        memento: {},
        until: null,
      };
    const refused: Refusal[] = [];
    const selected = new Set(sessionIds);
    const accepted = new Map<string, { tree: Tree; until: number }>();
    const attention = opts.by === 'agent' ? this.deps.attention() : undefined;
    for (const id of selected) {
      const resolved = this.resolve(workspace, id);
      if ('refused' in resolved) {
        refused.push(refusal(id, resolved.refused));
        continue;
      }
      const { tree } = resolved;
      if (tree.root.id !== id) {
        // Judged with its conductor when that was chosen too.
        if (!selected.has(tree.root.id)) refused.push(refusal(id, 'child'));
        continue;
      }
      const at = typeof until === 'function' ? until(id) : until;
      const why =
        at === undefined
          ? 'no-reset-time'
          : at <= now
            ? 'too-soon'
            : opts.by === 'agent' && at - now > AGENT_MAX_SNOOZE_MS
              ? 'too-far'
              : opts.by === 'agent' &&
                  tree.members.some((member) => attention?.get(member.id) === 'needs-attention')
                ? 'needs-you'
                : undefined;
      if (why !== undefined || at === undefined) refused.push(refusal(id, why ?? 'no-reset-time'));
      else accepted.set(id, { tree, until: at });
    }

    const trees = [...accepted.values()];
    const memento = this.write(trees, now, opts.reason);
    // Verify, as a hand settle does: something only main sees (an open run
    // using a session) keeps it in play, and a snooze it would only defer
    // must not land the moment the run ends.
    const derived = this.deps.attention();
    const undo: SettleMemento = {};
    for (const { tree } of trees) {
      if (tree.members.every((member) => derived.get(member.id) === 'snoozed')) continue;
      accepted.delete(tree.root.id);
      refused.push(refusal(tree.root.id, 'in-use'));
      for (const member of tree.members) {
        if (member.id in memento) {
          undo[member.id] = memento[member.id];
          delete memento[member.id];
        }
      }
    }
    if (Object.keys(undo).length > 0) this.deps.ledger.restore(undo);
    this.settled();

    const applied = sessionIds.filter((id) => {
      const root = treeRootOf(settleable(workspace), id);
      return root !== undefined && accepted.has(root.id);
    });
    const times = new Set([...accepted.values()].map((entry) => entry.until));
    return {
      applied,
      refused,
      memento,
      until: times.size === 1 ? [...times][0] : null,
    };
  }

  /**
   * Bring sessions back now. The person's wake leaves no mark (they know why)
   * and holds auto-settle off, as moving a session back does; an agent's
   * leaves one, so the person can see who did it.
   */
  public wake(workspaceId: string, sessionIds: string[], opts: { by: SnoozeActor }): BatchResult {
    const workspace = this.workspace(workspaceId);
    if (!workspace)
      return {
        applied: [],
        refused: sessionIds.map((id) => refusal(id, 'not-found')),
        memento: {},
      };
    const refused: Refusal[] = [];
    const trees = new Map<string, Tree>();
    const applied: string[] = [];
    for (const id of new Set(sessionIds)) {
      const resolved = this.resolve(workspace, id);
      if ('refused' in resolved) {
        refused.push(refusal(id, resolved.refused));
        continue;
      }
      if (!this.isSnoozed(resolved.tree)) {
        refused.push(refusal(id, 'not-snoozed'));
        continue;
      }
      trees.set(resolved.tree.root.id, resolved.tree);
      applied.push(id);
    }
    const memento = this.wakeTrees([...trees.values()], opts.by === 'agent' ? 'agent' : 'hold');
    return { applied, refused, memento };
  }

  /** A terminal started asking something. A new question always ends a snooze. */
  public raisedHand(instanceId: string): void {
    if (this.stopped) return;
    // A key pressed at the last question answered that one, not this.
    this.answering.delete(instanceId);
    const tree = this.snoozedTreeOfInstance(instanceId);
    if (tree) this.wakeTrees([tree], 'question');
  }

  /** A terminal stopped asking. If the person had pressed a key at it, that was their answer. */
  public loweredHand(instanceId: string): void {
    if (this.stopped) return;
    if (!this.answering.delete(instanceId)) return;
    const tree = this.snoozedTreeOfInstance(instanceId);
    if (tree) this.wakeTrees([tree], 'hold');
  }

  /**
   * The person typed into a terminal. Sending something (Enter) ends its
   * snooze; a key at a question ends it once the question goes away, since
   * a menu answers on a digit or Esc with no Enter. Typing alone does not.
   */
  public personInput(instanceId: string, data: string): void {
    if (this.stopped) return;
    const tree = this.snoozedTreeOfInstance(instanceId);
    if (!tree) return;
    if (pressesEnter(data)) {
      this.answering.delete(instanceId);
      this.wakeTrees([tree], 'hold');
      return;
    }
    if (isPersonKey(data) && this.deps.isAsking(instanceId)) this.answering.add(instanceId);
  }

  /** A turn failed or the CLI quit on an error. Old news, from before the snooze, is ignored. */
  public turnFailed(sessionId: string, info: { at: number }): void {
    if (this.stopped) return;
    const tree = this.snoozedTreeOf(sessionId);
    if (tree && this.isNews(tree, sessionId, info.at)) this.wakeTrees([tree], 'failure');
  }

  /** The session stopped on a usage limit. It comes back, unless the person asked to sit those out. */
  public usageLimitStopped(sessionId: string, info: { at: number }): void {
    if (this.stopped) return;
    if (this.deps.preferences.get().snoozeAtUsageLimit) return;
    const tree = this.snoozedTreeOf(sessionId);
    if (tree && this.isNews(tree, sessionId, info.at)) this.wakeTrees([tree], 'limit');
  }

  /**
   * A usage limit is known to reset at `resetsAt`. With the setting on, a
   * root's first stop parks its tree until then; a snooze already waiting on
   * a limit follows a reset that moved later. A snooze the person chose is
   * never replaced: "remind me at 5" reminds at 5. A child's limit never
   * parks its conductor.
   */
  public usageLimitHit(
    sessionId: string,
    info: { stoppedAt: number; resetsAt: number; newStop: boolean },
  ): 'snoozed' | 'extended' | 'skipped' {
    const located = findSessionById(this.deps.getWorkspaces(), sessionId);
    if (!located) return 'skipped';
    const resolved = this.resolve(located.workspace, sessionId);
    if ('refused' in resolved || resolved.tree.root.id !== sessionId) return 'skipped';
    const { tree } = resolved;
    const now = this.now();
    if (info.resetsAt <= now) return 'skipped';
    const record = this.deps.ledger.get(sessionId);
    if (record?.snoozedUntil !== undefined) {
      if (record.snoozeReason !== 'usage-limit' || info.resetsAt <= record.snoozedUntil)
        return 'skipped';
      this.write([{ tree, until: info.resetsAt }], now, 'usage-limit');
      this.settled();
      return 'extended';
    }
    if (!info.newStop || !this.deps.preferences.get().snoozeAtUsageLimit) return 'skipped';
    const result = this.snooze(located.workspace.id, [sessionId], info.resetsAt, {
      by: 'person',
      reason: 'usage-limit',
    });
    return result.applied.length > 0 ? 'snoozed' : 'skipped';
  }

  /** The session moved to another harness: a wait for the old one's limit is over. */
  public harnessSwitched(sessionId: string): void {
    if (this.stopped) return;
    const tree = this.snoozedTreeOf(sessionId);
    if (tree && this.deps.ledger.get(tree.root.id)?.snoozeReason === 'usage-limit')
      this.wakeTrees([tree], 'hold');
  }

  /** Wake every tree whose time has come, in one write, and wait for the next. */
  private wakeDue(): void {
    const now = this.now();
    const trees = new Map<string, Tree>();
    const orphans: string[] = [];
    for (const record of this.deps.ledger.snoozed()) {
      if ((record.snoozedUntil ?? Infinity) > now) break;
      const located = findSessionById(this.deps.getWorkspaces(), record.sessionId);
      const resolved = located && this.resolve(located.workspace, record.sessionId);
      if (!resolved || 'refused' in resolved) orphans.push(record.sessionId);
      else trees.set(resolved.tree.root.id, resolved.tree);
    }
    if (orphans.length > 0) this.deps.ledger.wake(orphans, now);
    if (trees.size > 0) this.wakeTrees([...trees.values()], 'time');
    else this.settled();
  }

  /**
   * End these trees' snoozes in one write. A cause marks only the root: the
   * tree is one row, and one Woke is enough. `time` becomes `limit-reset`
   * for a snooze that waited on a usage limit. A root a focused window is
   * showing is marked seen at once: it came back in front of the person.
   */
  private wakeTrees(trees: Tree[], kind: WakeKind): SettleMemento {
    if (trees.length === 0) return {};
    const now = this.now();
    const ids: string[] = [];
    const marks: Record<string, WakeCause> = {};
    for (const tree of trees) {
      for (const member of tree.members) {
        if (this.deps.ledger.get(member.id)?.snoozedUntil !== undefined) ids.push(member.id);
      }
      if (kind === 'hold') continue;
      const reason = this.deps.ledger.get(tree.root.id)?.snoozeReason;
      marks[tree.root.id] = kind === 'time' && reason === 'usage-limit' ? 'limit-reset' : kind;
    }
    const memento = this.deps.ledger.wake(ids, now, { marks, hold: kind === 'hold' });
    for (const tree of trees) {
      if (marks[tree.root.id] && this.deps.isViewedInFocusedWindow(tree.root.instanceId))
        this.deps.ledger.markSeen(tree.root.id, now);
    }
    this.settled();
    return memento;
  }

  /** Write snoozes for these trees, every member at its root's time. */
  private write(
    trees: { tree: Tree; until: number }[],
    now: number,
    reason: SnoozeReason | undefined,
  ): SettleMemento {
    if (trees.length === 0) return {};
    const targets: SnoozeTarget[] = trees.flatMap(({ tree, until }) =>
      tree.members.map((member) => ({
        sessionId: member.id,
        workspaceId: tree.workspace.id,
        activityAt: activityOf(member, this.deps.ledger.get(member.id)),
        until,
      })),
    );
    return this.deps.ledger.snooze(targets, now, reason);
  }

  /** Re-arm for the earliest snooze and let the derivation catch up. */
  private settled(): void {
    this.rearm();
    this.deps.changed();
  }

  private workspace(workspaceId: string): Workspace | undefined {
    return this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
  }

  /** The tree a listed session is in, or why it cannot be snoozed or woken. */
  private resolve(workspace: Workspace, sessionId: string): { tree: Tree } | { refused: string } {
    const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return { refused: 'not-found' };
    const listed = settleable(workspace);
    const root = treeRootOf(listed, sessionId);
    if (!root) return { refused: 'unlisted' };
    return { tree: { workspace, root, members: withDescendants(listed, root.id) } };
  }

  private isSnoozed(tree: Tree): boolean {
    return tree.members.some(
      (member) => this.deps.ledger.get(member.id)?.snoozedUntil !== undefined,
    );
  }

  private snoozedTreeOf(sessionId: string): Tree | undefined {
    const located = findSessionById(this.deps.getWorkspaces(), sessionId);
    if (!located) return undefined;
    const resolved = this.resolve(located.workspace, sessionId);
    return 'tree' in resolved && this.isSnoozed(resolved.tree) ? resolved.tree : undefined;
  }

  private snoozedTreeOfInstance(instanceId: string): Tree | undefined {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    return located ? this.snoozedTreeOf(located.session.id) : undefined;
  }

  /** Whether something that happened at `at` happened after the snooze began. */
  private isNews(tree: Tree, sessionId: string, at: number): boolean {
    const own: AttentionRecord | undefined = this.deps.ledger.get(sessionId);
    const since = own?.snoozedAt ?? this.deps.ledger.get(tree.root.id)?.snoozedAt;
    return since === undefined || at > since;
  }
}

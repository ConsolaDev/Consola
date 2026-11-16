import { activityOf, type Attention } from '../../shared/attention';
import type { Preferences } from '../../shared/preferences';
import type { Session, Workspace } from '../../shared/workspace';
import type { AttentionLedger } from './AttentionLedger';
import { sessionTrees, settleable, settleTargets } from './settling';

export const SWEEP_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface AutoSettlerDeps {
  getWorkspaces(): Workspace[];
  /** What main derived for every entry right now. Read once per sweep. */
  attention(): ReadonlyMap<string, Attention>;
  /** Sessions any source (an open or pending run) says it is holding. */
  heldSessionIds(): ReadonlySet<string>;
  /** Whether any window is showing this terminal, focused or not. */
  isShown(instanceId: string): boolean;
  ledger: Pick<AttentionLedger, 'get' | 'settle'>;
  preferences: {
    get(): Preferences;
    addPendingAutoSettle(sessionIds: string[]): void;
  };
  /** The ledger changed under the attention derivation: say it may now read differently. */
  changed(): void;
  now?: () => number;
}

/**
 * Moves old, idle work onto the Settled shelf. Nothing is deleted: settled is
 * a derived state (`settledAt` at or after the last activity), so any new
 * activity brings the session back without a write.
 *
 * The decision is main's alone, from the same derived attention the sidebar
 * reads. Built on `ready` and `exited`, which already exclude every session
 * with something unseen (`done`), something running, or a question open, so a
 * spurious `done` can only ever keep a session out of the shelf.
 */
export class AutoSettler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly deps: AutoSettlerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Sweep now and every five minutes after. */
  public start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Settle every tree whose members are all eligible. Returns the session ids moved. */
  public sweep(): string[] {
    const { autoSettleDays } = this.deps.preferences.get();
    if (autoSettleDays <= 0) return [];

    const held = this.deps.heldSessionIds();
    const attention = this.deps.attention();
    const now = this.now();
    const moved: string[] = [];
    // One ledger call for the whole sweep: it is one write, not one per session.
    const targets: ReturnType<typeof settleTargets> = [];

    for (const workspace of this.deps.getWorkspaces()) {
      for (const tree of sessionTrees(settleable(workspace))) {
        // A member already on the shelf blocks nothing; a tree wholly there has nothing to do.
        const idle = tree.filter((session) => attention.get(session.id) !== 'settled');
        if (idle.length === 0) continue;
        if (!idle.every((session) => this.eligible(session, attention.get(session.id), autoSettleDays * DAY_MS, now, held))) continue;
        targets.push(...settleTargets(workspace, tree, this.deps.ledger));
        moved.push(...tree.map((session) => session.id));
      }
    }
    if (targets.length === 0) return [];

    this.deps.ledger.settle(targets, now, { markSeen: false });
    // Before anything announces it: a window that hears of the settle must be able to explain it.
    this.deps.preferences.addPendingAutoSettle(moved);
    this.deps.changed();
    return moved;
  }

  private eligible(session: Session, attention: Attention | undefined, thresholdMs: number, now: number, held: ReadonlySet<string>): boolean {
    if (attention !== 'ready' && attention !== 'exited') return false;
    if (held.has(session.id)) return false;
    if (this.deps.isShown(session.instanceId)) return false;
    if (session.autoSettle === 'never') return false;
    const record = this.deps.ledger.get(session.id);
    const lastActiveAt = activityOf(session, record);
    if (now - lastActiveAt <= thresholdMs) return false;
    // An explicit un-settle holds off the sweep until new activity.
    return record?.settleHoldAt === undefined || record.settleHoldAt <= lastActiveAt;
  }
}

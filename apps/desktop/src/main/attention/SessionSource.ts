import type { Attention } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Workspace } from '../../shared/workspace';
import { findSessionByInstanceId } from '../attention';
import type { AttentionLedger } from './AttentionLedger';
import type { AttentionSource } from './AttentionSource';
import { deriveAttention } from './deriveAttention';
import { TurnSettle, type SettledStatus } from './turnSettle';

export interface SessionSourceDeps {
  getWorkspaces(): Workspace[];
  /** The terminal's live status; a terminal that is gone is `exited`. */
  terminalStatus(instanceId: string): TerminalStatus;
  ledger: Pick<AttentionLedger, 'get' | 'markFinished' | 'markSeen'>;
  /** Whether a focused window is showing this terminal right now. */
  isViewedInFocusedWindow?(instanceId: string): boolean;
  now?: () => number;
}

/**
 * Every session's attention, derived from its terminal and the ledger.
 *
 * An entry's key is the session id. This owns the `finishedAt` / `seenAt`
 * writes; `lastActiveAt` stays with `TurnActivity`, so no two components write
 * the same field.
 */
export class SessionSource implements AttentionSource {
  public readonly kind = 'session';
  private readonly subscribers = new Set<() => void>();
  private readonly settle: TurnSettle;
  private readonly now: () => number;

  constructor(private readonly deps: SessionSourceDeps) {
    this.now = deps.now ?? Date.now;
    this.settle = new TurnSettle((instanceId, status) => this.finished(instanceId, status), { persistent: true });
  }

  public read(): Map<string, Attention> {
    const entries = new Map<string, Attention>();
    for (const workspace of this.deps.getWorkspaces()) {
      for (const session of workspace.sessions) {
        entries.set(
          session.id,
          deriveAttention({
            terminal: this.deps.terminalStatus(session.instanceId),
            record: this.deps.ledger.get(session.id),
            isViewedInFocusedWindow: this.deps.isViewedInFocusedWindow?.(session.instanceId) ?? false,
            heldByOpenRun: false,
          })
        );
      }
    }
    return entries;
  }

  public subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** A terminal's status changed: feed the settle detector, and say reads may differ. */
  public statusChanged(instanceId: string, status: TerminalStatus): void {
    this.settle.observe(instanceId, status);
    this.refresh();
  }

  /** The person looked at a session: whatever finished before now is seen. */
  public markSeen(sessionId: string): void {
    this.deps.ledger.markSeen(sessionId, this.now());
    this.refresh();
  }

  /** A destroyed terminal's next life starts from nothing. */
  public forget(instanceId: string): void {
    this.settle.unwatch(instanceId);
    this.refresh();
  }

  /** Something `read()` depends on changed outside the terminal (the session list). */
  public refresh(): void {
    for (const cb of [...this.subscribers]) cb();
  }

  private finished(instanceId: string, status: SettledStatus): void {
    // Only a turn that ended in `ready` is work waiting to be looked at. One
    // that stopped at a prompt is `needs-attention`, and an exit is `exited`;
    // marking either would resurface as `done` when the session comes back.
    if (status !== 'ready') return;
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (!located) return;
    this.deps.ledger.markFinished(located.session.id, located.workspace.id, this.now());
    // Finishing under the person's eyes is not news: nothing was missed.
    if (this.deps.isViewedInFocusedWindow?.(instanceId)) this.deps.ledger.markSeen(located.session.id, this.now());
    this.refresh();
  }
}

import type { Attention } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Workspace } from '../../shared/workspace';
import { findSessionByInstanceId } from '../attention';
import type { AttentionLedger } from './AttentionLedger';
import type { HookInputs } from './hookSignals';
import type { AttentionSource } from './AttentionSource';
import { deriveAttention } from './deriveAttention';
import { TurnSettle, type SettledStatus } from './turnSettle';

export interface SessionSourceDeps {
  getWorkspaces(): Workspace[];
  /** The terminal's live status; a terminal that is gone is `exited`. */
  terminalStatus(instanceId: string): TerminalStatus;
  ledger: Pick<AttentionLedger, 'get' | 'markFinished' | 'markSeen' | 'clearFinished'>;
  /** Whether a focused window is showing this terminal right now. */
  isViewedInFocusedWindow?(instanceId: string): boolean;
  /** What the agent CLI's hooks last said about this terminal, if its driver has any. */
  hookInputs?(instanceId: string): HookInputs | undefined;
  /** Sessions an open automation run is using. Asked once per read. */
  heldSessionIds?(): ReadonlySet<string>;
  now?: () => number;
}

/**
 * How long a quiet screen waits on background work the agent reported running
 * before the turn counts as finished anyway. Hooks cannot say whether that
 * work is awaited (the agent will wake when it ends) or incidental (a dev
 * server that never ends); the first must hold the turn open, and the second
 * must not hold it open forever. The agent's own subagents are the exception:
 * they are always awaited, so a turn waiting on them is held without a bound.
 */
export const BACKGROUND_HOLD_MS = 5 * 60_000;

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
  /**
   * Turns that settled while the agent had background work running, until the
   * hold ends: with the timer that bounds it, or none while the agent awaits
   * its own subagents.
   */
  private readonly deferred = new Map<string, NodeJS.Timeout | undefined>();
  private readonly now: () => number;
  /** The last status each terminal reported, to tell a launch from a change within one. */
  private readonly lastStatus = new Map<string, TerminalStatus>();

  constructor(private readonly deps: SessionSourceDeps) {
    this.now = deps.now ?? Date.now;
    this.settle = new TurnSettle((instanceId, status) => this.finished(instanceId, status), {
      persistent: true,
    });
  }

  public read(): Map<string, Attention> {
    const entries = new Map<string, Attention>();
    const held = this.deps.heldSessionIds?.();
    for (const workspace of this.deps.getWorkspaces()) {
      for (const session of workspace.sessions) {
        entries.set(
          session.id,
          deriveAttention({
            terminal: this.deps.terminalStatus(session.instanceId),
            record: this.deps.ledger.get(session.id),
            isViewedInFocusedWindow:
              this.deps.isViewedInFocusedWindow?.(session.instanceId) ?? false,
            heldByOpenRun: held?.has(session.id) ?? false,
            hook: this.deps.hookInputs?.(session.instanceId),
          }),
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
    // Any new activity or exit makes a waiting finish moot: the next turn reports for itself.
    if (status !== 'ready') this.cancelDeferred(instanceId);
    const before = this.lastStatus.get(instanceId);
    this.lastStatus.set(instanceId, status);
    if (status !== 'exited' && (before === undefined || before === 'exited'))
      this.launched(instanceId);
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
    this.lastStatus.delete(instanceId);
    this.cancelDeferred(instanceId);
    this.settle.unwatch(instanceId);
    this.refresh();
  }

  /** Something `read()` depends on changed outside the terminal (the session list). */
  public refresh(): void {
    for (const cb of [...this.subscribers]) cb();
  }

  /**
   * A new lifetime begins. Whatever the last one finished is history: left in
   * the ledger it would read as a current `done` the moment the relaunched
   * terminal is idle.
   */
  private launched(instanceId: string): void {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (located) this.deps.ledger.clearFinished(located.session.id);
  }

  /** An unattended run's process exited with its work complete: a result nobody has looked at. */
  public runCompleted(instanceId: string): void {
    this.markFinished(instanceId);
  }

  private finished(instanceId: string, status: SettledStatus): void {
    // Only a turn that ended in `ready` is work waiting to be looked at. One
    // that stopped at a prompt is `needs-attention`, and an exit is `exited`;
    // marking either would resurface as `done` when the session comes back.
    if (status !== 'ready') return;
    // The screen is quiet, but the agent said work it awaits is still running:
    // that is a turn paused, not finished. Marking it `done` would send the
    // person to review something that is not yet there.
    if (this.deps.hookInputs?.(instanceId)?.holdingBackgroundWork) {
      this.defer(instanceId);
      return;
    }
    this.markFinished(instanceId);
  }

  /** What hooks say about a terminal changed: a turn waiting on background work may now be over. */
  public hookChanged(instanceId: string): void {
    if (this.deferred.has(instanceId)) {
      if (!this.deps.hookInputs?.(instanceId)?.holdingBackgroundWork) {
        this.cancelDeferred(instanceId);
        if (this.deps.terminalStatus(instanceId) === 'ready') this.markFinished(instanceId);
      } else {
        // Still held, but maybe on different work: subagents left, a dev server stays.
        this.defer(instanceId);
      }
    }
    this.refresh();
  }

  /** Hold a settled turn's finish: while the agent awaits its own subagents, else for BACKGROUND_HOLD_MS. */
  private defer(instanceId: string): void {
    const awaitingAgents = this.deps.hookInputs?.(instanceId)?.awaitingAgents ?? false;
    const bound = this.deferred.get(instanceId);
    // Already held the right way. A bound is never restarted, or the work it bounds could renew it forever.
    if (this.deferred.has(instanceId) && awaitingAgents === (bound === undefined)) return;
    if (bound) clearTimeout(bound);
    if (awaitingAgents) {
      this.deferred.set(instanceId, undefined);
      return;
    }
    const timer = setTimeout(() => {
      this.deferred.delete(instanceId);
      if (this.deps.terminalStatus(instanceId) === 'ready') this.markFinished(instanceId);
    }, BACKGROUND_HOLD_MS);
    timer.unref?.();
    this.deferred.set(instanceId, timer);
  }

  private cancelDeferred(instanceId: string): void {
    const timer = this.deferred.get(instanceId);
    if (timer) clearTimeout(timer);
    this.deferred.delete(instanceId);
  }

  private markFinished(instanceId: string): void {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (!located) return;
    this.deps.ledger.markFinished(located.session.id, located.workspace.id, this.now());
    // Finishing under the person's eyes is not news: nothing was missed.
    if (this.deps.isViewedInFocusedWindow?.(instanceId))
      this.deps.ledger.markSeen(located.session.id, this.now());
    this.refresh();
  }
}

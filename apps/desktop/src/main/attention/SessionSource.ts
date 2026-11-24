import type { Attention, SnoozeView } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Workspace } from '../../shared/workspace';
import { findSessionByInstanceId } from '../attention';
import type { AttentionLedger } from './AttentionLedger';
import type { HookInputs } from './hookSignals';
import type { AttentionSource } from './AttentionSource';
import { deriveAttention, effectiveStatus } from './deriveAttention';
import { TurnSettle } from './turnSettle';
import type { SettledStatus } from './turnSettle';

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
  /**
   * Hear a terminal start and stop asking the person something. Called before
   * anything derives from the change, so a snooze ended by a new question is
   * already ended when the question is first read.
   */
  hands?: { raised(instanceId: string): void; lowered(instanceId: string): void };
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
  /** Whether each terminal was last asking the person something, screen and hooks combined. */
  private readonly asking = new Map<string, boolean>();

  constructor(private readonly deps: SessionSourceDeps) {
    this.now = deps.now ?? Date.now;
    this.settle = new TurnSettle((instanceId, status) => this.finished(instanceId, status));
  }

  public read(): Map<string, Attention> {
    const entries = new Map<string, Attention>();
    const held = this.deps.heldSessionIds?.();
    const now = this.now();
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
            now,
          }),
        );
      }
    }
    return entries;
  }

  /**
   * Each session's snooze as a window draws it: the countdown while one runs,
   * and the Woke mark until the person looks. Only the Snoozer writes the
   * mark, and only on a tree's root, so this needs no tree logic of its own.
   * A mark is shown only while the session is back in play: one that went
   * onto a shelf again is not news.
   */
  public snoozes(attention: ReadonlyMap<string, Attention> = this.read()): Map<string, SnoozeView> {
    const views = new Map<string, SnoozeView>();
    const now = this.now();
    for (const workspace of this.deps.getWorkspaces()) {
      for (const session of workspace.sessions) {
        const record = this.deps.ledger.get(session.id);
        if (!record) continue;
        const view: SnoozeView = {};
        if (record.snoozedUntil !== undefined && record.snoozedUntil > now) {
          view.until = record.snoozedUntil;
          if (record.snoozeReason) view.reason = record.snoozeReason;
        }
        const derived = attention.get(session.id);
        const parked = derived === 'snoozed' || derived === 'settled';
        if (
          record.wokeAt !== undefined &&
          record.wakeCause !== undefined &&
          !parked &&
          (record.seenAt === undefined || record.seenAt < record.wokeAt)
        ) {
          view.wokeAt = record.wokeAt;
          if (record.wakeCause) view.wakeCause = record.wakeCause;
        }
        if (view.until !== undefined || view.wokeAt !== undefined) views.set(session.id, view);
      }
    }
    return views;
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
    this.noticeHand(instanceId, status);
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
    this.asking.delete(instanceId);
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
    const status = this.lastStatus.get(instanceId);
    if (status !== undefined) this.noticeHand(instanceId, status);
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

  /**
   * Tell the hands listener when a terminal starts or stops asking. The first
   * status a terminal reports counts: a launch that opens on a question is a
   * new question. One already open stays open through anything that does not
   * change it, which is what lets a snooze taken at a question hold.
   */
  private noticeHand(instanceId: string, screen: TerminalStatus): void {
    const asking =
      effectiveStatus(screen, this.deps.hookInputs?.(instanceId)) === 'needs-attention';
    const before = this.asking.get(instanceId);
    this.asking.set(instanceId, asking);
    if (asking && before !== true) this.deps.hands?.raised(instanceId);
    else if (!asking && before === true) this.deps.hands?.lowered(instanceId);
  }

  /** Whether this terminal is asking the person something right now, screen and hooks combined. */
  public isAsking(instanceId: string): boolean {
    return this.asking.get(instanceId) ?? false;
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

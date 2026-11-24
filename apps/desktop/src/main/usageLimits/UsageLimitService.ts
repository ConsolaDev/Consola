import type { TerminalStatus } from '../../shared/terminalStatus';
import { exhaustedWindows, harnessLimitedUntil, limitResetAt } from '../../shared/usageLimits';
import type { HarnessLimits, SessionUsageLimit, UsageLimitsState } from '../../shared/usageLimits';
import type { Session, Workspace } from '../../shared/workspace';
import { findSessionById, findSessionByInstanceId } from '../attention';
import type { Snoozer } from '../attention/Snoozer';
import { armAt } from '../attention/wakeTimer';
import type { ArmedTimer } from '../attention/wakeTimer';
import type { HarnessConfig, HarnessDriver } from '../drivers';
import type { JsonStateFile } from '../state/JsonStateFile';
import type { HarnessLimitsCache } from './HarnessLimitsCache';

/** A reset closer than this is not worth parking a session for: it would be back before the row moved. */
export const MIN_AUTO_SNOOZE_MS = 60_000;

/** Changes inside this window go out as one push, as attention's do. */
const PUSH_MS = 100;

/** Where a session's terminal has come to rest: the turn the limit stopped is over on screen. */
const AT_REST: ReadonlySet<TerminalStatus> = new Set(['ready', 'needs-attention', 'exited']);

/** One limited session, as kept and stored. */
interface StoredLimit extends SessionUsageLimit {
  /** The conversation that stopped. A session moved onto another (a switch, a fresh start) is no longer this limit's. */
  conversationId: string;
  /** The Snoozer has not yet been offered this stop. True once per stop, so an Undo is never snoozed again. */
  newStop: boolean;
}

export interface UsageLimitsStateFile {
  sessions: Record<string, StoredLimit>;
}

/** What a session's harness launches as, for asking its CLI. */
export interface HarnessTarget {
  harnessId: string;
  driver: HarnessDriver;
  config: HarnessConfig;
}

export interface UsageLimitServiceDeps {
  getWorkspaces(): Workspace[];
  /** The harness a session runs on, or undefined when its record is gone. */
  harnessOf(session: Session): HarnessTarget | undefined;
  cache: Pick<HarnessLimitsCache, 'ask' | 'fresh'>;
  snoozer: Pick<Snoozer, 'usageLimitStopped' | 'usageLimitHit'>;
  terminalStatus(instanceId: string): TerminalStatus;
  file: JsonStateFile<UsageLimitsStateFile>;
  now?: () => number;
  arm?: typeof armAt;
}

/**
 * Which sessions stopped on a usage limit, and when each may go on.
 *
 * Two questions, kept apart. When a session stopped comes from the session:
 * its CLI's hook (`turn-failed` with `limit`), or the CLI's own notice on its
 * screen. When the limit resets comes only from asking the harness's CLI
 * (`UsageLimitReporting.read`); no session lends another its reset, and no
 * time is ever read off a screen or guessed. A hook is the CLI saying so, so
 * it limits the session even before (or without) a time; a notice is words
 * on a screen the agent might have printed itself, so it limits only once
 * the CLI confirms a used-up window that binds the session.
 *
 * Owns when to offer an automatic snooze (the answer is in and the terminal
 * has come to rest, with the reset more than a minute away). The Snoozer
 * owns whether.
 */
export class UsageLimitService {
  private readonly sessions = new Map<string, StoredLimit>();
  private readonly harnesses = new Map<string, { resetsAt: number }>();
  private readonly listeners = new Set<(state: UsageLimitsState) => void>();
  private readonly now: () => number;
  private readonly arm: typeof armAt;
  private timer?: ArmedTimer;
  private push?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: UsageLimitServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.arm = deps.arm ?? armAt;
  }

  /** Read what was stored, then wait for the next reset. Never throws: a lost file forgets limits that will be seen again. */
  public load(): void {
    let stored: unknown = null;
    try {
      stored = this.deps.file.read();
    } catch (error) {
      console.error('Could not read usage limits; starting empty.', error);
    }
    const rows = (stored as { sessions?: unknown } | null)?.sessions;
    if (typeof rows === 'object' && rows !== null) {
      for (const [sessionId, row] of Object.entries(rows)) {
        const limit = normalize(row);
        if (limit) this.sessions.set(sessionId, limit);
      }
    }
    this.sync();
    this.rearm();
  }

  public stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.push) clearTimeout(this.push);
    this.push = undefined;
  }

  public state(): UsageLimitsState {
    const sessions: UsageLimitsState['sessions'] = {};
    for (const [sessionId, { conversationId: _c, newStop: _n, ...limit }] of this.sessions)
      sessions[sessionId] = limit;
    return { sessions, harnesses: Object.fromEntries(this.harnesses) };
  }

  /** Hear the state after each change, coalesced. Returns the unsubscribe. */
  public onChange(listener: (state: UsageLimitsState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** When a limited session may go on, while that is still ahead. */
  public resetFor(sessionId: string): number | undefined {
    const resetsAt = this.sessions.get(sessionId)?.resetsAt;
    return resetsAt !== undefined && resetsAt > this.now() ? resetsAt : undefined;
  }

  /** When a harness can be used again by any model, while that is still ahead. */
  public limitedUntil(harnessId: string): number | undefined {
    const resetsAt = this.harnesses.get(harnessId)?.resetsAt;
    return resetsAt !== undefined && resetsAt > this.now() ? resetsAt : undefined;
  }

  /** The CLI's hook said a turn stopped on a usage limit: the session is limited now, time or none. */
  public hookStopped(instanceId: string): void {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (!located) return;
    const { session } = located;
    const at = this.now();
    this.sessions.set(session.id, {
      stoppedAt: at,
      signal: 'hook',
      conversationId: session.claudeSessionId,
      newStop: true,
    });
    this.changed();
    this.deps.snoozer.usageLimitStopped(session.id, { at });
    void this.learn(session.id, at, 'hook');
  }

  /** What the hooks say the turn did next: a turn that ended, or the CLI done waiting, ends the limit. */
  public hookCleared(instanceId: string): void {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (located && this.sessions.delete(located.session.id)) this.changed();
  }

  /**
   * The screen began or stopped showing the CLI's notice. Acted on when it
   * appears, never on every settle. One that leaves ends a limit only the
   * notice said; a hook's stands until a hook ends it.
   */
  public noticeChanged(instanceId: string, showing: boolean): void {
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (!located) return;
    const id = located.session.id;
    const current = this.sessions.get(id);
    if (!showing) {
      if (current?.signal === 'notice') {
        this.sessions.delete(id);
        this.changed();
      }
      return;
    }
    if (current) return;
    void this.learn(id, this.now(), 'notice');
  }

  /** A terminal's status changed: one that has come to rest may now be parked until its reset. */
  public statusChanged(instanceId: string, status: TerminalStatus): void {
    if (!AT_REST.has(status)) return;
    const located = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (located && this.sessions.has(located.session.id)) this.offerSnooze(located.session.id);
  }

  /**
   * The session list changed: a deleted session's limit goes, and so does
   * one whose conversation was replaced (a harness switch, a fresh start).
   */
  public sync(): void {
    let removed = false;
    for (const [sessionId, limit] of this.sessions) {
      const located = findSessionById(this.deps.getWorkspaces(), sessionId);
      if (located && located.session.claudeSessionId === limit.conversationId) continue;
      this.sessions.delete(sessionId);
      removed = true;
    }
    if (removed) this.changed();
  }

  /**
   * Ask the session's harness for its limits, and settle what the stop at
   * `stoppedAt` means: whether it is a limit at all (for a notice), when it
   * resets, and whether to offer a snooze.
   */
  private async learn(
    sessionId: string,
    stoppedAt: number,
    signal: 'hook' | 'notice',
  ): Promise<void> {
    const located = findSessionById(this.deps.getWorkspaces(), sessionId);
    if (!located) return;
    const { session } = located;
    const target = this.deps.harnessOf(session);
    if (!target?.driver.usageLimits) {
      if (signal === 'hook') this.explain(session, 'its CLI reports no usage limits to Consola');
      return;
    }
    const limits = await this.deps.cache.ask(target.driver, target.config);
    const now = this.now();
    if (limits) this.noteHarness(target.harnessId, limits, now);
    if (!limits) {
      if (signal === 'hook') this.explain(session, 'the CLI did not answer');
      return;
    }
    const model = session.model;
    const exhausted = exhaustedWindows(limits, { now, model });
    if (signal === 'notice') {
      // Words on a screen limit nothing until the CLI agrees.
      if (this.sessions.has(sessionId) || exhausted.length === 0) return;
      this.sessions.set(sessionId, {
        stoppedAt,
        signal,
        conversationId: session.claudeSessionId,
        newStop: true,
      });
      this.deps.snoozer.usageLimitStopped(sessionId, { at: stoppedAt });
    }
    const limit = this.sessions.get(sessionId);
    // Superseded while the CLI was asked: a later stop learns for itself.
    if (!limit || limit.stoppedAt !== stoppedAt) return;
    const resetsAt = limitResetAt(limits, { now, stoppedAt, model });
    if (resetsAt === undefined)
      this.explain(
        session,
        !limits.available
          ? 'the CLI reports no plan limits'
          : exhausted.length === 0
            ? 'no window is used up'
            : 'a used-up window has no reset time',
      );
    const next: StoredLimit = { ...limit };
    if (resetsAt !== undefined) next.resetsAt = resetsAt;
    else delete next.resetsAt;
    if (exhausted[0]) next.window = exhausted[0].id;
    this.sessions.set(sessionId, next);
    this.changed();
    this.rearm();
    this.offerSnooze(sessionId);
  }

  /**
   * Offer the Snoozer a parked wait until the reset, once the answer is in
   * and the terminal has come to rest. `newStop` is spent on the first
   * offer, whatever the Snoozer does with it.
   */
  private offerSnooze(sessionId: string): void {
    const limit = this.sessions.get(sessionId);
    if (limit?.resetsAt === undefined || limit.resetsAt - this.now() <= MIN_AUTO_SNOOZE_MS) return;
    const located = findSessionById(this.deps.getWorkspaces(), sessionId);
    if (!located || !AT_REST.has(this.deps.terminalStatus(located.session.instanceId))) return;
    this.deps.snoozer.usageLimitHit(sessionId, {
      stoppedAt: limit.stoppedAt,
      resetsAt: limit.resetsAt,
      newStop: limit.newStop,
    });
    if (limit.newStop) {
      this.sessions.set(sessionId, { ...limit, newStop: false });
      this.persist();
    }
  }

  /** What a harness's answer says about the harness as a whole. */
  private noteHarness(harnessId: string, limits: HarnessLimits, now: number): void {
    const until = harnessLimitedUntil(limits, now);
    const before = this.harnesses.get(harnessId)?.resetsAt;
    if (until === before) return;
    if (until === undefined) this.harnesses.delete(harnessId);
    else this.harnesses.set(harnessId, { resetsAt: until });
    this.changed();
    this.rearm();
  }

  /** Wait for the earliest known reset, then ask again whether it really passed. */
  private rearm(): void {
    this.timer?.cancel();
    this.timer = undefined;
    const times = [
      ...[...this.sessions.values()].map((limit) => limit.resetsAt),
      ...[...this.harnesses.values()].map((harness) => harness.resetsAt),
    ].filter((at): at is number => at !== undefined);
    if (times.length === 0) return;
    this.timer = this.arm(Math.min(...times), () => void this.resetPassed(), this.now);
  }

  /**
   * Bring what each of these harnesses says up to date, for a picker about
   * to show them: asked again when the last answer is over a minute old,
   * waiting at most three seconds for all of them together.
   */
  public async refreshHarnesses(targets: HarnessTarget[]): Promise<void> {
    await Promise.all(
      targets.map(async (target) => {
        const known = await this.deps.cache.fresh(target.driver, target.config, {
          maxAgeMs: 60_000,
          waitMs: 3_000,
        });
        if (known) this.noteHarness(target.harnessId, known.limits, this.now());
      }),
    );
  }

  /** The machine woke: a reset may have passed while it slept. */
  public recheck(): void {
    void this.resetPassed();
  }

  /**
   * A known reset came. Ask each harness concerned once, and keep only the
   * limits its answer still shows; one whose reset moved later follows it,
   * and a snooze waiting on it is told.
   */
  private async resetPassed(): Promise<void> {
    const now = this.now();
    const dueHarnesses = [...this.harnesses].filter(([, harness]) => harness.resetsAt <= now);
    for (const [harnessId] of dueHarnesses) this.harnesses.delete(harnessId);
    const due = [...this.sessions].filter(
      ([, limit]) => limit.resetsAt !== undefined && limit.resetsAt <= now,
    );
    if (dueHarnesses.length > 0) this.changed();
    const asked = new Map<string, Promise<HarnessLimits | undefined>>();
    for (const [sessionId, limit] of due) {
      const located = findSessionById(this.deps.getWorkspaces(), sessionId);
      const target = located && this.deps.harnessOf(located.session);
      if (!located || !target) {
        this.sessions.delete(sessionId);
        continue;
      }
      let answer = asked.get(target.harnessId);
      if (!answer) {
        answer = this.deps.cache.ask(target.driver, target.config);
        asked.set(target.harnessId, answer);
      }
      const limits = await answer;
      const later = this.now();
      if (limits) this.noteHarness(target.harnessId, limits, later);
      const resetsAt =
        limits &&
        limitResetAt(limits, {
          now: later,
          stoppedAt: limit.stoppedAt,
          model: located.session.model,
        });
      // Passed and confirmed, or no answer to keep it on: the limit is over.
      if (resetsAt === undefined || resetsAt <= later) this.sessions.delete(sessionId);
      else {
        this.sessions.set(sessionId, { ...limit, resetsAt });
        this.offerSnooze(sessionId);
      }
    }
    this.changed();
    this.rearm();
  }

  /** One line per stop with no time, naming why. */
  private explain(session: Session, why: string): void {
    console.info(`Usage limit for "${session.name || session.id}" has no reset time: ${why}.`);
  }

  private changed(): void {
    this.persist();
    if (this.push) return;
    this.push = setTimeout(() => {
      this.push = undefined;
      const state = this.state();
      for (const listener of [...this.listeners]) {
        try {
          listener(state);
        } catch (error) {
          console.error('A usage-limit listener failed:', error);
        }
      }
    }, PUSH_MS);
    this.push.unref?.();
  }

  private persist(): void {
    try {
      this.deps.file.write({ sessions: Object.fromEntries(this.sessions) });
    } catch (error) {
      console.error('Could not write usage limits.', error);
    }
  }
}

/** A stored limit, or null when the row is not one. */
function normalize(value: unknown): StoredLimit | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.stoppedAt !== 'number' || !Number.isFinite(row.stoppedAt)) return null;
  if (row.signal !== 'hook' && row.signal !== 'notice') return null;
  if (typeof row.conversationId !== 'string') return null;
  const limit: StoredLimit = {
    stoppedAt: row.stoppedAt,
    signal: row.signal,
    conversationId: row.conversationId,
    newStop: row.newStop === true,
  };
  if (typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt))
    limit.resetsAt = row.resetsAt;
  if (typeof row.window === 'string') limit.window = row.window;
  return limit;
}

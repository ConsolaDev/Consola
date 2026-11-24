import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger } from './AttentionLedger';
import type { AttentionLedgerStateFile } from './AttentionLedger';
import { HookSignals } from './hookSignals';
import { SessionSource } from './SessionSource';
import { settleAndVerify } from './settling';
import { AGENT_MAX_SNOOZE_MS, Snoozer } from './Snoozer';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_000_000;

let dir: string;
let ledger: JsonAttentionLedger;
let terminals: Map<string, TerminalStatus>;
let held: Set<string>;
let viewed: Set<string>;
let prefs: { snoozeAtUsageLimit: boolean };
let hooks: HookSignals;
let source: SessionSource;
let snoozer: Snoozer;
let workspace: Workspace;

/** A conductor `p` with a child `k`, and a lone session `x`. */
function build(sessions = defaultSessions()) {
  workspace = makeWorkspace({ id: 'w1', sessions });
  terminals = new Map(sessions.map((session) => [session.instanceId, 'ready']));
  hooks = new HookSignals();
  source = new SessionSource({
    getWorkspaces: () => [workspace],
    terminalStatus: (instanceId) => terminals.get(instanceId) ?? 'exited',
    ledger,
    isViewedInFocusedWindow: (instanceId) => viewed.has(instanceId),
    hookInputs: (instanceId) => hooks.get(instanceId),
    heldSessionIds: () => held,
    hands: {
      raised: (instanceId) => snoozer.raisedHand(instanceId),
      lowered: (instanceId) => snoozer.loweredHand(instanceId),
    },
    now: () => Date.now(),
  });
  hooks.subscribe((instanceId) => source.hookChanged(instanceId));
  snoozer = new Snoozer({
    getWorkspaces: () => [workspace],
    ledger,
    attention: () => source.read(),
    isViewedInFocusedWindow: (instanceId) => viewed.has(instanceId),
    isAsking: (instanceId) => source.isAsking(instanceId),
    preferences: { get: () => prefs },
    changed: () => {},
  });
}

function defaultSessions() {
  return [
    makeSession({
      id: 'p',
      name: 'p',
      instanceId: 'inst-p',
      kind: 'conductor',
      groupId: undefined,
    }),
    makeSession({
      id: 'k',
      name: 'k',
      instanceId: 'inst-k',
      kind: 'interactive',
      groupId: undefined,
      parentSessionId: 'p',
    }),
    makeSession({
      id: 'x',
      name: 'x',
      instanceId: 'inst-x',
      kind: 'interactive',
      groupId: undefined,
    }),
  ];
}

/** Report a terminal's status the way main does: the source first, then the hooks. */
function status(instanceId: string, next: TerminalStatus) {
  terminals.set(instanceId, next);
  source.statusChanged(instanceId, next);
  hooks.statusChanged(instanceId, next);
}

const attention = (id: string) => source.read().get(id);
const snoozes = () => source.snoozes();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-snoozer-'));
  ledger = new JsonAttentionLedger(
    new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')),
  );
  held = new Set();
  viewed = new Set();
  prefs = { snoozeAtUsageLimit: false };
  build();
  // Every terminal has said something, as a running one would.
  for (const id of ['inst-p', 'inst-k', 'inst-x']) status(id, 'ready');
});

afterEach(() => {
  snoozer.stop();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Snoozer.snooze', () => {
  it('parks a conductor with its whole tree, and one Undo puts every member back', () => {
    const result = snoozer.snooze('w1', ['p'], T0 + HOUR, { by: 'person' });
    expect(result.applied).toEqual(['p']);
    expect(result.until).toBe(T0 + HOUR);
    expect(Object.keys(result.memento).sort()).toEqual(['k', 'p']);
    expect(attention('p')).toBe('snoozed');
    expect(attention('k')).toBe('snoozed');
    expect(snoozes().get('p')).toEqual({ until: T0 + HOUR });

    ledger.restore(result.memento);
    expect(ledger.get('p')).toBeUndefined();
    expect(attention('p')).toBe('ready');
  });

  it('refuses a child chosen alone, and carries one chosen with its conductor', () => {
    const alone = snoozer.snooze('w1', ['k'], T0 + HOUR, { by: 'person' });
    expect(alone.applied).toEqual([]);
    expect(alone.refused).toEqual([
      { sessionId: 'k', reason: 'child', message: 'Snoozes with its conductor.' },
    ]);
    const both = snoozer.snooze('w1', ['k', 'p'], T0 + HOUR, { by: 'person' });
    expect(both.applied.sort()).toEqual(['k', 'p']);
    expect(both.refused).toEqual([]);
  });

  it('refuses an unknown session and a time already passed', () => {
    const result = snoozer.snooze('w1', ['nope', 'x'], T0, { by: 'person' });
    expect(result.refused.map((entry) => [entry.sessionId, entry.reason])).toEqual([
      ['nope', 'not-found'],
      ['x', 'too-soon'],
    ]);
    expect(result.memento).toEqual({});
  });

  it('caps an agent at 30 days but not the person', () => {
    const far = T0 + AGENT_MAX_SNOOZE_MS + 1;
    expect(snoozer.snooze('w1', ['x'], far, { by: 'agent' }).refused[0]?.reason).toBe('too-far');
    expect(snoozer.snooze('w1', ['x'], far, { by: 'person' }).applied).toEqual(['x']);
  });

  it('lets the person snooze an open question, but not an agent', () => {
    status('inst-k', 'needs-attention');
    expect(snoozer.snooze('w1', ['p'], T0 + HOUR, { by: 'agent' }).refused[0]?.reason).toBe(
      'needs-you',
    );
    expect(snoozer.snooze('w1', ['p'], T0 + HOUR, { by: 'person' }).applied).toEqual(['p']);
  });

  it('takes the write back when an automation is using a member, and says so', () => {
    held.add('k');
    const result = snoozer.snooze('w1', ['p', 'x'], T0 + HOUR, { by: 'person' });
    expect(result.applied).toEqual(['x']);
    expect(result.refused).toEqual([
      { sessionId: 'p', reason: 'in-use', message: 'An automation is using it.' },
    ]);
    expect(Object.keys(result.memento)).toEqual(['x']);
    expect(ledger.get('p')).toBeUndefined();
    expect(ledger.get('k')).toBeUndefined();
  });

  it('clears settled, one shelf at a time, and a settle clears the snooze', () => {
    settleAndVerify(workspace, 'x', ledger, () => source.read(), T0);
    expect(attention('x')).toBe('settled');
    snoozer.snooze('w1', ['x'], T0 + HOUR, { by: 'person' });
    expect(ledger.get('x')?.settledAt).toBeUndefined();
    expect(attention('x')).toBe('snoozed');
    settleAndVerify(workspace, 'x', ledger, () => source.read(), T0 + 1);
    expect(ledger.get('x')?.snoozedUntil).toBeUndefined();
    expect(attention('x')).toBe('settled');
  });

  it('a different time per root reports no single time', () => {
    const result = snoozer.snooze('w1', ['p', 'x'], (id) => (id === 'p' ? T0 + HOUR : T0 + DAY), {
      by: 'person',
      reason: 'usage-limit',
    });
    expect(result.until).toBeNull();
    expect(ledger.get('x')?.snoozedUntil).toBe(T0 + DAY);
    expect(ledger.get('x')?.snoozeReason).toBe('usage-limit');
  });

  it('refuses a root with no reset time to wait for', () => {
    const result = snoozer.snooze('w1', ['x'], () => undefined, { by: 'person' });
    expect(result.refused[0]?.reason).toBe('no-reset-time');
  });
});

describe('Snoozer timer', () => {
  it('comes back at its time, marked Woke on the root only', () => {
    snoozer.snooze('w1', ['p'], T0 + HOUR, { by: 'person' });
    vi.advanceTimersByTime(HOUR - 1);
    expect(attention('p')).toBe('snoozed');
    vi.advanceTimersByTime(1);
    expect(attention('p')).toBe('ready');
    expect(ledger.get('p')).toMatchObject({ wokeAt: T0 + HOUR, wakeCause: 'time' });
    expect(ledger.get('k')?.wakeCause).toBeUndefined();
    expect(snoozes().get('p')).toEqual({ wokeAt: T0 + HOUR, wakeCause: 'time' });
    source.markSeen('p');
    expect(snoozes().get('p')).toBeUndefined();
  });

  it('a 30-day snooze does not come back at once, and arms the earliest first', () => {
    snoozer.snooze('w1', ['x'], T0 + 30 * DAY, { by: 'person' });
    snoozer.snooze('w1', ['p'], T0 + 2 * DAY, { by: 'person' });
    vi.advanceTimersByTime(2 * DAY);
    expect(attention('p')).toBe('ready');
    expect(attention('x')).toBe('snoozed');
    vi.advanceTimersByTime(28 * DAY);
    expect(attention('x')).toBe('ready');
  });

  it('wakes what came due while Consola was closed, before anything else runs', () => {
    snoozer.snooze('w1', ['x'], T0 + HOUR, { by: 'person' });
    snoozer.stop();
    vi.setSystemTime(T0 + 2 * HOUR);
    build();
    snoozer.start();
    expect(ledger.get('x')).toMatchObject({ wokeAt: T0 + 2 * HOUR, wakeCause: 'time' });
  });

  it('says limit-reset for a snooze that waited on a usage limit', () => {
    snoozer.snooze('w1', ['x'], T0 + HOUR, { by: 'person', reason: 'usage-limit' });
    vi.advanceTimersByTime(HOUR);
    expect(ledger.get('x')?.wakeCause).toBe('limit-reset');
  });

  it('marks a root the person is looking at as seen', () => {
    viewed.add('inst-x');
    snoozer.snooze('w1', ['x'], T0 + HOUR, { by: 'person' });
    vi.advanceTimersByTime(HOUR);
    expect(ledger.get('x')?.wokeAt).toBe(T0 + HOUR);
    expect(snoozes().get('x')).toBeUndefined();
  });

  it('re-checks after the machine sleeps past the time', () => {
    snoozer.snooze('w1', ['x'], T0 + HOUR, { by: 'person' });
    // The machine slept: the clock jumped and no timer ran.
    vi.setSystemTime(T0 + 3 * HOUR);
    snoozer.recheck();
    expect(attention('x')).toBe('ready');
  });
});

describe('Snoozer waking early', () => {
  it('wakes the tree on a new question from any member, marking the root', () => {
    snoozer.snooze('w1', ['p'], T0 + DAY, { by: 'person' });
    status('inst-k', 'needs-attention');
    expect(attention('p')).toBe('ready');
    expect(attention('k')).toBe('needs-attention');
    expect(ledger.get('p')).toMatchObject({ wakeCause: 'question' });
  });

  it('a question a hook reports wakes it too', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    hooks.apply('inst-x', { kind: 'needs-input', origin: 'question' });
    expect(attention('x')).toBe('needs-attention');
  });

  it('keeps a question already open when it was snoozed: ask me later', () => {
    status('inst-x', 'needs-attention');
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    status('inst-x', 'needs-attention');
    hooks.apply('inst-x', { kind: 'needs-input', origin: 'menu' });
    expect(attention('x')).toBe('snoozed');
  });

  it('finishing work does not wake it', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    status('inst-x', 'working');
    status('inst-x', 'ready');
    vi.advanceTimersByTime(5000);
    expect(attention('x')).toBe('snoozed');
  });

  it('a failure wakes it, but not one from before the snooze', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.turnFailed('x', { at: T0 });
    expect(attention('x')).toBe('snoozed');
    snoozer.turnFailed('x', { at: T0 + 1 });
    expect(ledger.get('x')?.wakeCause).toBe('failure');
  });

  it('Enter wakes it with no mark; typing alone does not', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.personInput('inst-x', 'hello');
    expect(attention('x')).toBe('snoozed');
    snoozer.personInput('inst-x', '\x1b\r');
    expect(attention('x')).toBe('snoozed');
    snoozer.personInput('inst-x', '\r');
    expect(attention('x')).toBe('ready');
    expect(ledger.get('x')?.wakeCause).toBeUndefined();
    expect(ledger.get('x')?.settleHoldAt).toBe(T0);
  });

  it('a key at a question wakes it when the question goes away, and not before', () => {
    status('inst-x', 'needs-attention');
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.personInput('inst-x', '2');
    expect(attention('x')).toBe('snoozed');
    status('inst-x', 'working');
    expect(attention('x')).toBe('working');
    expect(ledger.get('x')?.wakeCause).toBeUndefined();
  });

  it('a new question forgets a key pressed at the last one', () => {
    status('inst-x', 'needs-attention');
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.personInput('inst-x', 'y');
    // The question went away and a new one came, without the key being acted on.
    snoozer.raisedHand('inst-x');
    expect(ledger.get('x')?.wakeCause).toBe('question');
  });

  it('a usage-limit stop wakes it only with the setting off', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    prefs.snoozeAtUsageLimit = true;
    snoozer.usageLimitStopped('x', { at: T0 + 1 });
    expect(attention('x')).toBe('snoozed');
    prefs.snoozeAtUsageLimit = false;
    snoozer.usageLimitStopped('x', { at: T0 + 1 });
    expect(ledger.get('x')?.wakeCause).toBe('limit');
  });

  it('a harness switch ends a wait for a usage limit, and nothing else', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.harnessSwitched('x');
    expect(attention('x')).toBe('snoozed');
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person', reason: 'usage-limit' });
    snoozer.harnessSwitched('x');
    expect(attention('x')).toBe('ready');
    expect(ledger.get('x')?.wakeCause).toBeUndefined();
  });

  it('nothing wakes once stopped for quit', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    snoozer.stop();
    snoozer.turnFailed('x', { at: T0 + 1 });
    snoozer.personInput('inst-x', '\r');
    expect(attention('x')).toBe('snoozed');
  });
});

describe('Snoozer.wake', () => {
  it('the person brings a tree back from a child, with no mark', () => {
    snoozer.snooze('w1', ['p'], T0 + DAY, { by: 'person' });
    const result = snoozer.wake('w1', ['k'], { by: 'person' });
    expect(result.applied).toEqual(['k']);
    expect(attention('p')).toBe('ready');
    expect(ledger.get('p')?.wakeCause).toBeUndefined();
    // Undo snoozes it again.
    ledger.restore(result.memento);
    snoozer.rearm();
    expect(attention('p')).toBe('snoozed');
  });

  it('an agent leaves a mark; a session not snoozed is refused', () => {
    snoozer.snooze('w1', ['x'], T0 + DAY, { by: 'person' });
    const result = snoozer.wake('w1', ['x', 'p'], { by: 'agent' });
    expect(result.applied).toEqual(['x']);
    expect(result.refused.map((entry) => entry.reason)).toEqual(['not-snoozed']);
    expect(ledger.get('x')?.wakeCause).toBe('agent');
  });
});

describe('Snoozer.usageLimitHit', () => {
  const hit = (resetsAt: number, newStop = true) =>
    snoozer.usageLimitHit('x', { stoppedAt: T0, resetsAt, newStop });

  it('skips with the setting off, and snoozes until the reset with it on', () => {
    expect(hit(T0 + HOUR)).toBe('skipped');
    prefs.snoozeAtUsageLimit = true;
    expect(hit(T0 + HOUR)).toBe('snoozed');
    expect(ledger.get('x')).toMatchObject({ snoozedUntil: T0 + HOUR, snoozeReason: 'usage-limit' });
  });

  it('once per stop, so an Undo is not snoozed again', () => {
    prefs.snoozeAtUsageLimit = true;
    expect(hit(T0 + HOUR, false)).toBe('skipped');
  });

  it('follows a reset that moved later, but never replaces a time the person chose', () => {
    prefs.snoozeAtUsageLimit = true;
    hit(T0 + HOUR);
    expect(hit(T0 + 2 * HOUR, false)).toBe('extended');
    expect(ledger.get('x')?.snoozedUntil).toBe(T0 + 2 * HOUR);
    expect(hit(T0 + HOUR, false)).toBe('skipped');
    snoozer.snooze('w1', ['x'], T0 + 5 * HOUR, { by: 'person' });
    expect(hit(T0 + 9 * HOUR)).toBe('skipped');
    expect(ledger.get('x')?.snoozedUntil).toBe(T0 + 5 * HOUR);
  });

  it('a child stopping never parks its conductor', () => {
    prefs.snoozeAtUsageLimit = true;
    expect(snoozer.usageLimitHit('k', { stoppedAt: T0, resetsAt: T0 + HOUR, newStop: true })).toBe(
      'skipped',
    );
    expect(attention('p')).toBe('ready');
  });
});

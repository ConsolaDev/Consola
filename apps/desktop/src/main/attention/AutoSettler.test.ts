import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityOf } from '../../shared/attention';
import type { Attention } from '../../shared/attention';
import { DEFAULT_PREFERENCES } from '../../shared/preferences';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { NEW_SESSION_NAME } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { JsonStateFile } from '../state/JsonStateFile';
import { PreferencesService } from '../state/PreferencesService';
import { JsonAttentionLedger } from './AttentionLedger';
import type { AttentionLedgerStateFile } from './AttentionLedger';
import { AutoSettler, FIRST_SWEEP_GRACE_MS, SWEEP_INTERVAL_MS } from './AutoSettler';
import type { AutoSettlerDeps } from './AutoSettler';
import { SessionSource } from './SessionSource';
import { settleSession, unsettleSession } from './settling';

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

let dir: string;
let ledger: JsonAttentionLedger;
let preferences: PreferencesService;
let attention: Map<string, Attention>;
let held: Set<string>;
let shown: Set<string>;
let changed: number;
/** Windows that have said what they are showing; the sweeper waits for the first. */
let reporters: (() => void)[];
const reportFromAWindow = () => {
  for (const listener of [...reporters]) listener();
};

const old = (id: string, extra = {}) =>
  makeSession({
    id,
    name: id,
    instanceId: `inst-${id}`,
    kind: 'interactive',
    groupId: undefined,
    lastActiveAt: NOW - 30 * DAY,
    ...extra,
  });

function settler(sessions: ReturnType<typeof old>[], extra: Partial<AutoSettlerDeps> = {}) {
  const workspace = makeWorkspace({ id: 'w1', sessions });
  return new AutoSettler({
    getWorkspaces: () => [workspace],
    attention: () => attention,
    heldSessionIds: () => held,
    isShown: (instanceId) => shown.has(instanceId),
    ledger,
    preferences,
    changed: () => {
      changed++;
    },
    onWindowReport: (listener) => {
      reporters.push(listener);
      return () => {
        reporters = reporters.filter((candidate) => candidate !== listener);
      };
    },
    now: () => NOW,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-autosettle-'));
  ledger = new JsonAttentionLedger(
    new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')),
  );
  preferences = new PreferencesService(new JsonStateFile<unknown>(path.join(dir, 'p.json')));
  attention = new Map();
  held = new Set();
  shown = new Set();
  changed = 0;
  reporters = [];
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AutoSettler eligibility', () => {
  it('settles an idle session older than the threshold, and says it changed', () => {
    attention.set('a', 'ready');
    expect(settler([old('a')]).sweep()).toEqual(['a']);
    expect(ledger.get('a')?.settledAt).toBe(NOW);
    expect(changed).toBe(1);
  });

  it('settles an exited session too', () => {
    attention.set('a', 'exited');
    expect(settler([old('a')]).sweep()).toEqual(['a']);
  });

  it.each<Attention>(['needs-attention', 'done', 'working'])(
    'never settles a session that is %s',
    (state) => {
      attention.set('a', state);
      expect(settler([old('a')]).sweep()).toEqual([]);
      expect(ledger.get('a')).toBeUndefined();
    },
  );

  it('never settles a snoozed session: it has a time to come back at', () => {
    attention.set('a', 'snoozed');
    expect(settler([old('a')]).sweep()).toEqual([]);
  });

  it('never settles a session back from a snooze nobody has looked at, however old', () => {
    attention.set('a', 'ready');
    ledger.snooze(
      [{ sessionId: 'a', workspaceId: 'w1', activityAt: NOW - 30 * DAY, until: NOW - 20 * DAY }],
      NOW - 25 * DAY,
    );
    ledger.wake(['a'], NOW - DAY, { marks: { a: 'time' } });
    expect(settler([old('a')]).sweep()).toEqual([]);
    // Seen: its idle time counts from the wake, a day ago, not from its last turn.
    ledger.markSeen('a', NOW - DAY + 1);
    expect(settler([old('a')]).sweep()).toEqual([]);
  });

  it('never settles a session an open run holds', () => {
    attention.set('a', 'ready');
    held.add('a');
    expect(settler([old('a')]).sweep()).toEqual([]);
  });

  it('never settles a session a window is showing', () => {
    attention.set('a', 'ready');
    shown.add('inst-a');
    expect(settler([old('a')]).sweep()).toEqual([]);
  });

  it("never settles a session marked autoSettle: 'never'", () => {
    attention.set('a', 'ready');
    expect(settler([old('a', { autoSettle: 'never' })]).sweep()).toEqual([]);
  });

  it('leaves a session younger than the threshold', () => {
    attention.set('a', 'ready');
    expect(settler([old('a', { lastActiveAt: NOW - 6 * DAY })]).sweep()).toEqual([]);
  });

  it('uses the ledger for activity, not the creation seed', () => {
    attention.set('a', 'ready');
    ledger.touch('a', 'w1', NOW - 1 * DAY);
    expect(settler([old('a')]).sweep()).toEqual([]);
  });

  it('holds off after an explicit un-settle until the session has new activity', () => {
    attention.set('a', 'ready');
    ledger.touch('a', 'w1', NOW - 30 * DAY);
    ledger.unsettle(['a'], NOW - 20 * DAY);
    expect(settler([old('a')]).sweep()).toEqual([]);

    ledger.touch('a', 'w1', NOW - 10 * DAY); // new activity, which has since aged past the threshold
    expect(settler([old('a')]).sweep()).toEqual(['a']);
  });

  it('does nothing when auto-settle is off', () => {
    attention.set('a', 'ready');
    preferences.setAutoSettleDays(0);
    expect(settler([old('a')]).sweep()).toEqual([]);
    expect(changed).toBe(0);
  });

  it('says it swept after every sweep, moved or not, once the settle is written', () => {
    attention.set('a', 'ready');
    const settledWhenTold: (number | undefined)[] = [];
    const sweeper = settler([old('a')], {
      swept: () => settledWhenTold.push(ledger.get('a')?.settledAt),
    });
    sweeper.sweep();
    preferences.setAutoSettleDays(0);
    sweeper.sweep();
    expect(settledWhenTold).toEqual([NOW, NOW]);
  });

  it('honours a custom threshold', () => {
    attention.set('a', 'ready');
    preferences.setAutoSettleDays(40);
    expect(settler([old('a')]).sweep()).toEqual([]);
  });
});

describe('AutoSettler trees', () => {
  const tree = () => [
    old('root'),
    old('c1', { parentSessionId: 'root' }),
    old('c2', { parentSessionId: 'root' }),
  ];

  it('settles a tree root and children together when every member is eligible', () => {
    for (const id of ['root', 'c1', 'c2']) attention.set(id, 'ready');
    expect(settler(tree()).sweep().sort()).toEqual(['c1', 'c2', 'root']);
    for (const id of ['root', 'c1', 'c2']) expect(ledger.get(id)?.settledAt).toBe(NOW);
  });

  it.each([
    ['working', (_s: Set<string>, a: Map<string, Attention>) => a.set('c2', 'working')],
    ['held by a run', (s: Set<string>) => s.add('c1')],
  ])('settles nothing when one member is %s', (_label, block) => {
    for (const id of ['root', 'c1', 'c2']) attention.set(id, 'ready');
    block(held, attention);
    expect(settler(tree()).sweep()).toEqual([]);
    for (const id of ['root', 'c1', 'c2']) expect(ledger.get(id)).toBeUndefined();
  });

  it('settles nothing when one member is being viewed or is never-settle', () => {
    for (const id of ['root', 'c1', 'c2']) attention.set(id, 'ready');
    shown.add('inst-c1');
    expect(settler(tree()).sweep()).toEqual([]);
    shown.clear();
    const members = tree();
    members[2] = old('c2', { parentSessionId: 'root', autoSettle: 'never' });
    expect(settler(members).sweep()).toEqual([]);
  });

  it('writes the whole sweep as one file write', () => {
    for (const id of ['root', 'c1', 'c2']) attention.set(id, 'ready');
    const write = vi.spyOn(JsonStateFile.prototype, 'write');
    settler(tree()).sweep();
    expect(
      write.mock.calls.filter(([value]) => (value as { records?: unknown }).records !== undefined),
    ).toHaveLength(1);
    write.mockRestore();
  });
});

describe('the first sweep', () => {
  /** A session a restoring window is about to open: old, idle, and nobody has said so yet. */
  const restoring = () => {
    attention.set('a', 'ready');
    return settler([old('a')]);
  };

  it('does not sweep before a window has said what it is showing', () => {
    const settler = restoring();
    settler.start();

    // At start() nothing is being viewed and no terminal exists, so the
    // session the window is about to open looks every bit as idle as one
    // nobody has touched for a month.
    expect(ledger.get('a')).toBeUndefined();
    settler.stop();
  });

  it('sweeps once a window has reported, with what it reported taken into account', () => {
    const settler = restoring();
    settler.start();
    shown.add('inst-a'); // the restoring window opened it

    reportFromAWindow();

    expect(ledger.get('a')).toBeUndefined();
    settler.stop();
  });

  it('sweeps on the first report when the window is showing something else', () => {
    const settler = restoring();
    settler.start();

    reportFromAWindow();

    expect(ledger.get('a')?.settledAt).toBe(NOW);
    settler.stop();
  });

  it('sweeps anyway if no window ever reports, so a headless launch still settles', () => {
    const settler = restoring();
    settler.start();

    vi.advanceTimersByTime(FIRST_SWEEP_GRACE_MS);

    expect(ledger.get('a')?.settledAt).toBe(NOW);
    settler.stop();
  });

  it('sweeps once, however many windows report, and leaves the five-minute interval alone', () => {
    const settler = restoring();
    settler.start();

    reportFromAWindow();
    reportFromAWindow();
    vi.advanceTimersByTime(FIRST_SWEEP_GRACE_MS);
    expect(changed).toBe(1);

    ledger.touch('a', 'w1', NOW - 30 * DAY); // eligible again
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(changed).toBe(2);
    settler.stop();
  });

  it('stops cleanly before any of that has happened', () => {
    const settler = restoring();
    settler.start();
    settler.stop();

    reportFromAWindow();
    vi.advanceTimersByTime(FIRST_SWEEP_GRACE_MS + SWEEP_INTERVAL_MS);

    expect(ledger.get('a')).toBeUndefined();
  });
});

describe('the first-run explanation', () => {
  it('records what moved until the person acknowledges, and never again afterwards', () => {
    attention.set('a', 'ready');
    attention.set('b', 'ready');
    settler([old('a')]).sweep();
    expect(preferences.get().pendingAutoSettle).toEqual(['a']);

    // A later sweep adds to what is still unexplained.
    settler([old('a'), old('b')]).sweep();
    expect(preferences.get().pendingAutoSettle.sort()).toEqual(['a', 'b']);

    preferences.acknowledgeAutoSettle();
    expect(preferences.get()).toMatchObject({
      hasExplainedAutoSettle: true,
      pendingAutoSettle: [],
    });

    attention.set('c', 'ready');
    settler([old('c')]).sweep();
    expect(preferences.get().pendingAutoSettle).toEqual([]);
    expect(ledger.get('c')?.settledAt).toBe(NOW); // it still settles, quietly, once explained
  });

  it('does not name a session that may never have had a message: it is removed, not shelved', () => {
    attention.set('a', 'ready');
    attention.set('b', 'ready');
    settler([old('a'), old('b', { name: NEW_SESSION_NAME })]).sweep();
    expect(ledger.get('b')?.settledAt).toBe(NOW);
    expect(preferences.get().pendingAutoSettle).toEqual(['a']);
  });

  it('is announced to every window, once per install', () => {
    const heard: string[][] = [];
    preferences.onChange((next) => heard.push(next.pendingAutoSettle));
    attention.set('a', 'ready');
    settler([old('a')]).sweep();
    expect(heard).toEqual([['a']]);
  });

  it('survives a restart: an unexplained settle is explained on the next launch', () => {
    attention.set('a', 'ready');
    settler([old('a')]).sweep();
    const next = new PreferencesService(new JsonStateFile<unknown>(path.join(dir, 'p.json')));
    next.load();
    expect(next.get()).toMatchObject({ hasExplainedAutoSettle: false, pendingAutoSettle: ['a'] });
  });
});

describe('settling by hand and undoing it', () => {
  const sessions = () => [old('p'), old('k', { parentSessionId: 'p' }), old('other')];

  it('settles the session and its descendants, marking them seen, and not the rest', () => {
    const workspace = makeWorkspace({ id: 'w1', sessions: sessions() });
    ledger.markFinished('k', 'w1', NOW - 40 * DAY);
    settleSession(workspace, 'p', ledger, NOW);
    expect(ledger.get('p')).toMatchObject({ settledAt: NOW, seenAt: NOW });
    expect(ledger.get('k')).toMatchObject({
      settledAt: NOW,
      seenAt: NOW,
      finishedAt: NOW - 40 * DAY,
    });
    expect(ledger.get('other')).toBeUndefined();
  });

  it('undo restores the exact prior entries, so a row returns to its original slot', () => {
    const workspace = makeWorkspace({ id: 'w1', sessions: sessions() });
    ledger.touch('k', 'w1', NOW - 3 * DAY);
    ledger.markFinished('k', 'w1', NOW - 3 * DAY);
    const before = { p: ledger.get('p'), k: { ...ledger.get('k')! } };
    const slot = (id: string) =>
      activityOf(workspace.sessions.find((s) => s.id === id)!, ledger.get(id));
    const slots = { p: slot('p'), k: slot('k') };

    const memento = settleSession(workspace, 'p', ledger, NOW);
    expect(ledger.get('p')?.settledAt).toBe(NOW);
    ledger.restore(memento);

    expect(ledger.get('p')).toEqual(before.p); // had no entry: gone again
    expect(ledger.get('k')).toEqual(before.k);
    expect({ p: slot('p'), k: slot('k') }).toEqual(slots);
  });

  it('undo of an un-settle puts the settled state back', () => {
    const workspace = makeWorkspace({ id: 'w1', sessions: sessions() });
    settleSession(workspace, 'other', ledger, NOW);
    const settled = { ...ledger.get('other')! };
    const memento = unsettleSession(workspace, 'other', ledger, NOW + 1);
    expect(ledger.get('other')).toMatchObject({ settleHoldAt: NOW + 1 });
    expect(ledger.get('other')?.settledAt).toBeUndefined();
    ledger.restore(memento);
    expect(ledger.get('other')).toEqual(settled);
  });

  it('refuses to restore a malformed entry from outside', () => {
    ledger.restore({ x: { sessionId: 'y' } as never });
    expect(ledger.get('x')).toBeUndefined();
  });
});

describe('activity un-settles with no write', () => {
  it('derives back to ready from a later touch alone, and never writes a settle field', () => {
    const terminals = new Map<string, TerminalStatus>([['inst-a', 'ready']]);
    const workspace = makeWorkspace({ id: 'w1', sessions: [old('a')] });
    const source = new SessionSource({
      getWorkspaces: () => [workspace],
      terminalStatus: (instanceId) => terminals.get(instanceId) ?? 'exited',
      ledger,
      now: () => NOW,
    });
    settleSession(workspace, 'a', ledger, NOW);
    expect(source.read().get('a')).toBe('settled');

    const settledAt = ledger.get('a')!.settledAt;
    ledger.touch('a', 'w1', NOW + 1000);
    expect(source.read().get('a')).toBe('ready');
    expect(ledger.get('a')?.settledAt).toBe(settledAt); // untouched: nothing wrote to un-settle it
  });

  it('a settled session with a run holding it is not settled', () => {
    const workspace = makeWorkspace({ id: 'w1', sessions: [old('a')] });
    const source = new SessionSource({
      getWorkspaces: () => [workspace],
      terminalStatus: () => 'ready',
      ledger,
      heldSessionIds: () => new Set(['a']),
      now: () => NOW,
    });
    settleSession(workspace, 'a', ledger, NOW);
    expect(source.read().get('a')).toBe('ready');
  });
});

it('default preferences turn auto-settle on at seven days', () => {
  expect(DEFAULT_PREFERENCES).toMatchObject({ autoSettleDays: 7, hasExplainedAutoSettle: false });
});

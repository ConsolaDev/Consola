import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger, WRITE_INTERVAL_MS } from './AttentionLedger';
import type { AttentionLedgerStateFile } from './AttentionLedger';

let dir: string;

function filePath(): string {
  return path.join(dir, 'attention-ledger.json');
}

function build(): JsonAttentionLedger {
  const ledger = new JsonAttentionLedger(new JsonStateFile<AttentionLedgerStateFile>(filePath()));
  ledger.load();
  return ledger;
}

/** What a fresh process would see: the file, not the running ledger's memory. */
function onDisk(): Record<string, { lastActiveAt: number }> {
  return JSON.parse(fs.readFileSync(filePath(), 'utf8')).records;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-attention-'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JsonAttentionLedger.clearFinished', () => {
  it('drops the finish and keeps everything else; a no-op without one', () => {
    const ledger = build();
    ledger.clearFinished('s1');
    expect(ledger.get('s1')).toBeUndefined();
    ledger.touch('s1', 'w1', 10);
    ledger.markFinished('s1', 'w1', 20);
    ledger.markSeen('s1', 30);
    ledger.clearFinished('s1');
    expect(ledger.get('s1')).toEqual({
      sessionId: 's1',
      workspaceId: 'w1',
      lastActiveAt: 10,
      seenAt: 30,
    });
  });
});

describe('JsonAttentionLedger', () => {
  it('round-trips touch through get, activityFor and snapshot', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    ledger.touch('s2', 'w1', 20);

    expect(ledger.get('s1')).toEqual({ sessionId: 's1', workspaceId: 'w1', lastActiveAt: 10 });
    expect(ledger.get('missing')).toBeUndefined();
    expect(ledger.activityFor(['s1', 's2', 'missing'])).toEqual(
      new Map([
        ['s1', 10],
        ['s2', 20],
      ]),
    );
    expect(Object.keys(ledger.snapshot()).sort()).toEqual(['s1', 's2']);
  });

  it('never moves activity backwards', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 50);
    ledger.touch('s1', 'w1', 30);
    expect(ledger.get('s1')?.lastActiveAt).toBe(50);
  });

  it('writes the first touch at once, then coalesces touches inside 30 seconds into one write', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 1);
    expect(onDisk().s1.lastActiveAt).toBe(1);

    ledger.touch('s1', 'w1', 2);
    ledger.touch('s1', 'w1', 3);
    vi.advanceTimersByTime(WRITE_INTERVAL_MS - 1);
    expect(onDisk().s1.lastActiveAt).toBe(1);

    vi.advanceTimersByTime(1);
    expect(onDisk().s1.lastActiveAt).toBe(3);
  });

  it('does not let one session hold another back', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 1);
    ledger.touch('s2', 'w1', 2);
    expect(Object.keys(onDisk()).sort()).toEqual(['s1', 's2']);
  });

  it('flush persists a deferred write immediately', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 1);
    ledger.touch('s1', 'w1', 9);
    expect(onDisk().s1.lastActiveAt).toBe(1);

    ledger.flush();
    expect(onDisk().s1.lastActiveAt).toBe(9);
    // The timer it superseded must not write again.
    vi.advanceTimersByTime(WRITE_INTERVAL_MS);
    expect(onDisk().s1.lastActiveAt).toBe(9);
  });

  it('survives a relaunch', () => {
    const first = build();
    first.touch('s1', 'w1', 7);
    first.flush();

    expect(build().get('s1')).toEqual({ sessionId: 's1', workspaceId: 'w1', lastActiveAt: 7 });
  });

  it('prunes sessions that no longer exist, in memory and on disk', () => {
    const ledger = build();
    ledger.touch('keep', 'w1', 1);
    ledger.touch('gone', 'w1', 2);

    ledger.prune(new Set(['keep']));

    expect(ledger.get('gone')).toBeUndefined();
    expect(Object.keys(onDisk())).toEqual(['keep']);
  });

  it('starts empty, without throwing, when the file and its backup are unreadable', () => {
    fs.writeFileSync(filePath(), '{ not json');
    fs.writeFileSync(`${filePath()}.bak`, '{ nor this');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const ledger = build();

    expect(ledger.snapshot()).toEqual({});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips one malformed row without losing the others', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        records: {
          good: { sessionId: 'good', workspaceId: 'w1', lastActiveAt: 5, seenAt: 6 },
          bad: { sessionId: 'bad', workspaceId: 'w1', lastActiveAt: 'yesterday' },
        },
      }),
    );

    const ledger = build();

    expect(ledger.get('good')).toEqual({
      sessionId: 'good',
      workspaceId: 'w1',
      lastActiveAt: 5,
      seenAt: 6,
    });
    expect(ledger.get('bad')).toBeUndefined();
  });

  it('records a finish and a sighting without touching activity, and survives a reload', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    ledger.markFinished('s1', 'w1', 20);
    ledger.markSeen('s1', 30);
    ledger.flush();

    expect(ledger.get('s1')).toEqual({
      sessionId: 's1',
      workspaceId: 'w1',
      lastActiveAt: 10,
      finishedAt: 20,
      seenAt: 30,
    });
    expect(build().get('s1')?.seenAt).toBe(30);
  });

  it('starts a record at the finish when the session had none, and ignores a sighting of a stranger', () => {
    const ledger = build();
    ledger.markFinished('s1', 'w1', 20);
    ledger.markSeen('ghost', 30);
    expect(ledger.get('s1')?.lastActiveAt).toBe(20);
    expect(ledger.get('ghost')).toBeUndefined();
  });
});

describe('JsonAttentionLedger.unsettledAt', () => {
  const settle = (ledger: JsonAttentionLedger, at: number) =>
    ledger.settle([{ sessionId: 's1', workspaceId: 'w1', activityAt: 0 }], at, {
      markSeen: false,
    });

  it('marks the moment new activity takes a session off the shelf, and survives a reload', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    settle(ledger, 20);
    expect(ledger.get('s1')?.unsettledAt).toBeUndefined();

    ledger.touch('s1', 'w1', 30);
    expect(ledger.get('s1')?.unsettledAt).toBe(30);
    ledger.flush();
    expect(build().get('s1')?.unsettledAt).toBe(30);
  });

  it('is not moved by later activity, nor by a late edge from before the settle', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    settle(ledger, 20);
    ledger.touch('s1', 'w1', 15);
    expect(ledger.get('s1')?.unsettledAt).toBeUndefined();

    ledger.touch('s1', 'w1', 30);
    ledger.touch('s1', 'w1', 40);
    expect(ledger.get('s1')?.unsettledAt).toBe(30);
  });

  it('marks a session moved back by hand', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    settle(ledger, 20);
    ledger.unsettle(['s1'], 25);
    expect(ledger.get('s1')).toMatchObject({ unsettledAt: 25, settleHoldAt: 25 });
  });
});

describe('JsonAttentionLedger snoozing', () => {
  const target = (sessionId: string, until: number) => ({
    sessionId,
    workspaceId: 'w1',
    activityAt: 5,
    until,
  });

  it('writes a snooze, clears settled and an earlier wake, and lists soonest first', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    ledger.settle([{ sessionId: 's1', workspaceId: 'w1', activityAt: 10 }], 20, { markSeen: true });
    ledger.wake(['s1'], 21, { marks: { s1: 'time' } });
    ledger.snooze([target('s1', 500), target('s2', 300)], 30, 'usage-limit');
    expect(ledger.get('s1')).toEqual({
      sessionId: 's1',
      workspaceId: 'w1',
      lastActiveAt: 10,
      seenAt: 20,
      snoozedUntil: 500,
      snoozedAt: 30,
      snoozeReason: 'usage-limit',
    });
    expect(ledger.get('s2')?.lastActiveAt).toBe(5);
    expect(ledger.snoozed().map((record) => record.sessionId)).toEqual(['s2', 's1']);
  });

  it('wakes, marking only the sessions named, and holding auto-settle for the person', () => {
    const ledger = build();
    ledger.snooze([target('s1', 500), target('s2', 500)], 30);
    ledger.wake(['s1', 's2'], 40, { marks: { s1: 'question' } });
    expect(ledger.get('s1')).toMatchObject({ wokeAt: 40, wakeCause: 'question' });
    expect(ledger.get('s2')).toMatchObject({ wokeAt: 40 });
    expect(ledger.get('s2')?.wakeCause).toBeUndefined();
    expect(ledger.snoozed()).toEqual([]);
    ledger.snooze([target('s1', 500)], 50);
    ledger.wake(['s1'], 60, { hold: true });
    expect(ledger.get('s1')?.settleHoldAt).toBe(60);
  });

  it('undoing a snooze keeps a finish and activity written in between', () => {
    const ledger = build();
    ledger.touch('s1', 'w1', 10);
    const memento = ledger.snooze([target('s1', 500)], 30);
    ledger.touch('s1', 'w1', 40);
    ledger.markFinished('s1', 'w1', 45);
    ledger.restore(memento);
    expect(ledger.get('s1')).toEqual({
      sessionId: 's1',
      workspaceId: 'w1',
      lastActiveAt: 40,
      finishedAt: 45,
    });
  });

  it('undoing a snooze that created the record drops it, unless it gained activity since', () => {
    const ledger = build();
    const quiet = ledger.snooze([target('s1', 500)], 30);
    ledger.restore(quiet);
    expect(ledger.get('s1')).toBeUndefined();
    const busy = ledger.snooze([target('s2', 500)], 30);
    ledger.markFinished('s2', 'w1', 40);
    ledger.restore(busy);
    expect(ledger.get('s2')).toEqual({
      sessionId: 's2',
      workspaceId: 'w1',
      lastActiveAt: 5,
      finishedAt: 40,
    });
  });

  it('drops half a snooze, and unknown reasons or causes, when loading', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        records: {
          a: { sessionId: 'a', workspaceId: 'w', lastActiveAt: 1, snoozedUntil: 9 },
          b: {
            sessionId: 'b',
            workspaceId: 'w',
            lastActiveAt: 1,
            snoozedUntil: 9,
            snoozedAt: 2,
            snoozeReason: 'bored',
            wokeAt: 3,
            wakeCause: 'whim',
          },
        },
      }),
    );
    const ledger = build();
    expect(ledger.get('a')).toEqual({ sessionId: 'a', workspaceId: 'w', lastActiveAt: 1 });
    expect(ledger.get('b')).toEqual({
      sessionId: 'b',
      workspaceId: 'w',
      lastActiveAt: 1,
      snoozedUntil: 9,
      snoozedAt: 2,
      wokeAt: 3,
    });
  });
});

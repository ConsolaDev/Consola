import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger, WRITE_INTERVAL_MS, type AttentionLedgerStateFile } from './AttentionLedger';

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
    expect(ledger.get('s1')).toEqual({ sessionId: 's1', workspaceId: 'w1', lastActiveAt: 10, seenAt: 30 });
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
      ])
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
      })
    );

    const ledger = build();

    expect(ledger.get('good')).toEqual({ sessionId: 'good', workspaceId: 'w1', lastActiveAt: 5, seenAt: 6 });
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

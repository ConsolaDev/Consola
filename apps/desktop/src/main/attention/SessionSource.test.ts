import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger, type AttentionLedgerStateFile } from './AttentionLedger';
import { SessionSource } from './SessionSource';
import { SETTLE_MS } from './turnSettle';

let dir: string;
let ledger: JsonAttentionLedger;
let terminals: Map<string, TerminalStatus>;
let clock: number;
let source: SessionSource;

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-session-source-'));
  ledger = new JsonAttentionLedger(new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')));
  terminals = new Map([['inst-a', 'ready']]);
  clock = 1000;
  const workspace = makeWorkspace({ id: 'w1', sessions: [makeSession({ id: 'a', instanceId: 'inst-a' })] });
  source = new SessionSource({
    getWorkspaces: () => [workspace],
    terminalStatus: (instanceId) => terminals.get(instanceId) ?? 'exited',
    ledger,
    now: () => clock,
  });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function status(next: TerminalStatus) {
  terminals.set('inst-a', next);
  source.statusChanged('inst-a', next);
}

describe('SessionSource', () => {
  it('says done after a turn settles unseen, and ready again once the person has looked', () => {
    status('working');
    status('ready');
    expect(source.read().get('a')).toBe('ready'); // not yet settled: a blink between tool calls
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('done');

    clock = 6000;
    source.markSeen('a');
    expect(source.read().get('a')).toBe('ready');
  });

  it('does not call a turn done when it ends at a prompt, or the process exits', () => {
    status('working');
    status('needs-attention');
    vi.advanceTimersByTime(SETTLE_MS);
    status('working');
    status('exited');
    expect(source.read().get('a')).toBe('exited');
    expect(ledger.get('a')?.finishedAt).toBeUndefined();
  });

  it('does not call a session that was only ever ready done', () => {
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(source.read().get('a')).toBe('ready');
  });

  it('keeps a finish seen before the next turn from resurfacing', () => {
    status('working');
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);
    clock = 6000;
    source.markSeen('a');
    status('working');
    expect(source.read().get('a')).toBe('working');
    status('ready');
    expect(source.read().get('a')).toBe('ready');
  });

  it('tells subscribers when a status changes, and stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = source.subscribe(cb);
    status('working');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    status('ready');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not write lastActiveAt: that belongs to TurnActivity', () => {
    status('working');
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(ledger.get('a')?.lastActiveAt).toBe(ledger.get('a')?.finishedAt); // seeded from the finish, never advanced
    ledger.touch('a', 'w1', 9999);
    clock = 20000;
    status('working');
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(ledger.get('a')?.lastActiveAt).toBe(9999);
  });
});

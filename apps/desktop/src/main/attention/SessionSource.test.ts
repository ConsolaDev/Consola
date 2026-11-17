import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger, type AttentionLedgerStateFile } from './AttentionLedger';
import { HookSignals } from './hookSignals';
import { BACKGROUND_HOLD_MS, SessionSource } from './SessionSource';
import { SETTLE_MS } from './turnSettle';

let dir: string;
let ledger: JsonAttentionLedger;
let terminals: Map<string, TerminalStatus>;
let clock: number;
let source: SessionSource;
let viewed: Set<string>;
let hooks: HookSignals;

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-session-source-'));
  ledger = new JsonAttentionLedger(
    new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')),
  );
  terminals = new Map([['inst-a', 'ready']]);
  clock = 1000;
  viewed = new Set();
  hooks = new HookSignals();
  hooks.subscribe((instanceId) => source?.hookChanged(instanceId));
  const workspace = makeWorkspace({
    id: 'w1',
    sessions: [makeSession({ id: 'a', instanceId: 'inst-a' })],
  });
  source = new SessionSource({
    getWorkspaces: () => [workspace],
    terminalStatus: (instanceId) => terminals.get(instanceId) ?? 'exited',
    ledger,
    isViewedInFocusedWindow: (instanceId) => viewed.has(instanceId),
    hookInputs: (instanceId) => hooks.get(instanceId),
    now: () => clock,
  });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function status(next: TerminalStatus) {
  terminals.set('inst-a', next);
  hooks.statusChanged('inst-a', next);
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

  it('never calls a turn done when it finishes under a focused window', () => {
    viewed.add('inst-a');
    status('working');
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);

    expect(source.read().get('a')).toBe('ready');
    expect(ledger.get('a')?.seenAt).toBeGreaterThanOrEqual(ledger.get('a')!.finishedAt!);
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

describe('SessionSource with a run that finished its session', () => {
  it('says done for an unattended run whose process exited complete, until the person looks', () => {
    status('working');
    status('exited');
    expect(source.read().get('a')).toBe('exited');
    clock = 5000;
    source.runCompleted('inst-a');
    expect(source.read().get('a')).toBe('done');
    clock = 6000;
    source.markSeen('a');
    expect(source.read().get('a')).toBe('exited');
  });

  it('does not read the old finish as done when the session relaunches (a finish never outlives its lifetime)', () => {
    status('working');
    status('exited');
    clock = 5000;
    source.runCompleted('inst-a');
    expect(source.read().get('a')).toBe('done');

    // Relaunched in place and sitting idle at its prompt, never looked at.
    status('ready');
    expect(ledger.get('a')?.finishedAt).toBeUndefined();
    expect(source.read().get('a')).toBe('ready');

    // And exiting again without finishing anything is a plain exit, not the old done.
    status('exited');
    expect(source.read().get('a')).toBe('exited');
  });

  it('treats a destroyed terminal coming back as a new lifetime too', () => {
    status('exited');
    source.runCompleted('inst-a');
    source.forget('inst-a');
    status('ready');
    expect(source.read().get('a')).toBe('ready');
  });
});

describe('SessionSource with a session held by an open run', () => {
  it('passes the hold to the derivation: a settled session an open run uses is not settled', () => {
    const settledLedger = {
      ...ledger,
      get: () => ({ sessionId: 'a', workspaceId: 'w1', lastActiveAt: 100, settledAt: 200 }),
    } as unknown as JsonAttentionLedger;
    const workspace = makeWorkspace({
      id: 'w1',
      sessions: [makeSession({ id: 'a', instanceId: 'inst-a' })],
    });
    let held = false;
    const heldSource = new SessionSource({
      getWorkspaces: () => [workspace],
      terminalStatus: () => 'ready',
      ledger: settledLedger,
      heldSessionIds: () => (held ? new Set(['a']) : new Set()),
    });
    expect(heldSource.read().get('a')).toBe('settled');
    held = true;
    expect(heldSource.read().get('a')).toBe('ready');
  });
});

describe('SessionSource with hooks', () => {
  it('says needs-attention from a hook while the screen shows nothing, and ready again once answered', () => {
    status('working');
    status('ready'); // a question the screen has no marker for
    expect(source.read().get('a')).toBe('ready');

    hooks.apply('inst-a', { kind: 'needs-input', origin: 'menu' });
    expect(source.read().get('a')).toBe('needs-attention');

    status('working'); // the person answered
    expect(source.read().get('a')).toBe('working');
  });

  it('does not mark a turn finished when it ended with background work still running', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);

    expect(ledger.get('a')?.finishedAt).toBeUndefined();
    expect(source.read().get('a')).toBe('ready');
  });

  it('marks the turn finished once a stop reports nothing left running', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);

    expect(source.read().get('a')).toBe('done');
  });

  it('rewrites nothing when hooks never speak: the screen alone decides', () => {
    status('working');
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('done');
  });

  it('finishes the turn when a later stop reports nothing left running, with the screen still quiet', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
    status('ready');
    clock = 5000;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('ready');

    clock = 8000;
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
    expect(source.read().get('a')).toBe('done');
    expect(ledger.get('a')?.finishedAt).toBe(8000);
  });

  it('gives up waiting on background work that never ends, such as a dev server', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('ready');

    clock = 9000;
    vi.advanceTimersByTime(BACKGROUND_HOLD_MS);
    expect(source.read().get('a')).toBe('done');
  });

  it('does not finish a waiting turn after new work began', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    status('working');
    vi.advanceTimersByTime(BACKGROUND_HOLD_MS);
    expect(ledger.get('a')?.finishedAt).toBeUndefined();
    expect(source.read().get('a')).toBe('working');
  });
});

describe('SessionSource while the agent awaits its own subagents', () => {
  const awaitingTwo = { kind: 'turn-ended', backgroundWork: 2, backgroundAgents: 2 } as const;
  const nothingLeft = { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 } as const;

  it('stays working through the panel’s repaints, however long they run, and is done once they report back', () => {
    status('working');
    hooks.apply('inst-a', awaitingTwo);
    status('ready');
    // Observed live (2.1.326): the waiting agent's spinner stops, but its panel
    // of subagents repaints about once a second, so the screen reads as
    // working and quiet again, for longer than a turn takes to settle.
    for (let flicker = 0; flicker < 3; flicker++) {
      vi.advanceTimersByTime(SETTLE_MS);
      expect(source.read().get('a')).toBe('working');
      status('working');
      expect(source.read().get('a')).toBe('working');
      status('ready');
    }
    vi.advanceTimersByTime(BACKGROUND_HOLD_MS * 2); // a subagent's work is not bounded by a dev server's
    expect(ledger.get('a')?.finishedAt).toBeUndefined();
    expect(source.read().get('a')).toBe('working');

    // They finish: the agent takes a turn on what they found, and its stop reports nothing left.
    status('working');
    hooks.apply('inst-a', nothingLeft);
    status('ready');
    clock = 9000;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('done');
    expect(ledger.get('a')?.finishedAt).toBe(9000);
  });

  it('is done when they report back in a turn too short to read as working', () => {
    status('working');
    hooks.apply('inst-a', awaitingTwo);
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('working');

    clock = 8000;
    hooks.apply('inst-a', nothingLeft);
    expect(source.read().get('a')).toBe('done');
    expect(ledger.get('a')?.finishedAt).toBe(8000);
  });

  it('bounds the wait again once only other background work is left', () => {
    status('working');
    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 2, backgroundAgents: 1 });
    status('ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(source.read().get('a')).toBe('working');

    hooks.apply('inst-a', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 }); // a dev server is left
    expect(source.read().get('a')).toBe('ready');
    clock = 9000;
    vi.advanceTimersByTime(BACKGROUND_HOLD_MS);
    expect(source.read().get('a')).toBe('done');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { JsonStateFile } from '../state/JsonStateFile';
import { JsonAttentionLedger, type AttentionLedgerStateFile } from './AttentionLedger';
import { SessionSource } from './SessionSource';
import { settleAndVerify, settleMany, unsettleMany } from './settling';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-settling-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function world(held: string[] = []) {
  const ledger = new JsonAttentionLedger(
    new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')),
  );
  const sessions = ['p', 'k'].map((id) =>
    makeSession({
      id,
      name: id,
      instanceId: `inst-${id}`,
      kind: 'interactive',
      groupId: undefined,
      parentSessionId: id === 'k' ? 'p' : undefined,
      lastActiveAt: 10,
    }),
  );
  const workspace = makeWorkspace({ id: 'w1', sessions });
  const source = new SessionSource({
    getWorkspaces: () => [workspace],
    terminalStatus: (): TerminalStatus => 'ready',
    ledger,
    heldSessionIds: () => new Set(held),
    now: () => 500,
  });
  return { ledger, workspace, source };
}

describe('settleAndVerify', () => {
  it('reports a settle that reached the shelf, with the memento to undo it', () => {
    const w = world();
    const result = settleAndVerify(w.workspace, 'p', w.ledger, () => w.source.read(), 500);
    expect(result.settled).toBe(true);
    expect(Object.keys(result.memento).sort()).toEqual(['k', 'p']);
    expect(w.ledger.get('p')?.settledAt).toBe(500);
  });

  it('reports a settle that did not move the row, leaves nothing behind, and offers no undo', () => {
    // A run holds the child: it never reads settled, so the tree cannot reach the shelf.
    const w = world(['k']);
    const result = settleAndVerify(w.workspace, 'p', w.ledger, () => w.source.read(), 500);
    expect(result).toEqual({ settled: false, memento: {} });
    // A stale settledAt would shelve the session the moment the run let go of it.
    expect(w.ledger.get('p')).toBeUndefined();
    expect(w.ledger.get('k')).toBeUndefined();
  });
});

describe('settleMany and unsettleMany', () => {
  it('settles every chosen tree in one memento, carrying a child chosen with its conductor', () => {
    const w = world();
    const result = settleMany(w.workspace, ['k', 'p'], w.ledger, () => w.source.read(), 500);
    expect(result.applied.sort()).toEqual(['k', 'p']);
    expect(result.refused).toEqual([]);
    expect(Object.keys(result.memento).sort()).toEqual(['k', 'p']);
    w.ledger.restore(result.memento);
    expect(w.ledger.get('p')).toBeUndefined();
  });

  it('refuses a child chosen alone, and takes back a tree something still holds', () => {
    const lone = world();
    const alone = settleMany(lone.workspace, ['k'], lone.ledger, () => new Map(), 500);
    expect(alone.refused.map((entry) => entry.reason)).toEqual(['child']);

    const w = world(['k']);
    const held = settleMany(w.workspace, ['p'], w.ledger, () => w.source.read(), 500);
    expect(held.applied).toEqual([]);
    expect(held.refused.map((entry) => entry.reason)).toEqual(['in-use']);
    expect(held.memento).toEqual({});
    expect(w.ledger.get('p')).toBeUndefined();
  });

  it('brings settled trees back, and says which were not settled', () => {
    const w = world();
    settleMany(w.workspace, ['p'], w.ledger, () => w.source.read(), 500);
    const result = unsettleMany(w.workspace, ['p'], w.ledger, 600);
    expect(result.applied).toEqual(['p']);
    expect(w.ledger.get('p')?.settledAt).toBeUndefined();
    expect(unsettleMany(w.workspace, ['p'], w.ledger, 700).refused[0]?.reason).toBe('not-settled');
  });
});

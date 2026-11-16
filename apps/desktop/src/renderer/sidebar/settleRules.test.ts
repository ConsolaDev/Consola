import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { JsonStateFile } from '../../main/state/JsonStateFile';
import { JsonAttentionLedger, type AttentionLedgerStateFile } from '../../main/attention/AttentionLedger';
import { SessionSource } from '../../main/attention/SessionSource';
import { settleSession, unsettleSession } from '../../main/attention/settling';
import { makeSession, makeWorkspace } from '../../main/conductor/ConductorTools.test';
import { bucketize, type Bucket } from './bucketize';
import { sessionEntries, sessionKey } from './entries';
import { buildForest, type TreeNode } from './forest';
import { settleOffer } from './settleRules';

/**
 * What the person is promised, end to end: the real ledger and derivation, the
 * real entries, forest and buckets. An action the row offers must put the row
 * where the toast says it went.
 */
const NOW = 1_000_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-settle-rules-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Spec { id: string; parent?: string; terminal: TerminalStatus; /** An unseen finish: reads as done. */ finished?: boolean }

function world(specs: Spec[]) {
  const ledger = new JsonAttentionLedger(new JsonStateFile<AttentionLedgerStateFile>(path.join(dir, 'l.json')));
  const sessions = specs.map((spec) =>
    makeSession({ id: spec.id, name: spec.id, instanceId: `inst-${spec.id}`, kind: 'interactive', groupId: undefined, parentSessionId: spec.parent, lastActiveAt: 10 }));
  const workspace = makeWorkspace({ id: 'w1', sessions });
  for (const spec of specs) if (spec.finished) ledger.markFinished(spec.id, 'w1', 20);
  const terminals = new Map<string, TerminalStatus>(specs.map((spec) => [`inst-${spec.id}`, spec.terminal]));
  const source = new SessionSource({ getWorkspaces: () => [workspace], terminalStatus: (i) => terminals.get(i) ?? 'exited', ledger, now: () => NOW });
  const forest = (): TreeNode[] =>
    buildForest(sessionEntries(sessions, { records: ledger.snapshot(), attention: Object.fromEntries(source.read()) }, []));
  const bucketOf = (id: string): Bucket => {
    const placed = bucketize(forest());
    const found = (Object.keys(placed) as Bucket[]).find((bucket) => placed[bucket].some((root) => root.entry.key === sessionKey(id) || root.children.some((c) => c.entry.key === sessionKey(id))));
    return found!;
  };
  /** The offer the row for `id` would carry, from the tree it sits in. */
  const offerFor = (id: string) => {
    for (const root of forest()) {
      if (root.entry.key === sessionKey(id)) return settleOffer(root, false);
      if (root.children.some((c) => c.entry.key === sessionKey(id))) return settleOffer(root.children.find((c) => c.entry.key === sessionKey(id))!, true);
    }
    throw new Error('no such row');
  };
  return { ledger, workspace, bucketOf, offerFor };
}

const SCENARIOS: { name: string; specs: Spec[]; target: string; lands: boolean }[] = [
  { name: 'an idle root', specs: [{ id: 'a', terminal: 'ready' }], target: 'a', lands: true },
  { name: 'a finished root the person has not opened (done)', specs: [{ id: 'a', terminal: 'ready', finished: true }], target: 'a', lands: true },
  { name: 'an exited root', specs: [{ id: 'a', terminal: 'exited' }], target: 'a', lands: true },
  { name: 'a conductor whose children are all idle', specs: [{ id: 'p', terminal: 'ready' }, { id: 'k', parent: 'p', terminal: 'ready' }], target: 'p', lands: true },
  { name: 'a child of an idle parent', specs: [{ id: 'p', terminal: 'ready' }, { id: 'k', parent: 'p', terminal: 'ready' }], target: 'k', lands: false },
  { name: 'a working root', specs: [{ id: 'a', terminal: 'working' }], target: 'a', lands: false },
  { name: 'a root that needs the person', specs: [{ id: 'a', terminal: 'needs-attention' }], target: 'a', lands: false },
  { name: 'a conductor with a working child', specs: [{ id: 'p', terminal: 'ready' }, { id: 'k', parent: 'p', terminal: 'working' }], target: 'p', lands: false },
];

describe('settling by hand, end to end', () => {
  it.each(SCENARIOS)('settling $name: lands in Settled exactly when it is offered', ({ specs, target, lands }) => {
    const w = world(specs);
    const offer = w.offerFor(target).kind;
    settleSession(w.workspace, target, w.ledger, NOW);
    expect(w.bucketOf(target) === 'settled').toBe(lands);
    expect(offer === 'settle').toBe(lands);
  });

  it('a done root is where settling is most wanted: it reads done first, then lands on the shelf', () => {
    const w = world([{ id: 'a', terminal: 'ready', finished: true }]);
    expect(w.bucketOf('a')).toBe('done');
    settleSession(w.workspace, 'a', w.ledger, NOW);
    expect(w.bucketOf('a')).toBe('settled');
  });

  it('a blocked row says why', () => {
    const w = world([{ id: 'a', terminal: 'working' }]);
    expect(w.offerFor('a')).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/working|needs you/i) });
  });

  it('undo returns the row to the bucket it left, and un-settling a shelved tree brings it back', () => {
    const w = world([{ id: 'p', terminal: 'ready' }, { id: 'k', parent: 'p', terminal: 'exited' }]);
    const before = w.bucketOf('p');
    const memento = settleSession(w.workspace, 'p', w.ledger, NOW);
    expect(w.bucketOf('p')).toBe('settled');
    expect(w.offerFor('p').kind).toBe('unsettle');
    w.ledger.restore(memento);
    expect(w.bucketOf('p')).toBe(before);

    settleSession(w.workspace, 'p', w.ledger, NOW);
    unsettleSession(w.workspace, 'p', w.ledger, NOW + 1);
    expect(w.bucketOf('p')).toBe('recent');
  });

  it('a settled child inside a tree that is not settled offers no way back of its own', () => {
    const w = world([{ id: 'p', terminal: 'ready' }, { id: 'k', parent: 'p', terminal: 'ready' }]);
    settleSession(w.workspace, 'k', w.ledger, NOW);
    expect(w.bucketOf('k')).toBe('recent');
    expect(w.offerFor('k').kind).toBe('blocked');
  });
});


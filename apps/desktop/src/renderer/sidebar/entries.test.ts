import { describe, expect, it, vi } from 'vitest';

// The provider reads attention through the store module, which pulls in the IPC bridge.
vi.mock('../services/attentionBridge', () => ({
  attentionBridge: { getSnapshot: vi.fn(), onChanged: vi.fn(() => () => {}) },
}));

import { createSessionRecord } from '../../shared/workspace';
import type { Session } from '../../shared/workspace';
import { applyFilter } from './filter';
import {
  filterSelection,
  idOfKey,
  runEntries,
  sessionEntries,
  sessionKey,
  waitingRuns,
} from './entries';
import type { RunListEntry } from '../../shared/automations';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    ...createSessionRecord({
      name: id,
      workspaceId: 'w',
      instanceId: `i-${id}`,
      harnessId: 'claude',
      scopeId: 'sc',
    }),
    id,
    lastActiveAt: 100,
    ...overrides,
  };
}

const none = { records: {}, attention: {} };

describe('sessionEntries', () => {
  it('joins a record with its derived attention and the ledger, and carries no payload', () => {
    const [entry] = sessionEntries(
      [session('a')],
      {
        records: { a: { sessionId: 'a', workspaceId: 'w', lastActiveAt: 500, finishedAt: 400 } },
        attention: { a: 'done' },
      },
      [],
    );

    expect(entry).toMatchObject({
      key: 'session:a',
      kind: 'session',
      attention: 'done',
      activityAt: 500,
      finishedAt: 400,
    });
    expect(Object.keys(entry).sort()).toEqual([
      'activityAt',
      'attention',
      'createdAt',
      'facetDomain',
      'facets',
      'finishedAt',
      'key',
      'kind',
      'labels',
    ]);
  });

  it('carries when the session was made, and when it last came back from Settled', () => {
    const [plain, woken] = sessionEntries(
      [session('a', { createdAt: 50 }), session('b', { createdAt: 60 })],
      {
        records: { b: { sessionId: 'b', workspaceId: 'w', lastActiveAt: 500, unsettledAt: 400 } },
        attention: {},
      },
      [],
    );
    expect(plain.createdAt).toBe(50);
    expect('unsettledAt' in plain).toBe(false);
    expect(woken).toMatchObject({ createdAt: 60, unsettledAt: 400 });
  });

  it('reads a session main said nothing about as ready, active at its creation seed', () => {
    const [entry] = sessionEntries([session('a')], none, []);
    expect(entry).toMatchObject({ attention: 'ready', activityAt: 100 });
  });

  it('takes its parent from parentSessionId, as a session key', () => {
    const entries = sessionEntries(
      [session('p'), session('c', { parentSessionId: 'p' })],
      none,
      [],
    );
    expect(entries[1].parent).toBe('session:p');
    expect(entries[0].parent).toBeUndefined();
  });

  it('fills scope, harness, model, automation, repo and read-only facets, and only the ones a session has', () => {
    const [full, bare] = sessionEntries(
      [
        session('a', {
          model: 'opus',
          toolPolicy: 'read-only',
          automation: { name: 'Review', runId: 'r' },
          workItem: { provider: 'github', repo: 'acme/api', type: 'pr', number: 1 },
        }),
        session('b'),
      ],
      none,
      [],
    );
    expect(full.facets).toEqual({
      scope: 'sc',
      harness: 'claude',
      model: 'opus',
      automation: 'Review',
      repo: 'acme/api',
      readOnly: 'read-only',
    });
    expect(bare.facets).toEqual({ scope: 'sc', harness: 'claude' });
  });

  it('answers for every session facet, so one it has no value for still hides it', () => {
    const [bare] = sessionEntries([session('b')], none, []);
    expect([...bare.facetDomain].sort()).toEqual([
      'automation',
      'harness',
      'model',
      'readOnly',
      'repo',
      'scope',
    ]);
  });

  it('keeps only labels that still exist', () => {
    const [entry] = sessionEntries([session('a', { labelIds: ['l1', 'gone'] })], none, [
      { id: 'l1', name: 'x' },
    ]);
    expect(entry.labels).toEqual(['l1']);
  });
});

describe('filterSelection', () => {
  const entries = sessionEntries(
    [
      session('a', { model: 'opus', labelIds: ['l1'] }),
      session('b', { scopeId: 'other', model: 'opus' }),
      session('c', { model: 'haiku' }),
    ],
    none,
    [{ id: 'l1', name: 'x' }],
  );

  it('lets the scope and the facets narrow together, through the same filter', () => {
    const selection = filterSelection('sc', { model: ['opus'] });
    expect(applyFilter(entries, selection).entries.map((e) => idOfKey(e.key))).toEqual(['a']);
  });

  it('reads a label choice as labels and an empty choice as no narrowing', () => {
    expect(
      applyFilter(entries, filterSelection(undefined, { label: ['l1'] })).entries.map((e) =>
        idOfKey(e.key),
      ),
    ).toEqual(['a']);
    expect(applyFilter(entries, filterSelection(undefined, {})).entries).toHaveLength(3);
  });
});

describe('keys', () => {
  it('round-trips a session id', () => {
    expect(idOfKey(sessionKey('abc'))).toBe('abc');
  });
});

const runOf = (id: string, rest: Partial<RunListEntry> = {}): RunListEntry =>
  ({
    id,
    automationId: 'review',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    status: 'needs-approval',
    ...rest,
  }) as RunListEntry;

describe('runEntries', () => {
  it('emits an entry only for a run main reported attention for, with no session needed', () => {
    const entries = runEntries([runOf('1'), runOf('2'), runOf('3', { sessionId: 's' })], {
      attention: { 'run:1': 'needs-attention' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'run:1',
      kind: 'run',
      attention: 'needs-attention',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      activityAt: Date.parse('2026-01-01T00:01:00.000Z'),
      facets: { automation: 'review' },
    });
    expect(idOfKey(entries[0].key)).toBe('1');
  });

  it('shares one answer with the surfaces that list waiting runs', () => {
    const runs = [runOf('1'), runOf('2')];
    const snapshot = { attention: { 'run:2': 'needs-attention' as const } };
    expect(waitingRuns(runs, snapshot).map((run) => run.id)).toEqual(
      runEntries(runs, snapshot).map((e) => idOfKey(e.key)),
    );
  });
});

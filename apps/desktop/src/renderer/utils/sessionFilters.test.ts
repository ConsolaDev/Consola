import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionRecord, createWorkspaceRecord, type Session } from '../../shared/workspace';
import { useSessionFilterStore } from '../stores/sessionFilterStore';
import { deriveFacets, effectiveFilters, hasActiveFilters, matchesFilters } from './sessionFilters';

function session(overrides: Partial<Session> = {}): Session {
  return {
    ...createSessionRecord({
      name: 'S',
      workspaceId: 'w',
      instanceId: `i-${Math.random()}`,
      harnessId: 'claude',
      model: undefined,
      scopeId: 'sc',
    }),
    ...overrides,
  };
}

describe('deriveFacets', () => {
  it('reads harness, model, automation, repo and read-only off fields that already exist', () => {
    const facets = deriveFacets([
      session({
        harnessId: 'claude',
        model: 'opus',
        automation: { name: 'Review', runId: 'r1' },
        toolPolicy: 'read-only',
        workItem: { provider: 'github', repo: 'acme/api', type: 'pr', number: 1 },
      }),
      session({ harnessId: 'claude', model: 'opus' }),
      session({ harnessId: 'work' }),
    ]);
    expect(facets.harness).toEqual([
      { value: 'claude', count: 2 },
      { value: 'work', count: 1 },
    ]);
    expect(facets.model).toEqual([{ value: 'opus', count: 2 }]);
    expect(facets.automation).toEqual([{ value: 'Review', count: 1 }]);
    expect(facets.repo).toEqual([{ value: 'acme/api', count: 1 }]);
    expect(facets.readOnly).toEqual([{ value: 'read-only', count: 1 }]);
  });
});

describe('matchesFilters', () => {
  it('ORs values within a facet and ANDs across facets', () => {
    const a = session({ harnessId: 'claude', model: 'opus' });
    const b = session({ harnessId: 'work', model: 'opus' });
    const c = session({ harnessId: 'work', model: 'haiku' });
    expect(
      [a, b, c].filter((s) => matchesFilters(s, { harness: ['claude', 'work'], model: ['opus'] })),
    ).toEqual([a, b]);
  });

  it('matches labels by id, any of the selected', () => {
    const tagged = session({ labelIds: ['l1', 'l2'] });
    expect(matchesFilters(tagged, { label: ['l2'] })).toBe(true);
    expect(matchesFilters(tagged, { label: ['l3'] })).toBe(false);
    expect(matchesFilters(session(), { label: ['l1'] })).toBe(false);
  });

  it('an empty filter matches everything', () => {
    expect(matchesFilters(session(), {})).toBe(true);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ label: ['l1'] })).toBe(true);
  });
});

describe('effectiveFilters', () => {
  it('drops a label that was deleted, so a stale selection never hides every row', () => {
    const workspace = createWorkspaceRecord('W', '/w', false);
    workspace.labels = [{ id: 'live', name: 'Live' }];
    const sessions = [session({ labelIds: ['gone', 'live'] })];
    expect(effectiveFilters(workspace, sessions, { label: ['gone'] })).toEqual({});
    expect(effectiveFilters(workspace, sessions, { label: ['gone', 'live'] })).toEqual({
      label: ['live'],
    });
  });

  it('drops a derived value no session has any more', () => {
    const workspace = createWorkspaceRecord('W', '/w', false);
    expect(
      effectiveFilters(workspace, [session({ model: 'opus' })], { model: ['haiku', 'opus'] }),
    ).toEqual({ model: ['opus'] });
  });
});

describe('sessionFilterStore', () => {
  beforeEach(() => useSessionFilterStore.setState({ filters: {} }));

  it('toggles a value on and off, per workspace', () => {
    const { toggle } = useSessionFilterStore.getState();
    toggle('w1', 'model', 'opus');
    toggle('w1', 'model', 'haiku');
    toggle('w2', 'model', 'opus');
    expect(useSessionFilterStore.getState().filters).toEqual({
      w1: { model: ['opus', 'haiku'] },
      w2: { model: ['opus'] },
    });
    toggle('w1', 'model', 'opus');
    toggle('w1', 'model', 'haiku');
    expect(useSessionFilterStore.getState().filters.w1).toEqual({});
  });

  it('clear forgets one workspace and leaves the others', () => {
    const { toggle, clear } = useSessionFilterStore.getState();
    toggle('w1', 'repo', 'a/b');
    toggle('w2', 'repo', 'a/b');
    clear('w1');
    expect(Object.keys(useSessionFilterStore.getState().filters)).toEqual(['w2']);
  });
});

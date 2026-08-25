import { describe, expect, it } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { Session, Workspace } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { itemRowsFor, sessionRowsFor } from './linkSessionRows';

const pr4118: WorkItemRef = { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number: 4118 };
const pr4100: WorkItemRef = { ...pr4118, number: 4100 };
const now = Date.parse('2026-08-25T10:00:00Z');

function makeItem(ref: WorkItemRef, title: string): InboxItem {
  return {
    workItem: ref,
    title,
    author: 'steve-sympower',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'none',
    commentCount: 0,
    updatedAt: '2026-08-25T09:00:00Z',
    url: `https://github.com/${ref.repo}/pull/${ref.number}`,
  };
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session',
    name: 'session',
    workspaceId: 'ws-1',
    instanceId: 'inst',
    claudeSessionId: 'uuid',
    hasStarted: true,
    harnessId: 'default',
    scopeId: 'scope-1',
    kind: 'interactive',
    createdAt: now - 3_600_000,
    lastActiveAt: now - 2 * 3_600_000,
    ...overrides,
  };
}

const investigation = makeSession({ id: 's-inv', name: 'energy axis investigation', instanceId: 'inst-inv', cwd: '/repos/flex-portal', lastActiveAt: now - 2 * 3_600_000 });
const scratch = makeSession({ id: 's-scratch', name: 'scratch: grafana panels', instanceId: 'inst-scratch', lastActiveAt: now - 86_400_000 });
const fixCi = makeSession({ id: 's-fixci', name: 'LC-416', instanceId: 'inst-fixci', workItem: pr4118, workItemAction: 'Fix CI', cwd: '/worktrees/flex-portal-pr-4118' });
const other = makeSession({ id: 's-other', name: 'UI-25', instanceId: 'inst-other', workItem: pr4100, workItemAction: 'Review' });
const conductor = makeSession({ id: 's-cond', name: 'sweep', instanceId: 'inst-cond', kind: 'conductor' });

const workspace = {
  id: 'ws-1',
  name: 'Sympower',
  defaultHarnessId: 'default',
  scopes: [{ id: 'scope-1', name: 'sympower', path: '/repos', isGitRepo: false, createdAt: now }],
  groups: [],
  actions: [],
  sectionDefaults: {},
  sessions: [scratch, investigation, fixCi, other, conductor],
  createdAt: now,
  updatedAt: now,
} as Workspace;

const working: TerminalState = { isBusy: true, isAwaitingConfirmation: false, hasExited: false, completedWhileAway: false, status: 'working' };

describe('sessionRowsFor', () => {
  const rows = sessionRowsFor(workspace, makeItem(pr4118, 'LC-416'), { 'inst-inv': working }, now);

  it('hides conductors and orders by recency', () => {
    expect(rows.map((row) => row.id)).toEqual(['s-inv', 's-fixci', 's-other', 's-scratch']);
  });

  it('labels rows with sessionLabel, where they run, and their age', () => {
    expect(rows[0]).toMatchObject({
      label: 'energy axis investigation',
      context: 'flex-portal · 2h ago',
      status: 'working',
      sessionId: 's-inv',
      workItem: pr4118,
    });
    // No cwd: the scope's folder is where it runs.
    expect(rows[3].context).toBe('repos · 1d ago');
  });

  it('greys a session already on this item, and one linked elsewhere, with a hint', () => {
    expect(rows[1]).toMatchObject({ label: 'PR #4118 · Fix CI', disabled: true, disabledHint: 'already on this item' });
    expect(rows[2]).toMatchObject({ label: 'PR #4100 · Review', disabled: true, disabledHint: 'already linked' });
    expect(rows[0].disabled).toBeUndefined();
  });
});

describe('itemRowsFor', () => {
  const items = [makeItem(pr4118, 'LC-416: fix energy axis'), makeItem(pr4100, 'UI-25 one year cap')];

  it('lists inbox items with number, title and repo, all pointing at the session', () => {
    const rows = itemRowsFor(items, investigation);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'github:sympower/flex-portal:pr:4118',
      label: '#4118 LC-416: fix energy axis',
      context: 'sympower/flex-portal',
      sessionId: 's-inv',
      workItem: pr4118,
    });
    expect(rows[0].disabled).toBeUndefined();
  });

  it('greys the item the session is already linked to', () => {
    const rows = itemRowsFor(items, fixCi);
    expect(rows[0]).toMatchObject({ disabled: true, disabledHint: 'already linked here' });
    expect(rows[1].disabled).toBeUndefined();
  });
});

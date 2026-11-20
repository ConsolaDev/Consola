import { Diff } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { createSessionRecord, createWorkspaceRecord, type Session } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import {
  bodyFor,
  isTabKindId,
  newTabOptions,
  TAB_KIND_IDS,
  TAB_KINDS,
  type TabKind,
  type TabKindId,
  tabFactsFor,
  tabKind,
} from './tabKinds';

const workspace = createWorkspaceRecord('catalog-portal', '/repos/catalog-portal', true, 'default');
const session = createSessionRecord({
  name: 'Paginate the catalog search',
  workspaceId: workspace.id,
  instanceId: 'i1',
  harnessId: 'default',
  scopeId: workspace.scopes[0].id,
});
const removedWorktree: RemovedWorktree = {
  path: '/tmp/wt',
  mainRepo: '/repos/catalog-portal',
  commit: 'a'.repeat(40),
  branch: 'consola/paginate-search',
  keepRef: 'refs/consola/worktrees/wt',
  trigger: 'settled',
  removedAt: 0,
};
const mainCheckout: CheckoutInfo = {
  kind: 'main',
  root: '/repos/catalog-portal',
  mainCheckout: '/repos/catalog-portal',
  branch: 'main',
};

const factsFor = (checkout: CheckoutInfo | undefined, changes: Partial<Session> = {}) =>
  tabFactsFor(workspace, { ...session, ...changes }, checkout);
const inGit = factsFor(mainCheckout);
const removed = factsFor(mainCheckout, { cwd: '/tmp/wt', removedWorktree });
const outsideGit = factsFor({ kind: 'none' });

const changesKind = tabKind('changes')!;
const frontOnly: TabKind = { ...changesKind, mount: 'front' };

describe('the registry', () => {
  it('lists the kinds in registry order with unique one-letter keys', () => {
    expect(TAB_KIND_IDS).toEqual(['changes']);
    expect(TAB_KINDS.map((kind) => kind.id)).toEqual(TAB_KIND_IDS);
    const keys = TAB_KINDS.map((kind) => kind.key);
    for (const key of keys) expect(key).toMatch(/^[A-Z]$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('knows only the kinds it lists', () => {
    expect(tabKind('changes')).toBe(TAB_KINDS[0]);
    expect(isTabKindId('changes')).toBe(true);
    expect(tabKind('browser')).toBeUndefined();
    expect(isTabKindId('browser')).toBe(false);
    expect(isTabKindId('new-tab')).toBe(false);
  });
});

describe('tabFactsFor', () => {
  it('tabFactsFor reads the checkout the agent is in', () => {
    const moved = factsFor(mainCheckout, { agentCwd: '/tmp/wt' });
    expect(moved.checkoutPath).toBe('/tmp/wt');
    expect(moved.checkout).toBe(mainCheckout);
    expect(moved.workspace).toBe(workspace);
    expect(moved.session.agentCwd).toBe('/tmp/wt');

    expect(
      factsFor(mainCheckout, { agentCwd: '/tmp/wt', removedWorktree }).checkoutPath,
    ).toBeUndefined();
  });
});

describe('Changes', () => {
  it('is titled Changes, keyed D and kept mounted behind', () => {
    expect(changesKind.title(inGit)).toBe('Changes');
    expect(changesKind.key).toBe('D');
    expect(changesKind.icon).toBe(Diff);
    expect(changesKind.mount).toBe('keep');
  });

  it('Changes is unavailable for a removed worktree and outside git', () => {
    expect(changesKind.availability(removed)).toEqual({
      available: false,
      reason: 'This session’s worktree was removed. It is rebuilt when the session next starts.',
    });
    expect(changesKind.availability(outsideGit)).toEqual({
      available: false,
      reason: 'This folder is not a git repository.',
    });
    expect(changesKind.availability(inGit)).toEqual({ available: true });
    expect(changesKind.availability(factsFor(undefined))).toEqual({ available: true });
  });
});

describe('bodyFor', () => {
  it.each([
    ['keep', 'available', 'behind', 'view'],
    ['keep', 'available', 'in front', 'view'],
    ['keep', 'unavailable', 'in front', 'unavailable'],
    ['keep', 'unavailable', 'behind', 'none'],
    ['front', 'available', 'behind', 'none'],
    ['front', 'available', 'in front', 'view'],
    ['front', 'unavailable', 'in front', 'unavailable'],
    ['front', 'unavailable', 'behind', 'none'],
  ] as const)('%s, %s, %s renders %s', (mount, availability, position, body) => {
    const kind = mount === 'keep' ? changesKind : frontOnly;
    const facts = availability === 'available' ? inGit : removed;
    expect(bodyFor(kind, facts, position === 'in front')).toBe(body);
  });
});

describe('newTabOptions', () => {
  it('newTabOptions puts available kinds first', () => {
    const a: TabKind = {
      ...changesKind,
      id: 'a' as TabKindId,
      key: 'A',
      availability: () => ({ available: false, reason: 'Not here.' }),
    };
    const b: TabKind = {
      ...changesKind,
      id: 'b' as TabKindId,
      key: 'B',
      availability: () => ({ available: true }),
    };
    expect(newTabOptions(inGit, [a, b])).toEqual([
      { kind: b, availability: { available: true } },
      { kind: a, availability: { available: false, reason: 'Not here.' } },
    ]);
  });

  it('lists the registry when given no kinds', () => {
    expect(newTabOptions(outsideGit).map((option) => option.kind)).toEqual([...TAB_KINDS]);
  });
});

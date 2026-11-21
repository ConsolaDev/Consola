import { Diff, FolderTree, GitPullRequest, Globe, TerminalSquare } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import type { WorkItemRef } from '../../shared/workItems';
import {
  createSessionRecord,
  createWorkspaceRecord,
  type Session,
  type Workspace,
} from '../../shared/workspace';
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
import { BROWSER_SHORTCUT_LABEL, isMac } from '../utils/platform';

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
// `scopeForSession` falls back to the first scope for a scope id it cannot
// find, so only a workspace left with no scopes gives a session no folder.
const noFolder = tabFactsFor(
  { ...workspace, scopes: [] },
  { ...session, scopeId: 'gone' },
  undefined,
);

const changesKind = tabKind('changes')!;
const filesKind = tabKind('files')!;
const terminalKind = tabKind('terminal')!;
const pullRequestKind = tabKind('pull-request')!;
const frontOnly: TabKind = { ...changesKind, mount: 'front' };

describe('the registry', () => {
  it('lists the kinds in registry order with unique one-letter keys', () => {
    expect(TAB_KIND_IDS).toEqual(['changes', 'files', 'terminal', 'browser', 'pull-request']);
    expect(TAB_KINDS.map((kind) => kind.id)).toEqual(TAB_KIND_IDS);
    const keys = TAB_KINDS.map((kind) => kind.key);
    for (const key of keys) expect(key).toMatch(/^[A-Z]$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('knows only the kinds it lists', () => {
    expect(tabKind('changes')).toBe(TAB_KINDS[0]);
    expect(isTabKindId('changes')).toBe(true);
    expect(tabKind('files')).toBe(TAB_KINDS[1]);
    expect(isTabKindId('files')).toBe(true);
    expect(tabKind('terminal')).toBe(TAB_KINDS[2]);
    expect(isTabKindId('terminal')).toBe(true);
    expect(tabKind('browser')).toBe(TAB_KINDS[3]);
    expect(isTabKindId('browser')).toBe(true);
    expect(tabKind('pull-request')).toBe(TAB_KINDS[4]);
    expect(isTabKindId('pull-request')).toBe(true);
    expect(tabKind('artifacts')).toBeUndefined();
    expect(isTabKindId('artifacts')).toBe(false);
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

describe('Files', () => {
  it('is titled Files, keyed F, has the explorer’s chord and is kept mounted behind', () => {
    expect(filesKind.title(inGit)).toBe('Files');
    expect(filesKind.key).toBe('F');
    expect(filesKind.icon).toBe(FolderTree);
    expect(filesKind.chord).toBe(isMac ? '⇧⌘E' : 'Ctrl+Shift+E');
    expect(filesKind.mount).toBe('keep');
  });

  it('Files is unavailable for a removed worktree', () => {
    expect(filesKind.availability(removed)).toEqual({
      available: false,
      reason: 'This session’s worktree was removed. It is rebuilt when the session next starts.',
    });
  });

  it('Files is unavailable for a session with no folder', () => {
    expect(noFolder.checkoutPath).toBeUndefined();
    expect(filesKind.availability(noFolder)).toEqual({
      available: false,
      reason: 'This session has no folder.',
    });
  });

  it('Files is available in any folder, in git or not', () => {
    expect(filesKind.availability(inGit)).toEqual({ available: true });
    expect(filesKind.availability(outsideGit)).toEqual({ available: true });
    expect(filesKind.availability(factsFor(undefined))).toEqual({ available: true });
  });
});

describe('Terminal', () => {
  it('is titled Terminal, keyed T, has the shell’s chord and mounts only in front', () => {
    expect(terminalKind.title(inGit)).toBe('Terminal');
    expect(terminalKind.key).toBe('T');
    expect(terminalKind.icon).toBe(TerminalSquare);
    expect(terminalKind.chord).toBe('Ctrl+`');
    expect(terminalKind.mount).toBe('front');
  });

  // Attaching a shell makes main rebuild a removed worktree, so the tab
  // must never be what puts one back.
  it('Terminal is unavailable for a removed worktree, and for a session with no folder', () => {
    expect(terminalKind.availability(removed)).toEqual({
      available: false,
      reason: 'This session’s worktree was removed. It is rebuilt when the session next starts.',
    });
    expect(terminalKind.availability(noFolder)).toEqual({
      available: false,
      reason: 'This session has no folder.',
    });
  });

  it('Terminal is available in any folder, in git or not', () => {
    expect(terminalKind.availability(inGit)).toEqual({ available: true });
    expect(terminalKind.availability(outsideGit)).toEqual({ available: true });
    expect(terminalKind.availability(factsFor(undefined))).toEqual({ available: true });
  });

  it('the Terminal tab mounts only in front', () => {
    expect(bodyFor(terminalKind, inGit, false)).toBe('none');
    expect(bodyFor(terminalKind, inGit, true)).toBe('view');
    // In front, a removed worktree or a missing folder says why and starts
    // no shell, so a removed worktree is never rebuilt by a tab.
    expect(bodyFor(terminalKind, removed, true)).toBe('unavailable');
    expect(bodyFor(terminalKind, removed, false)).toBe('none');
    expect(bodyFor(terminalKind, noFolder, true)).toBe('unavailable');
  });
});

describe('Browser', () => {
  const browser = tabKind('browser')!;

  it('is titled Browser, keyed B, with the browser chord, and mounted only in front', () => {
    expect(browser.title(inGit)).toBe('Browser');
    expect(browser.tabTitle).toBeUndefined();
    expect(browser.key).toBe('B');
    expect(browser.icon).toBe(Globe);
    expect(browser.chord).toBe(BROWSER_SHORTCUT_LABEL);
    expect(browser.mount).toBe('front');
  });

  // Its tabs belong to the session and its logins to the workspace: it reads no checkout.
  it('applies to every session, a removed worktree and a folder outside git included', () => {
    for (const facts of [inGit, removed, outsideGit, factsFor(undefined)]) {
      expect(browser.availability(facts)).toEqual({ available: true });
    }
  });

  // Mounting its view claims the page slot and clears the agent's dot, so a
  // tab behind another must not mount it.
  it('renders only in front, so a Browser tab behind another claims no slot', () => {
    expect(bodyFor(browser, inGit, false)).toBe('none');
    expect(bodyFor(browser, removed, true)).toBe('view');
  });
});

describe('Pull request', () => {
  const account: Workspace = {
    ...workspace,
    provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
  };
  const ref = (type: WorkItemRef['type'], number: number): WorkItemRef => ({
    provider: 'github',
    repo: 'sprocket/catalog-portal',
    type,
    number,
  });
  const linked = (workItem: WorkItemRef | undefined, onWorkspace: Workspace = account) =>
    tabFactsFor(onWorkspace, { ...session, workItem }, mainCheckout);

  it('is keyed P, has no chord and is kept mounted behind', () => {
    expect(pullRequestKind.key).toBe('P');
    expect(pullRequestKind.icon).toBe(GitPullRequest);
    expect(pullRequestKind.chord).toBeUndefined();
    expect(pullRequestKind.mount).toBe('keep');
  });

  it('is titled by the linked item, and its tab by the shortest name for it', () => {
    const pr = linked(ref('pr', 51));
    expect(pullRequestKind.title(pr)).toBe('Pull request #51');
    expect(pullRequestKind.tabTitle?.(pr)).toBe('#51');

    const issue = linked(ref('issue', 12));
    expect(pullRequestKind.title(issue)).toBe('Issue #12');
    expect(pullRequestKind.tabTitle?.(issue)).toBe('Issue');

    const none = linked(undefined);
    expect(pullRequestKind.title(none)).toBe('Pull request');
    expect(pullRequestKind.tabTitle?.(none) ?? pullRequestKind.title(none)).toBe('Pull request');
  });

  it('Pull request is unavailable for an unlinked session, and without an account', () => {
    expect(pullRequestKind.availability(linked(undefined))).toEqual({
      available: false,
      reason: 'This session is not linked to a pull request or issue.',
    });
    expect(pullRequestKind.availability(linked(ref('pr', 51), workspace))).toEqual({
      available: false,
      reason: 'This workspace has no account to read it with. Add one in Workspace settings.',
    });
    // Neither linked nor readable: not being linked is what the person can act on first.
    expect(pullRequestKind.availability(linked(undefined, workspace))).toEqual({
      available: false,
      reason: 'This session is not linked to a pull request or issue.',
    });
    expect(pullRequestKind.availability(linked(ref('pr', 51)))).toEqual({ available: true });
    expect(pullRequestKind.availability(linked(ref('issue', 12)))).toEqual({ available: true });
  });

  it('Pull request needs no folder: it reads the item, not the checkout', () => {
    const workItem = ref('pr', 51);
    const worktreeGone = tabFactsFor(
      account,
      { ...session, workItem, cwd: '/tmp/wt', removedWorktree },
      mainCheckout,
    );
    expect(worktreeGone.checkoutPath).toBeUndefined();
    expect(pullRequestKind.availability(worktreeGone)).toEqual({ available: true });

    const scopeGone = tabFactsFor(
      { ...account, scopes: [] },
      { ...session, workItem, scopeId: 'gone' },
      undefined,
    );
    expect(scopeGone.checkoutPath).toBeUndefined();
    expect(pullRequestKind.availability(scopeGone)).toEqual({ available: true });
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
    expect(newTabOptions(inGit).map((option) => option.kind)).toEqual([...TAB_KINDS]);
  });
});

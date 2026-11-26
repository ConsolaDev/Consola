import { describe, expect, it } from 'vitest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';
import type { Session } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import {
  baseLine,
  branchLabel,
  branchSectionShown,
  plural,
  pushValue,
  uncommittedValue,
} from './branchLines';

const workspace = createWorkspaceRecord('catalog-portal', '/repos/catalog-portal', true);
const session = createSessionRecord({
  name: 'Paginate the catalog search',
  workspaceId: workspace.id,
  instanceId: 'i1',
  harnessId: 'default',
  scopeId: workspace.scopes[0].id,
});
const removed = (branch: string | null, commit: string): Session => {
  const removedWorktree: RemovedWorktree = {
    path: '/repos/catalog-portal-7f3a',
    mainRepo: '/repos/catalog-portal',
    commit,
    branch,
    keepRef: 'refs/consola/worktrees/catalog-portal-7f3a',
    trigger: 'settled',
    removedAt: 0,
  };
  return { ...session, cwd: '/repos/catalog-portal-7f3a', removedWorktree };
};

const main: CheckoutInfo = {
  kind: 'main',
  root: '/repos/catalog-portal',
  mainCheckout: '/repos/catalog-portal',
  branch: 'main',
};
const detached: CheckoutInfo = {
  kind: 'worktree',
  root: '/repos/catalog-portal-7f3a',
  mainCheckout: '/repos/catalog-portal',
  head: '3f2a9c1',
};
const worktree: CheckoutInfo = { ...detached, branch: 'feat/search-pagination', head: undefined };

describe('branchLabel', () => {
  it('the branch, or where a detached HEAD is', () => {
    expect(branchLabel({ session, checkout: main })).toBe('main');
    expect(branchLabel({ session, checkout: detached })).toBe('detached at 3f2a9c1');
    // A removed worktree has no checkout to ask: its record says where it was.
    expect(branchLabel({ session: removed('feat/x', 'a'.repeat(40)), checkout: undefined })).toBe(
      'feat/x',
    );
    expect(
      branchLabel({
        session: removed(null, '3f2a9c1d4b5e6f708192a3b4c5d6e7f8091a2b3c'),
        checkout: undefined,
      }),
    ).toBe('detached at 3f2a9c1');
  });

  it('names nothing outside git, or before git has answered', () => {
    expect(branchLabel({ session, checkout: { kind: 'none' } })).toBeNull();
    expect(branchLabel({ session, checkout: undefined })).toBeNull();
  });
});

describe('pushValue', () => {
  const ref = 'origin/feat/search-pagination';

  it('counts what waits to be pushed, and what is behind only when there is some', () => {
    expect(pushValue({ ref, ahead: 2, behind: 0 }, true)).toEqual({
      text: '↑2',
      title: '2 commits to push to origin/feat/search-pagination',
    });
    expect(pushValue({ ref, ahead: 1, behind: 3 }, true)).toEqual({
      text: '↑1 ↓3',
      title: '1 commit to push to origin/feat/search-pagination, 3 behind',
    });
  });

  it('a branch that tracks nothing is not pushed yet', () => {
    expect(pushValue(null, true)?.text).toBe('Not pushed yet');
  });

  it('a detached HEAD has no branch to push, so says nothing of pushing', () => {
    expect(pushValue(null, false)).toBeNull();
  });
});

describe('uncommittedValue', () => {
  it('counts the files and their lines, and nothing reads as none', () => {
    expect(uncommittedValue({ modifiedCount: 0, addedLines: 0, removedLines: 0 })).toBeNull();
    expect(uncommittedValue({ modifiedCount: 1, addedLines: 1, removedLines: 1 })).toEqual({
      files: '1 file',
      additions: 1,
      deletions: 1,
    });
    expect(uncommittedValue({ modifiedCount: 4, addedLines: 12, removedLines: 0 })).toEqual({
      files: '4 files',
      additions: 12,
      deletions: 0,
    });
  });
});

describe('baseLine', () => {
  it('labels the line with the ref, and says Consola never fetches', () => {
    expect(baseLine({ ref: 'origin/main', files: 3, additions: 9, deletions: 0 })).toEqual({
      label: 'vs origin/main',
      files: '3 files',
      additions: 9,
      deletions: 0,
      title: 'Compared with what this clone last fetched of origin/main. Consola never fetches.',
    });
  });

  it('a base with nothing between it and the branch has no files, and no base has no line', () => {
    expect(baseLine({ ref: 'origin/main', files: 0, additions: 0, deletions: 0 })).toMatchObject({
      label: 'vs origin/main',
      files: null,
    });
    expect(baseLine(null)).toBeNull();
  });
});

describe('branchSectionShown', () => {
  it('shows for a checkout git knows, and for a removed worktree', () => {
    expect(branchSectionShown({ session, checkout: main })).toBe(true);
    expect(branchSectionShown({ session, checkout: worktree })).toBe(true);
    expect(
      branchSectionShown({ session: removed('feat/x', 'a'.repeat(40)), checkout: undefined }),
    ).toBe(true);
  });

  it('hides for a folder outside git, and until git has answered', () => {
    expect(branchSectionShown({ session, checkout: { kind: 'none' } })).toBe(false);
    expect(branchSectionShown({ session, checkout: undefined })).toBe(false);
  });
});

describe('plural', () => {
  it('says one as one, and every other count as many', () => {
    expect(plural(1, 'file', 'files')).toBe('1 file');
    expect(plural(0, 'file', 'files')).toBe('0 files');
    expect(plural(2, 'commit', 'commits')).toBe('2 commits');
  });
});

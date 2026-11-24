import { describe, expect, it } from 'vitest';
import type { BranchPullRequestAnswer } from '../../shared/branchPullRequest';
import type { WorkItemRef } from '../../shared/workItems';
import { createSessionRecord, createWorkspaceRecord } from '../../shared/workspace';
import type { Session } from '../../shared/workspace';
import type { BranchPullRequestEntry } from '../stores/branchPullRequestStore';
import { pullRequestSectionView, sessionPullRequest } from './sessionPullRequest';
import type { PullRequestSectionView } from './sessionPullRequest';

const workspace = createWorkspaceRecord('catalog-portal', '/repos/catalog-portal', true);
const unlinked = createSessionRecord({
  name: 'Paginate the catalog search',
  workspaceId: workspace.id,
  instanceId: 'i1',
  harnessId: 'default',
  scopeId: workspace.scopes[0].id,
});
const pr51: WorkItemRef = {
  provider: 'github',
  repo: 'sprocket/catalog-portal',
  type: 'pr',
  number: 51,
};
const issue7: WorkItemRef = { ...pr51, type: 'issue', number: 7 };
const linked: Session = { ...unlinked, workItem: issue7 };

describe('sessionPullRequest', () => {
  it('a linked item beats a found one', () => {
    expect(sessionPullRequest(linked, pr51)).toEqual({ ref: issue7, found: false });
    expect(sessionPullRequest(linked)).toEqual({ ref: issue7, found: false });
    expect(sessionPullRequest(unlinked, pr51)).toEqual({ ref: pr51, found: true });
    expect(sessionPullRequest(unlinked)).toBeNull();
  });
});

describe('pullRequestSectionView', () => {
  it('the section for every linked and unlinked case', () => {
    const cases: Array<{
      session: Session;
      hasAccount: boolean;
      hasBranch: boolean;
      view: PullRequestSectionView;
    }> = [
      // Linked: the item, whatever the branch.
      {
        session: linked,
        hasAccount: true,
        hasBranch: true,
        view: { kind: 'item', ref: issue7, found: false },
      },
      {
        session: linked,
        hasAccount: true,
        hasBranch: false,
        view: { kind: 'item', ref: issue7, found: false },
      },
      // Linked with nothing to read it as.
      {
        session: linked,
        hasAccount: false,
        hasBranch: true,
        view: { kind: 'no-account', ref: issue7 },
      },
      {
        session: linked,
        hasAccount: false,
        hasBranch: false,
        view: { kind: 'no-account', ref: issue7 },
      },
      // Unlinked with no branch: nothing to look up.
      { session: unlinked, hasAccount: true, hasBranch: false, view: { kind: 'hidden' } },
      { session: unlinked, hasAccount: false, hasBranch: false, view: { kind: 'hidden' } },
      // Unlinked on a branch, with no account to look it up with.
      { session: unlinked, hasAccount: false, hasBranch: true, view: { kind: 'no-account' } },
      // Unlinked on a branch with an account: no lookup yet.
      { session: unlinked, hasAccount: true, hasBranch: true, view: { kind: 'looking' } },
    ];
    for (const { view, ...input } of cases) {
      expect(pullRequestSectionView(input)).toEqual(view);
    }
  });

  it("an unlinked session's section follows its lookup", () => {
    const branch = 'feat/search-pagination';
    const answered = (answer: BranchPullRequestAnswer): BranchPullRequestEntry => ({
      answer,
      loading: false,
      askedAt: 1,
    });
    const cases: Array<{
      lookup: BranchPullRequestEntry | undefined;
      view: PullRequestSectionView;
    }> = [
      { lookup: undefined, view: { kind: 'looking' } },
      { lookup: { loading: true, askedAt: 1 }, view: { kind: 'looking' } },
      // Found while the checkout was on another branch: it says nothing of this one.
      {
        lookup: answered({
          kind: 'found',
          branch: 'docs/readme',
          pullRequest: { ref: pr51, status: 'open', url: '' },
        }),
        view: { kind: 'looking' },
      },
      { lookup: answered({ kind: 'none', branch }), view: { kind: 'none' } },
      {
        lookup: answered({ kind: 'failed', branch, error: 'gh: Not Found (HTTP 404)' }),
        view: { kind: 'lookup-failed', error: 'gh: Not Found (HTTP 404)' },
      },
      {
        lookup: answered({
          kind: 'found',
          branch,
          pullRequest: { ref: pr51, status: 'open', url: '' },
        }),
        view: { kind: 'item', ref: pr51, found: true },
      },
    ];
    for (const { lookup, view } of cases) {
      expect(
        pullRequestSectionView({
          session: unlinked,
          hasAccount: true,
          hasBranch: true,
          lookup,
          branch,
        }),
      ).toEqual(view);
    }
  });
});

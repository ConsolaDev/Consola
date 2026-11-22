import { describe, expect, it } from 'vitest';
import type { WorkItemRef } from '../../shared/workItems';
import { createSessionRecord, createWorkspaceRecord, type Session } from '../../shared/workspace';
import {
  type PullRequestSectionView,
  pullRequestSectionView,
  sessionPullRequest,
} from './sessionPullRequest';

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
      { session: unlinked, hasAccount: true, hasBranch: true, view: { kind: 'hidden' } },
    ];
    for (const { view, ...input } of cases) {
      expect(pullRequestSectionView(input)).toEqual(view);
    }
  });
});

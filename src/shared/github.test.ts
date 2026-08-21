import { describe, expect, it } from 'vitest';
import { sameWorkItem, workItemKey, workItemUrl, type WorkItemRef } from './github';

const pr51: WorkItemRef = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };

describe('sameWorkItem', () => {
  it('matches identical refs', () => {
    expect(sameWorkItem(pr51, { ...pr51 })).toBe(true);
  });

  it('matches case-insensitively on repo — GitHub repo names are case-insensitive', () => {
    expect(sameWorkItem(pr51, { ...pr51, repo: 'Sprocket/Catalog-Portal' })).toBe(true);
  });

  it('distinguishes number, type, and repo', () => {
    expect(sameWorkItem(pr51, { ...pr51, number: 52 })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, type: 'issue' })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, repo: 'sprocket/forum-admin' })).toBe(false);
  });

  it('is false when either side is absent — sessions without a workItem match nothing', () => {
    expect(sameWorkItem(undefined, pr51)).toBe(false);
    expect(sameWorkItem(pr51, undefined)).toBe(false);
    expect(sameWorkItem(undefined, undefined)).toBe(false);
  });
});

describe('workItemKey', () => {
  it('is stable across repo casing', () => {
    expect(workItemKey(pr51)).toBe(workItemKey({ ...pr51, repo: 'SPROCKET/catalog-portal' }));
  });

  it('differs across type', () => {
    expect(workItemKey(pr51)).not.toBe(workItemKey({ ...pr51, type: 'issue' }));
  });
});

describe('workItemUrl', () => {
  it('builds the pull URL for PRs', () => {
    expect(workItemUrl(pr51)).toBe('https://github.com/sprocket/catalog-portal/pull/51');
  });

  it('builds the issues URL for issues', () => {
    expect(workItemUrl({ ...pr51, type: 'issue', number: 87 })).toBe(
      'https://github.com/sprocket/catalog-portal/issues/87'
    );
  });
});

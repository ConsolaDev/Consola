import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './apiContract';
import { messageForGitHubResult } from './connectionMessages';
import {
  accountKind,
  GITHUB_RESULTS,
  type GitHubRepository,
  type GitHubResult,
  isSuccess,
  REPOSITORIES_SHOWN,
  readGitHubResult,
  repositoryLabel,
  shownRepositories,
} from './connections';

const repository = (fullName: string, id = fullName.length): GitHubRepository => ({
  id,
  fullName,
  private: true,
  url: `https://github.com/${fullName}`,
});

describe("a Connect's result", () => {
  it('is read when the page knows it', () => {
    expect(readGitHubResult('connected')).toBe('connected');
    expect(readGitHubResult('not_account_admin')).toBe('not_account_admin');
  });

  it('is unknown for one the page does not know, and null for none', () => {
    expect(readGitHubResult('something_new')).toBe('unknown');
    expect(readGitHubResult('')).toBe('unknown');
    expect(readGitHubResult(null)).toBeNull();
  });

  it('is good news only when GitHub is connected', () => {
    expect(isSuccess('connected')).toBe(true);
    expect(isSuccess('already_connected')).toBe(true);
    for (const result of GITHUB_RESULTS.filter((each) => !each.includes('connected'))) {
      expect(isSuccess(result)).toBe(false);
    }
    expect(isSuccess('unknown')).toBe(false);
  });

  it('has a sentence for every result, the unknown one included', () => {
    for (const result of [...GITHUB_RESULTS, 'unknown' as const]) {
      expect(messageForGitHubResult(result)).toMatch(/\.$/);
    }
  });

  it("names every result cloud-global's callback can send, as its contract lists them", () => {
    // A result the API gains fails the typecheck here until the page names it.
    expectTypeOf<GitHubResult>().toEqualTypeOf<components['schemas']['GitHubCallbackResult']>();
    expect(new Set(GITHUB_RESULTS).size).toBe(GITHUB_RESULTS.length);
  });
});

describe("an installation's repositories on its card", () => {
  it('are named in order, all of them when there are few', () => {
    const { shown, more } = shownRepositories([
      repository('sprocket/web'),
      repository('sprocket/api'),
    ]);
    expect(shown.map((each) => each.fullName)).toEqual(['sprocket/api', 'sprocket/web']);
    expect(more).toBe(0);
  });

  it('stop at a few, and say how many more', () => {
    const many = Array.from({ length: REPOSITORIES_SHOWN + 3 }, (_, n) =>
      repository(`sprocket/repo-${String(n).padStart(2, '0')}`, n),
    );
    const { shown, more } = shownRepositories(many);
    expect(shown).toHaveLength(REPOSITORIES_SHOWN);
    expect(shown[0]?.fullName).toBe('sprocket/repo-00');
    expect(more).toBe(3);
  });
});

describe("a repository's label on its card", () => {
  const sprocket = { id: 1, login: 'Sprocket', type: 'Organization' } as const;

  it("leaves out the owner when it is the installation's account, whatever its case", () => {
    expect(repositoryLabel(repository('sprocket/catalog-portal'), sprocket)).toBe('catalog-portal');
  });

  it('keeps the owner of a repository the account does not own', () => {
    expect(repositoryLabel(repository('sprocket-labs/api'), sprocket)).toBe('sprocket-labs/api');
  });
});

describe("an installation's account", () => {
  it('is an organization or a personal account', () => {
    expect(accountKind({ id: 1, login: 'sprocket', type: 'Organization' })).toBe('Organization');
    expect(accountKind({ id: 2, login: 'dana', type: 'User' })).toBe('Personal account');
  });
});

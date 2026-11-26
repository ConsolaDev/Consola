import { GITHUB_TOKEN_PURPOSES } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { grantedAsAsked, scopeFor, TOKEN_PURPOSES, uncoveredRepositories } from './gitHubTokens.js';
import type { TokenScope } from './gitHubTokens.js';

const ask = (purpose: (typeof GITHUB_TOKEN_PURPOSES)[number], repositoryIds: number[]) => ({
  installationId: 41,
  purpose,
  repositoryIds,
});

describe('TOKEN_PURPOSES', () => {
  it('gives each purpose the contract names a fixed scope', () => {
    expect(Object.keys(TOKEN_PURPOSES).sort()).toEqual([...GITHUB_TOKEN_PURPOSES].sort());
  });

  it('gives a review run contents read and pull requests write, and nothing more', () => {
    expect(TOKEN_PURPOSES['review-run'].permissions).toEqual({
      contents: 'read',
      pull_requests: 'write',
    });
  });

  it('gives a factory one repository: contents read to pull it, write to save it', () => {
    expect(TOKEN_PURPOSES['factory-pull']).toEqual({
      permissions: { contents: 'read' },
      maxRepositories: 1,
    });
    expect(TOKEN_PURPOSES['factory-save']).toEqual({
      permissions: { contents: 'write' },
      maxRepositories: 1,
    });
  });

  it('never gives administration, workflows, secrets or anything beyond its purpose', () => {
    for (const { permissions } of Object.values(TOKEN_PURPOSES)) {
      expect(
        Object.keys(permissions).every((name) => ['contents', 'pull_requests'].includes(name)),
      ).toBe(true);
    }
  });
});

describe('scopeFor', () => {
  it('is the installation, the repositories in order, and the purpose’s permissions', () => {
    expect(scopeFor(ask('review-run', [412, 410]))).toEqual({
      ok: true,
      scope: {
        installationId: 41,
        repositoryIds: [410, 412],
        permissions: { contents: 'read', pull_requests: 'write' },
      },
    });
  });

  it('copies the permissions, so changing a scope never changes a purpose', () => {
    const made = scopeFor(ask('factory-save', [410]));
    if (!made.ok) throw new Error('expected a scope');
    made.scope.permissions.contents = 'read';
    expect(TOKEN_PURPOSES['factory-save'].permissions.contents).toBe('write');
  });

  it('refuses a token for no repository at all: never one for the whole installation', () => {
    expect(scopeFor(ask('review-run', []))).toEqual({ ok: false, problems: ['no-repositories'] });
  });

  it('refuses a factory token for more than its one repository', () => {
    expect(scopeFor(ask('factory-save', [410, 411]))).toEqual({
      ok: false,
      problems: ['too-many-repositories'],
    });
    expect(scopeFor(ask('factory-pull', [410, 411]))).toEqual({
      ok: false,
      problems: ['too-many-repositories'],
    });
  });

  it('refuses a run token past its limit', () => {
    const limit = TOKEN_PURPOSES['review-run'].maxRepositories;
    const ids = Array.from({ length: limit + 1 }, (_, index) => 410 + index);
    expect(scopeFor(ask('review-run', ids.slice(0, limit))).ok).toBe(true);
    expect(scopeFor(ask('review-run', ids))).toEqual({
      ok: false,
      problems: ['too-many-repositories'],
    });
  });

  it('refuses a repository named twice, and names every problem', () => {
    expect(scopeFor(ask('factory-pull', [410, 410]))).toEqual({
      ok: false,
      problems: ['too-many-repositories', 'repeated-repository'],
    });
  });
});

const scope: TokenScope = {
  installationId: 41,
  repositoryIds: [410, 412],
  permissions: { contents: 'read', pull_requests: 'write' },
};

describe('uncoveredRepositories', () => {
  const covered = [{ id: 410 }, { id: 411 }, { id: 412 }];

  it('is empty when the installation covers every repository asked for', () => {
    expect(uncoveredRepositories(scope, covered)).toEqual([]);
  });

  it('names each repository the installation does not cover', () => {
    expect(uncoveredRepositories(scope, [{ id: 410 }])).toEqual([412]);
    expect(uncoveredRepositories(scope, [])).toEqual([410, 412]);
  });
});

describe('grantedAsAsked', () => {
  const granted = {
    repositoryIds: [412, 410],
    permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' },
  };

  it('takes exactly the repositories and permissions asked, with the metadata every token has', () => {
    expect(grantedAsAsked(scope, granted)).toBe(true);
    expect(grantedAsAsked(scope, { ...granted, permissions: scope.permissions })).toBe(true);
  });

  it('refuses a token for another repository, or one more', () => {
    expect(grantedAsAsked(scope, { ...granted, repositoryIds: [410, 411] })).toBe(false);
    expect(grantedAsAsked(scope, { ...granted, repositoryIds: [410, 411, 412] })).toBe(false);
    expect(grantedAsAsked(scope, { ...granted, repositoryIds: [410] })).toBe(false);
    expect(grantedAsAsked(scope, { ...granted, repositoryIds: [] })).toBe(false);
  });

  it('refuses a permission it did not ask for, or one at another level', () => {
    const permissions = (changed: Record<string, string>) => ({
      ...granted,
      permissions: { ...granted.permissions, ...changed },
    });
    expect(grantedAsAsked(scope, permissions({ administration: 'write' }))).toBe(false);
    expect(grantedAsAsked(scope, permissions({ contents: 'write' }))).toBe(false);
    expect(grantedAsAsked(scope, permissions({ metadata: 'write' }))).toBe(false);
    expect(
      grantedAsAsked(scope, { ...granted, permissions: { contents: 'read', metadata: 'read' } }),
    ).toBe(false);
  });
});

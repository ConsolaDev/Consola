import { describe, expect, it } from 'vitest';
import { CELL_TOKEN_AUDIENCE, CLOCK_SKEW_SECONDS } from './cellToken.js';
import {
  GITHUB_TOKEN_PURPOSES,
  GITHUB_TOKEN_REQUEST_AUDIENCE,
  GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS,
  GITHUB_TOKEN_REQUEST_TYPE,
  gitHubTokenRequest,
  isGitHubTokenPurpose,
  readGitHubTokenRequest,
} from './gitHubTokenRequest.js';
import type { GitHubTokenAsk } from './gitHubTokenRequest.js';
import { OUTBOX_MESSAGE_TYPE } from './outboxDelivery.js';

const SIGNED = 1_800_000_000;

const ask: GitHubTokenAsk = {
  workspaceId: 'workspace-sprocket',
  installationId: 41,
  purpose: 'factory-pull',
  repositoryIds: [410],
  issuedAt: SIGNED,
};

const request = gitHubTokenRequest(ask);

/** The request with one field changed, or removed when `value` is undefined. */
function withField(name: string, value: unknown): Record<string, unknown> {
  const changed: Record<string, unknown> = { ...request, [name]: value };
  if (value === undefined) delete changed[name];
  return changed;
}

const reasonFor = (payload: unknown, now = SIGNED): string | null => {
  const result = readGitHubTokenRequest(payload, now);
  return result.ok ? null : result.reason;
};

describe('gitHubTokenRequest', () => {
  it('names the workspace, installation, purpose and repositories, for cloud-global', () => {
    expect(request).toEqual({
      aud: GITHUB_TOKEN_REQUEST_AUDIENCE,
      workspaceId: 'workspace-sprocket',
      installationId: 41,
      purpose: 'factory-pull',
      repositoryIds: [410],
      iat: SIGNED,
      exp: SIGNED + GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS,
    });
  });

  it('is meant for cloud-global, never for a cell, and is typed apart from the outbox', () => {
    expect(GITHUB_TOKEN_REQUEST_AUDIENCE).not.toBe(CELL_TOKEN_AUDIENCE);
    expect(GITHUB_TOKEN_REQUEST_TYPE).not.toBe(OUTBOX_MESSAGE_TYPE);
  });

  it('lives a minute at most, since a cell signs one for each request it sends', () => {
    expect(GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS).toBeGreaterThan(0);
    expect(GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS).toBeLessThanOrEqual(60);
  });

  it('copies the repositories, so changing the list asked for changes nothing signed', () => {
    const repositoryIds = [410, 411];
    const made = gitHubTokenRequest({ ...ask, purpose: 'review-run', repositoryIds });
    repositoryIds.push(412);
    expect(made.repositoryIds).toEqual([410, 411]);
  });

  it.each([
    ['an empty workspace id', { workspaceId: '' }],
    ['an installation id of 0', { installationId: 0 }],
    ['a purpose the contract does not name', { purpose: 'admin' }],
    ['a repository id that is a name', { repositoryIds: ['sprocket/catalog-portal'] }],
    ['a time in milliseconds, or any fraction', { issuedAt: SIGNED + 0.5 }],
  ])('throws rather than sign a request cloud-global would refuse: %s', (_case, change) => {
    expect(() => gitHubTokenRequest({ ...ask, ...change } as GitHubTokenAsk)).toThrow(TypeError);
  });
});

describe('isGitHubTokenPurpose', () => {
  it.each(GITHUB_TOKEN_PURPOSES)('takes %s', (purpose) => {
    expect(isGitHubTokenPurpose(purpose)).toBe(true);
  });

  it.each(['admin', 'review-run ', '', null, 3])('refuses %j', (value) => {
    expect(isGitHubTokenPurpose(value)).toBe(false);
  });
});

describe('readGitHubTokenRequest', () => {
  it('reads the request a cell signs, after it crosses as JSON', () => {
    expect(readGitHubTokenRequest(JSON.parse(JSON.stringify(request)), SIGNED)).toEqual({
      ok: true,
      value: request,
    });
  });

  it.each(GITHUB_TOKEN_PURPOSES)('reads a request for %s', (purpose) => {
    expect(readGitHubTokenRequest(withField('purpose', purpose), SIGNED).ok).toBe(true);
  });

  it('leaves how many repositories, and which, to cloud-global: the reader checks the shape', () => {
    expect(reasonFor(withField('repositoryIds', []))).toBeNull();
    expect(reasonFor(withField('repositoryIds', [410, 410]))).toBeNull();
  });

  it.each([null, 'request', 42, [request]])(
    'refuses a request that is no object: %j',
    (payload) => {
      expect(reasonFor(payload)).toBe('the request is not an object');
    },
  );

  it.each(['aud', 'workspaceId', 'installationId', 'purpose', 'repositoryIds', 'iat', 'exp'])(
    'refuses a request without %s',
    (name) => {
      expect(reasonFor(withField(name, undefined))).toBe(`the request has no \`${name}\``);
    },
  );

  it.each([
    ['a permission', 'permissions', { contents: 'write' }],
    ['repositories by name', 'repositories', ['sprocket/catalog-portal']],
    ['a person', 'personId', 'person-dana'],
  ])('refuses a field the contract does not name: %s', (_case, name, value) => {
    expect(reasonFor(withField(name, value))).toBe(
      `the request has \`${name}\`, which the contract does not name`,
    );
  });

  it.each([
    [
      'a cell token',
      'aud',
      CELL_TOKEN_AUDIENCE,
      'the request is not meant for cloud-global (`aud`)',
    ],
    [
      'an audience list',
      'aud',
      [GITHUB_TOKEN_REQUEST_AUDIENCE],
      'the request is not meant for cloud-global (`aud`)',
    ],
    ['an empty workspace', 'workspaceId', '', "`workspaceId` is not a workspace's id"],
    ['a workspace that is no string', 'workspaceId', 7, "`workspaceId` is not a workspace's id"],
    ['an installation of 0', 'installationId', 0, '`installationId` is not a GitHub id'],
    ['a negative installation', 'installationId', -41, '`installationId` is not a GitHub id'],
    ['an installation as a string', 'installationId', '41', '`installationId` is not a GitHub id'],
    ['a fraction of an id', 'installationId', 41.5, '`installationId` is not a GitHub id'],
    ['an unknown purpose', 'purpose', 'admin', '`purpose` is not a purpose the contract names'],
    [
      'a list of purposes',
      'purpose',
      ['factory-pull'],
      '`purpose` is not a purpose the contract names',
    ],
    [
      'repositories that are no list',
      'repositoryIds',
      410,
      '`repositoryIds` is not a list of GitHub ids',
    ],
    [
      'a repository by name',
      'repositoryIds',
      ['sprocket/catalog-portal'],
      '`repositoryIds` is not a list of GitHub ids',
    ],
    ['a repository of 0', 'repositoryIds', [410, 0], '`repositoryIds` is not a list of GitHub ids'],
    ['a fraction of a second', 'iat', SIGNED + 0.5, '`iat` is not a time in whole seconds'],
    ['a time before the epoch', 'iat', -1, '`iat` is not a time in whole seconds'],
    ['an expiry as a string', 'exp', 'soon', '`exp` is not a time in whole seconds'],
  ])('refuses %s', (_case, name, value, reason) => {
    expect(reasonFor(withField(name, value))).toBe(reason);
  });

  it('refuses a request that expires as it is signed, or before', () => {
    expect(reasonFor(withField('exp', SIGNED))).toBe('the request expires before it was signed');
  });

  it('refuses a request that lives longer than a request may, even when signed', () => {
    const longer = withField('exp', SIGNED + GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS + 1);
    expect(reasonFor(longer)).toBe('the request lives longer than a request may');
  });

  it('allows the clocks apart by the skew, and no further', () => {
    expect(reasonFor(request, SIGNED - CLOCK_SKEW_SECONDS)).toBeNull();
    expect(reasonFor(request, SIGNED - CLOCK_SKEW_SECONDS - 1)).toBe(
      'the request was signed in the future',
    );
    const exp = SIGNED + GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS;
    expect(reasonFor(request, exp + CLOCK_SKEW_SECONDS - 1)).toBeNull();
    expect(reasonFor(request, exp + CLOCK_SKEW_SECONDS)).toBe('the request has expired');
  });

  it('throws when the time it reads at is no number, rather than never expire a request', () => {
    expect(() => readGitHubTokenRequest(request, Number.NaN)).toThrow(TypeError);
  });

  it.each(['aud', 'purpose', 'installationId', 'repositoryIds', 'iat'])(
    'never puts what %s held in its reason',
    (name) => {
      const held = 'sprocket/secret-roadmap';
      const reason = reasonFor(withField(name, held));
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(held);
    },
  );
});

import { describe, expect, it } from 'vitest';
import {
  GIT_REF_MAX,
  GITHUB_ACTION_MAX,
  GITHUB_LOGIN_MAX,
  GITHUB_PERMISSIONS_MAX,
  GITHUB_URL_MAX,
  isDeliveryId,
  PULL_REQUEST_TITLE_MAX,
  type PullRequestFacts,
  readGitHubEventFacts,
  readGitHubPermissions,
} from './github.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const pullRequest: PullRequestFacts = {
  name: 'pull_request',
  action: 'ready_for_review',
  repository: 'sprocket/catalog-portal',
  number: 12,
  url: 'https://github.com/sprocket/catalog-portal/pull/12',
  title: 'Fix the cart',
  author: 'dependabot[bot]',
  draft: false,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  headRef: 'fix/cart',
  baseRef: 'main',
  fork: true,
};

describe('isDeliveryId', () => {
  it.each(['72d3162e-cc78-11e3-81ab-4c9367dc0958', 'a'])('accepts %s', (value) =>
    expect(isDeliveryId(value)).toBe(true),
  );
  it.each(['', 'a b', 'a/b', 'x'.repeat(65), 7, null])('refuses %s', (value) =>
    expect(isDeliveryId(value)).toBe(false),
  );
});

describe('readGitHubEventFacts', () => {
  it('reads a pull request event', () => {
    expect(readGitHubEventFacts(wire(pullRequest))).toEqual({ ok: true, value: pullRequest });
  });

  it('reads an empty title, and every string at its bound', () => {
    expect(readGitHubEventFacts(wire({ ...pullRequest, title: '' })).ok).toBe(true);
    const longest = {
      ...pullRequest,
      action: 'a'.repeat(GITHUB_ACTION_MAX),
      title: 't'.repeat(PULL_REQUEST_TITLE_MAX),
      author: 'a'.repeat(GITHUB_LOGIN_MAX),
      headRef: 'h'.repeat(GIT_REF_MAX),
      baseRef: 'b'.repeat(GIT_REF_MAX),
      url: `https://github.com/${'p'.repeat(GITHUB_URL_MAX - 'https://github.com/'.length)}`,
    };
    expect(readGitHubEventFacts(wire(longest))).toEqual({ ok: true, value: longest });
  });

  it.each([
    ['not an object', 'pull_request'],
    ['an event the protocol does not name', { ...pullRequest, name: 'push' }],
    ['no name', { ...pullRequest, name: undefined }],
    ['an extra field', { ...pullRequest, body: 'Text from GitHub' }],
    ['a missing field', { ...pullRequest, fork: undefined }],
    ['an empty action', { ...pullRequest, action: '' }],
    ['an action with a capital', { ...pullRequest, action: 'Opened' }],
    ['an action past its bound', { ...pullRequest, action: 'a'.repeat(GITHUB_ACTION_MAX + 1) }],
    ['a bad repository', { ...pullRequest, repository: 'sprocket/..' }],
    ['number 0', { ...pullRequest, number: 0 }],
    ['a fractional number', { ...pullRequest, number: 1.5 }],
    ['a number as text', { ...pullRequest, number: '12' }],
    ['an http url', { ...pullRequest, url: 'http://github.com/sprocket/catalog-portal/pull/12' }],
    ['a url with user info', { ...pullRequest, url: 'https://u:p@github.com/x' }],
    ['not a url', { ...pullRequest, url: 'pull 12' }],
    [
      'a url past its bound',
      { ...pullRequest, url: `https://github.com/${'p'.repeat(GITHUB_URL_MAX)}` },
    ],
    ['a title past its bound', { ...pullRequest, title: 't'.repeat(PULL_REQUEST_TITLE_MAX + 1) }],
    ['a title that is not text', { ...pullRequest, title: null }],
    ['an empty author', { ...pullRequest, author: '' }],
    ['an author past its bound', { ...pullRequest, author: 'a'.repeat(GITHUB_LOGIN_MAX + 1) }],
    ['draft as text', { ...pullRequest, draft: 'false' }],
    ['a short sha', { ...pullRequest, headSha: '0123456' }],
    ['an uppercase sha', { ...pullRequest, headSha: '0123456789ABCDEF0123456789ABCDEF01234567' }],
    ['an empty head branch', { ...pullRequest, headRef: '' }],
    ['a base branch past its bound', { ...pullRequest, baseRef: 'b'.repeat(GIT_REF_MAX + 1) }],
    ['fork as a number', { ...pullRequest, fork: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(readGitHubEventFacts(wire(value)).ok).toBe(false);
  });

  it('names the field in a reason and never what it held', () => {
    const read = readGitHubEventFacts(wire({ ...pullRequest, title: 'hunter2'.repeat(1000) }));
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('event.title') });
    expect(JSON.stringify(read)).not.toContain('hunter2');
  });
});

describe('readGitHubPermissions', () => {
  it('reads 1 to 8 permissions', () => {
    const permissions = { contents: 'read', pull_requests: 'write' };
    expect(readGitHubPermissions(wire(permissions), 'permissions')).toEqual({
      ok: true,
      value: permissions,
    });
    const most = Object.fromEntries(
      Array.from({ length: GITHUB_PERMISSIONS_MAX }, (_, i) => [`p${i}`, 'read']),
    );
    expect(readGitHubPermissions(wire(most), 'permissions').ok).toBe(true);
  });

  it.each([
    ['none', {}],
    [
      'too many',
      Object.fromEntries(
        Array.from({ length: GITHUB_PERMISSIONS_MAX + 1 }, (_, i) => [`p${i}`, 'read']),
      ),
    ],
    ['a name with a capital', { Contents: 'read' }],
    ['a name with a dash', { 'pull-requests': 'write' }],
    ['a name starting with an underscore', { ['__proto__']: 'read' }],
    ['an admin level', { administration: 'admin' }],
    ['a level that is not text', { contents: true }],
    ['a list', ['contents']],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(readGitHubPermissions(wire(value), 'permissions').ok).toBe(false);
  });

  it('never names a permission in a reason', () => {
    const read = readGitHubPermissions(wire({ 'hunter2-Secret': 'read' }), 'permissions');
    expect(JSON.stringify(read)).not.toContain('hunter2');
  });
});

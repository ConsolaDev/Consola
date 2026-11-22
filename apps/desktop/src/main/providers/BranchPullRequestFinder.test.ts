import { describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceProvider } from '../../shared/workspace';
import type { BranchIdentity } from '../gitBranch';
import {
  BRANCH_LOOKUP_TTL_MS,
  BranchPullRequestFinder,
  pickPullRequest,
} from './BranchPullRequestFinder';
import type { GitProviderDriver } from './GitProviderDriver';
import type { PullRequestLookup, PullRequestQuery, PullRequestState } from './pullRequests';
import { createStubDriver } from './stubDriver.test-helpers';

const ORIGIN = 'https://github.com/sprocket/catalog-portal.git';
const BRANCH = 'feat/search-pagination';
const DIR = '/repos/catalog-portal';
const IDENTITY: BranchIdentity = { branch: BRANCH, remoteBranch: BRANCH, originUrl: ORIGIN };

function pr(number: number, status: PullRequestState['status']): PullRequestState {
  return {
    number,
    status,
    headOid: '3f2a9c1d',
    headBranch: BRANCH,
    url: `https://github.com/sprocket/catalog-portal/pull/${number}`,
    createdAt: '2026-11-20T10:00:00Z',
  };
}

/** A lookup that answers every query with `pullRequests`, and `error` when given. */
function answering(pullRequests: PullRequestState[], error?: string) {
  return vi.fn(
    async (queries: PullRequestQuery[], _env: NodeJS.ProcessEnv): Promise<PullRequestLookup[]> =>
      queries.map((query) => ({ query, pullRequests, ...(error ? { error } : {}) })),
  );
}

function setup(
  options: {
    provider?: WorkspaceProvider | undefined;
    identities?: Record<string, BranchIdentity | null>;
    driver?: Partial<GitProviderDriver>;
  } = {},
) {
  let clock = 1_000_000;
  const workspace = {
    id: 'ws',
    provider:
      'provider' in options
        ? options.provider
        : { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
  } as Workspace;
  const driver = createStubDriver({
    // #51, open, unless a test says otherwise.
    lookupPullRequests: answering([pr(51, 'open')]),
    // owner/name of an https remote on github.com, else none of this provider's.
    repoOfRemote: (url) =>
      url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null,
    ...options.driver,
  });
  const composeEnv = vi.fn(async (_driver: GitProviderDriver, _login: string) => ({
    GH_TOKEN: 'gho_test',
  }));
  const identities = options.identities ?? {};
  const readIdentity = vi.fn(async (dir: string) =>
    dir in identities ? identities[dir] : IDENTITY,
  );
  const finder = new BranchPullRequestFinder({
    getWorkspace: (id) => (id === 'ws' ? workspace : undefined),
    resolveDriver: () => driver,
    composeEnv,
    readIdentity,
    now: () => clock,
  });
  return {
    finder,
    workspace,
    driver,
    composeEnv,
    lookupPullRequests: driver.lookupPullRequests as ReturnType<typeof answering>,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('BranchPullRequestFinder', () => {
  it('pickPullRequest prefers an open pull request to a newer closed one, else takes the newest', () => {
    expect(pickPullRequest([pr(60, 'closed'), pr(51, 'open')])?.number).toBe(51);
    expect(pickPullRequest([pr(60, 'merged'), pr(40, 'closed')])?.number).toBe(60);
    expect(pickPullRequest([])).toBeNull();
  });

  it('finds the branch’s pull request in the repository origin names', async () => {
    const { finder, driver, composeEnv, lookupPullRequests } = setup();
    await expect(finder.find('ws', DIR)).resolves.toEqual({
      kind: 'found',
      branch: BRANCH,
      pullRequest: {
        ref: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
        status: 'open',
        url: 'https://github.com/sprocket/catalog-portal/pull/51',
      },
    });
    expect(composeEnv).toHaveBeenCalledWith(driver, 'JaviDev');
    expect(lookupPullRequests).toHaveBeenCalledWith(
      [{ repo: 'sprocket/catalog-portal', headBranch: BRANCH }],
      { GH_TOKEN: 'gho_test' },
    );
  });

  it('asks under the branch’s name on the remote', async () => {
    const { finder, lookupPullRequests } = setup({
      identities: {
        [DIR]: { branch: BRANCH, remoteBranch: 'search-pages', originUrl: ORIGIN },
        // Another local branch that pushes to the same remote branch.
        '/repos/catalog-portal-2': {
          branch: 'search-pages',
          remoteBranch: 'search-pages',
          originUrl: ORIGIN,
        },
      },
    });
    await expect(finder.find('ws', DIR)).resolves.toMatchObject({ kind: 'found', branch: BRANCH });
    expect(lookupPullRequests.mock.calls[0][0]).toEqual([
      { repo: 'sprocket/catalog-portal', headBranch: 'search-pages' },
    ]);
    // The same remote branch shares the answer, stamped with each local branch.
    await expect(finder.find('ws', '/repos/catalog-portal-2')).resolves.toMatchObject({
      kind: 'found',
      branch: 'search-pages',
    });
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
  });

  it.each<{
    name: string;
    dir?: unknown;
    provider?: WorkspaceProvider | undefined;
    driver?: Partial<GitProviderDriver>;
    identity?: BranchIdentity | null;
    branch: string | null;
  }>([
    { name: 'a relative dir', dir: 'repos/catalog-portal', branch: null },
    { name: 'a dir that is not a string', dir: 42, branch: null },
    { name: 'no provider', provider: undefined, branch: null },
    {
      name: 'a driver without lookupPullRequests',
      driver: { lookupPullRequests: undefined },
      branch: BRANCH,
    },
    {
      name: 'a driver without repoOfRemote',
      driver: { repoOfRemote: undefined },
      branch: BRANCH,
    },
    { name: 'a folder outside git', identity: null, branch: null },
    {
      name: 'a detached HEAD',
      identity: { branch: null, remoteBranch: null, originUrl: ORIGIN },
      branch: null,
    },
    {
      name: 'no origin',
      identity: { branch: BRANCH, remoteBranch: BRANCH, originUrl: null },
      branch: BRANCH,
    },
    {
      name: 'an origin on another host',
      identity: {
        branch: BRANCH,
        remoteBranch: BRANCH,
        originUrl: 'https://gitlab.com/sprocket/catalog-portal.git',
      },
      branch: BRANCH,
    },
    {
      name: 'a repo outside sprocket',
      identity: {
        branch: BRANCH,
        remoteBranch: BRANCH,
        originUrl: 'https://github.com/elsewhere/catalog-portal.git',
      },
      branch: BRANCH,
    },
  ])('answers none without asking: $name', async (row) => {
    const lookupPullRequests = answering([pr(51, 'open')]);
    const { finder, composeEnv } = setup({
      ...('provider' in row ? { provider: row.provider } : {}),
      ...('identity' in row ? { identities: { [DIR]: row.identity ?? null } } : {}),
      driver: { lookupPullRequests, ...row.driver },
    });
    await expect(finder.find('ws', 'dir' in row ? row.dir : DIR)).resolves.toEqual({
      kind: 'none',
      branch: row.branch,
    });
    expect(lookupPullRequests).not.toHaveBeenCalled();
    expect(composeEnv).not.toHaveBeenCalled();
  });

  it('answers none without asking for a workspace it does not know', async () => {
    const { finder, lookupPullRequests } = setup();
    await expect(finder.find('elsewhere', DIR)).resolves.toEqual({ kind: 'none', branch: null });
    await expect(finder.find(undefined, DIR)).resolves.toEqual({ kind: 'none', branch: null });
    expect(lookupPullRequests).not.toHaveBeenCalled();
  });

  it('matches the workspace’s organization whatever its casing', async () => {
    const { finder, lookupPullRequests } = setup({
      provider: { id: 'github', accountLogin: 'JaviDev', org: 'Sprocket' },
    });
    await expect(finder.find('ws', DIR)).resolves.toMatchObject({ kind: 'found' });
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
  });

  it('answers none when the branch has no pull request, and keeps that while fresh', async () => {
    const { finder, lookupPullRequests } = setup({ driver: { lookupPullRequests: answering([]) } });
    await expect(finder.find('ws', DIR)).resolves.toEqual({ kind: 'none', branch: BRANCH });
    await expect(finder.find('ws', DIR)).resolves.toEqual({ kind: 'none', branch: BRANCH });
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
  });

  it('asks once per repo and branch while the answer is fresh', async () => {
    const { finder, lookupPullRequests } = setup();
    for (const dir of [
      DIR,
      '/worktrees/catalog-portal-search',
      DIR,
      DIR,
      '/worktrees/catalog-portal-search',
    ]) {
      await expect(finder.find('ws', dir)).resolves.toMatchObject({ kind: 'found' });
    }
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
  });

  it('asks again once the answer is old, or when forced', async () => {
    const { finder, lookupPullRequests, advance } = setup();
    await finder.find('ws', DIR);
    advance(BRANCH_LOOKUP_TTL_MS - 1);
    await finder.find('ws', DIR);
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
    advance(2);
    await finder.find('ws', DIR);
    expect(lookupPullRequests).toHaveBeenCalledTimes(2);
    await finder.find('ws', DIR, { force: true });
    expect(lookupPullRequests).toHaveBeenCalledTimes(3);
  });

  it('shares one request between callers that ask at once', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookupPullRequests = vi.fn(async (queries: PullRequestQuery[]) => {
      await held;
      return queries.map((query) => ({ query, pullRequests: [pr(51, 'open')] }));
    });
    const { finder } = setup({ driver: { lookupPullRequests } });
    // A forced caller joins the request already running rather than starting one.
    const answers = Promise.all([
      finder.find('ws', DIR),
      finder.find('ws', DIR),
      finder.find('ws', DIR, { force: true }),
    ]);
    await vi.waitFor(() => expect(lookupPullRequests).toHaveBeenCalled());
    release();
    for (const answer of await answers) expect(answer).toMatchObject({ kind: 'found' });
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
  });

  it('says why a lookup failed, and keeps that until forced', async () => {
    const failing = setup({
      driver: { lookupPullRequests: answering([], 'HTTP 502: Bad Gateway') },
    });
    const failed = { kind: 'failed', branch: BRANCH, error: 'HTTP 502: Bad Gateway' };
    await expect(failing.finder.find('ws', DIR)).resolves.toEqual(failed);
    await expect(failing.finder.find('ws', DIR)).resolves.toEqual(failed);
    expect(failing.lookupPullRequests).toHaveBeenCalledTimes(1);
    await failing.finder.find('ws', DIR, { force: true });
    expect(failing.lookupPullRequests).toHaveBeenCalledTimes(2);

    const unsigned = setup();
    unsigned.composeEnv.mockRejectedValue(new Error('no oauth token found for JaviDev'));
    await expect(unsigned.finder.find('ws', DIR)).resolves.toEqual({
      kind: 'failed',
      branch: BRANCH,
      error: 'no oauth token found for JaviDev',
    });
    await unsigned.finder.find('ws', DIR);
    expect(unsigned.composeEnv).toHaveBeenCalledTimes(1);
    expect(unsigned.lookupPullRequests).not.toHaveBeenCalled();
  });

  it('keeps accounts apart', async () => {
    const { finder, workspace, lookupPullRequests } = setup();
    await finder.find('ws', DIR);
    // A login's casing names the same account.
    workspace.provider = { id: 'github', accountLogin: 'javidev', org: 'sprocket' };
    await finder.find('ws', DIR);
    expect(lookupPullRequests).toHaveBeenCalledTimes(1);
    workspace.provider = { id: 'github', accountLogin: 'ellen-sprocket', org: 'sprocket' };
    await finder.find('ws', DIR);
    expect(lookupPullRequests).toHaveBeenCalledTimes(2);
  });
});

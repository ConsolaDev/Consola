import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitHubStores } from '../adapters/persistence/gitHubStores.js';
import * as gitHubTables from '../adapters/persistence/gitHubTables.js';
import type { GitHubRepository } from '../domain/connections.js';
import type { GitHubApp, GitHubTokenMinter, MintAnswer, TokenMintStore } from './gitHubPorts.js';
import { mintGitHubToken } from './gitHubTokens.js';
import type { GitHubTokenRequest } from './gitHubTokens.js';

let client: PGlite;
let mints: TokenMintStore;

const now = 1_800_000_000;
const clock = { nowSeconds: () => now };

// Acme holds installation 41 on the `acme` organisation; Sprocket holds 52 on `sprocket`.
beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  const stores = createGitHubStores(drizzle(client));
  for (const [id, workspaceId] of [
    [41, 'acme'],
    [52, 'sprocket'],
  ] as const) {
    await stores.installations.connect({
      installation: {
        id,
        account: { id: id + 9000, login: workspaceId, type: 'Organization' },
      },
      workspaceId,
      connectedBy: 'dana',
      at: new Date(),
    });
  }
  mints = stores.mints;
});

afterEach(async () => {
  await client.close();
});

const repository = (id: number, fullName: string): GitHubRepository => ({
  id,
  fullName,
  private: true,
  url: `https://github.com/${fullName}`,
});

/** What each installation covers, as GitHub lists it. */
const COVERED: Record<number, GitHubRepository[]> = {
  41: [repository(410, 'acme/catalog-portal'), repository(411, 'acme/api')],
  52: [repository(520, 'sprocket/factory'), repository(521, 'sprocket/api')],
};

type Minted = Extract<MintAnswer, { kind: 'minted' }>;

/**
 * GitHub, as minting asks it: it lists what each installation covers, and mints a token for
 * exactly the scope asked unless `answer` says otherwise. Every mint and revoke is kept.
 */
function fakeGitHub(
  answer: (scope: {
    repositoryIds: number[];
    permissions: Record<string, string>;
  }) => MintAnswer | undefined = () => undefined,
  listing: Awaited<ReturnType<GitHubApp['repositoriesOf']>> | null = null,
) {
  const asked: Array<{ installationId: number; scope: unknown }> = [];
  const revoked: string[] = [];
  let count = 0;
  const github: Pick<GitHubApp, 'repositoriesOf'> & GitHubTokenMinter = {
    async repositoriesOf(installationId) {
      return listing ?? { kind: 'listed', repositories: COVERED[installationId] ?? [] };
    },
    async mintToken(installationId, scope) {
      asked.push({ installationId, scope });
      const given = answer(scope);
      if (given) return given;
      count += 1;
      const minted: Minted = {
        kind: 'minted',
        token: `ghs_narrowed_${count}`,
        expiresAt: new Date((now + 3600) * 1000),
        repositories: scope.repositoryIds.map((id) => {
          const found = COVERED[installationId]?.find((each) => each.id === id);
          return { id, fullName: found?.fullName ?? 'unknown' };
        }),
        permissions: { ...scope.permissions, metadata: 'read' },
      };
      return minted;
    },
    async revokeToken(token) {
      revoked.push(token);
    },
  };
  return { github, asked, revoked };
}

const ask = (overrides: Partial<GitHubTokenRequest> = {}): GitHubTokenRequest => ({
  workspaceId: 'acme',
  installationId: 41,
  purpose: 'factory-pull',
  repositoryIds: [410],
  ...overrides,
});

function setUp(github: ReturnType<typeof fakeGitHub> | null = fakeGitHub()) {
  const mint = (request: GitHubTokenRequest) =>
    mintGitHubToken({ mints, github: github?.github ?? null, clock }, request);
  return { mint };
}

describe('minting a GitHub token', () => {
  it('mints a token narrowed to the repositories and the purpose’s permissions, and records it', async () => {
    const github = fakeGitHub();
    const { mint } = setUp(github);

    expect(await mint(ask())).toEqual({
      kind: 'minted',
      token: 'ghs_narrowed_1',
      expiresAt: now + 3600,
      repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(github.asked).toEqual([
      { installationId: 41, scope: { repositoryIds: [410], permissions: { contents: 'read' } } },
    ]);
    expect(await mints.mintsOf('acme')).toEqual([
      {
        workspaceId: 'acme',
        installationId: 41,
        purpose: 'factory-pull',
        repositoryIds: [410],
        permissions: { contents: 'read', metadata: 'read' },
        mintedAt: new Date(now * 1000),
        expiresAt: new Date((now + 3600) * 1000),
      },
    ]);
  });

  it('gives each purpose its own permissions, whatever else the work would like', async () => {
    const github = fakeGitHub();
    const { mint } = setUp(github);
    await mint(ask({ purpose: 'factory-save' }));
    await mint(ask({ purpose: 'review-run', repositoryIds: [411, 410] }));
    await mint(ask({ workspaceId: 'sprocket', installationId: 52, repositoryIds: [520] }));

    expect(github.asked.map(({ scope }) => scope)).toEqual([
      { repositoryIds: [410], permissions: { contents: 'write' } },
      { repositoryIds: [410, 411], permissions: { contents: 'read', pull_requests: 'write' } },
      { repositoryIds: [520], permissions: { contents: 'read' } },
    ]);
  });

  it('records every mint', async () => {
    const { mint } = setUp();
    await mint(ask());
    await mint(ask({ purpose: 'factory-save' }));
    await mint(ask({ workspaceId: 'sprocket', installationId: 52, repositoryIds: [521] }));
    expect((await mints.mintsOf('acme')).map((each) => each.purpose)).toEqual([
      'factory-pull',
      'factory-save',
    ]);
    expect((await mints.mintsOf('sprocket')).map((each) => each.repositoryIds)).toEqual([[521]]);
  });

  describe('refuses, minting nothing and recording nothing,', () => {
    /** Asserts nothing was asked of GitHub's minting, and nothing recorded. */
    async function nothingMinted(github: ReturnType<typeof fakeGitHub>) {
      expect(github.asked).toEqual([]);
      for (const workspace of ['acme', 'sprocket']) {
        expect(await mints.mintsOf(workspace)).toEqual([]);
      }
    }

    it('a request for no repository, never a token for the whole installation', async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      expect(await mint(ask({ repositoryIds: [] }))).toEqual({
        kind: 'invalid',
        problems: ['no-repositories'],
      });
      await nothingMinted(github);
    });

    it('a factory token for more than its one repository, or a repository named twice', async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      expect(await mint(ask({ purpose: 'factory-save', repositoryIds: [410, 411] }))).toEqual({
        kind: 'invalid',
        problems: ['too-many-repositories'],
      });
      expect(await mint(ask({ purpose: 'review-run', repositoryIds: [410, 410] }))).toEqual({
        kind: 'invalid',
        problems: ['repeated-repository'],
      });
      await nothingMinted(github);
    });

    it("another workspace's installation: Sprocket never gets Acme's", async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      expect(await mint(ask({ workspaceId: 'sprocket', installationId: 41 }))).toEqual({
        kind: 'installation-not-found',
      });
      expect(await mint(ask({ installationId: 52, repositoryIds: [520] }))).toEqual({
        kind: 'installation-not-found',
      });
      await nothingMinted(github);
    });

    it('an installation no workspace holds, or a workspace that holds none', async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      expect(await mint(ask({ installationId: 99 }))).toEqual({
        kind: 'installation-not-found',
      });
      expect(await mint(ask({ workspaceId: 'nobody' }))).toEqual({
        kind: 'installation-not-found',
      });
      await nothingMinted(github);
    });

    it('a repository the installation does not cover, naming each one', async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      // 520 and 521 are Sprocket's: neither is Acme's installation's.
      expect(await mint(ask({ purpose: 'review-run', repositoryIds: [410, 521, 520] }))).toEqual({
        kind: 'not-covered',
        repositoryIds: [520, 521],
      });
      await nothingMinted(github);
    });

    it('anything, when this server has no GitHub App', async () => {
      const { mint } = setUp(null);
      expect(await mint(ask())).toEqual({ kind: 'not-configured' });
      expect(await mints.mintsOf('acme')).toEqual([]);
    });

    it('an installation GitHub no longer has, or a list GitHub would not give', async () => {
      const gone = fakeGitHub(undefined, { kind: 'gone' });
      expect(await setUp(gone).mint(ask())).toEqual({ kind: 'installation-gone' });
      await nothingMinted(gone);

      const silent = fakeGitHub(undefined, { kind: 'unavailable' });
      expect(await setUp(silent).mint(ask())).toEqual({ kind: 'unavailable' });
      await nothingMinted(silent);
    });
  });

  it.each([
    [{ kind: 'gone' }, { kind: 'installation-gone' }],
    [{ kind: 'refused' }, { kind: 'refused' }],
    [{ kind: 'unavailable' }, { kind: 'unavailable' }],
  ] as const)(
    'passes on GitHub refusing the mint (%j), and records nothing',
    async (given, outcome) => {
      const github = fakeGitHub(() => given);
      const { mint } = setUp(github);
      expect(await mint(ask())).toEqual(outcome);
      expect(github.revoked).toEqual([]);
      expect(await mints.mintsOf('acme')).toEqual([]);
    },
  );

  it.each([
    [
      'another repository',
      { repositories: [{ id: 411, fullName: 'acme/api' }], permissions: { contents: 'read' } },
    ],
    [
      'one more repository',
      {
        repositories: [
          { id: 410, fullName: 'acme/catalog-portal' },
          { id: 411, fullName: 'acme/api' },
        ],
        permissions: { contents: 'read' },
      },
    ],
    [
      'the whole installation (no repositories named)',
      { repositories: [], permissions: { contents: 'read' } },
    ],
    [
      'a wider permission',
      {
        repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
        permissions: { contents: 'write' },
      },
    ],
    [
      'a permission not asked for',
      {
        repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
        permissions: { contents: 'read', administration: 'write' },
      },
    ],
  ])(
    'revokes a token GitHub did not narrow as asked (%s), and hands out nothing',
    async (_case, granted) => {
      const github = fakeGitHub(() => ({
        kind: 'minted',
        token: 'ghs_too_wide',
        expiresAt: new Date((now + 3600) * 1000),
        ...granted,
      }));
      const { mint } = setUp(github);
      expect(await mint(ask())).toEqual({ kind: 'not-as-asked' });
      expect(github.revoked).toEqual(['ghs_too_wide']);
      expect(await mints.mintsOf('acme')).toEqual([]);
    },
  );

  it('logs a token it revoked as not asked by its ids alone, never the token or a repository', async () => {
    const lines: string[] = [];
    const log = {
      error: (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      },
    };
    const github = fakeGitHub(() => ({
      kind: 'minted',
      token: 'ghs_too_wide',
      expiresAt: new Date((now + 3600) * 1000),
      repositories: [{ id: 411, fullName: 'acme/api' }],
      permissions: { contents: 'read' },
    }));
    expect(await mintGitHubToken({ mints, github: github.github, clock, log }, ask())).toEqual({
      kind: 'not-as-asked',
    });
    expect(lines).toEqual([
      'GitHub minted a token other than the one asked for workspace acme (installation 41, ' +
        'purpose factory-pull); it was revoked.',
    ]);
    expect(lines.join('\n')).not.toContain('ghs_too_wide');
    expect(lines.join('\n')).not.toContain('acme/');

    // A token as asked is handed out, and nothing is logged.
    const asAsked = await mintGitHubToken(
      { mints, github: fakeGitHub().github, clock, log },
      ask(),
    );
    expect(asAsked.kind).toBe('minted');
    expect(lines).toHaveLength(1);
  });

  it('revokes the token and hands out nothing when the mint cannot be recorded', async () => {
    const github = fakeGitHub();
    const failing: TokenMintStore = {
      ...mints,
      record: async () => {
        throw new Error('the database is gone');
      },
    };
    await expect(
      mintGitHubToken({ mints: failing, github: github.github, clock }, ask()),
    ).rejects.toThrow('the database is gone');
    expect(github.revoked).toEqual(['ghs_narrowed_1']);
  });
});

import { GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS, gitHubTokenRequest } from '@consola/cloud-contract';
import type { GitHubTokenAsk } from '@consola/cloud-contract';
import type { Region } from '../../shared/region.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createTokenMintStore } from '../adapters/persistence/tokenMintStore.js';
import type { GitHubRepository } from '../domain/connections.js';
import { mintGitHubToken } from './gitHubTokens.js';
import type {
  CellRequestVerifier,
  GitHubApp,
  GitHubTokenMinter,
  MintAnswer,
  TokenMintStore,
} from './ports.js';

let db: Database;
let close: () => Promise<void>;
let mints: TokenMintStore;

const now = 1_800_000_000;

// Acme (EU) holds installation 41 on the `acme` organisation; Bolt (EU) holds 42; Sprocket (US)
// holds 52 on the `sprocket` organisation.
beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.organization).values([
    { id: 'acme', name: 'Acme', slug: 'acme', region: 'eu', createdAt: new Date() },
    { id: 'bolt', name: 'Bolt', slug: 'bolt', region: 'eu', createdAt: new Date() },
    { id: 'sprocket', name: 'Sprocket', slug: 'sprocket', region: 'us', createdAt: new Date() },
  ]);
  const installation = (installationId: number, organizationId: string, login: string) => ({
    installationId,
    organizationId,
    accountId: installationId + 9000,
    accountLogin: login,
    accountType: 'Organization',
    connectedAt: new Date(),
  });
  await db
    .insert(schema.githubInstallation)
    .values([
      installation(41, 'acme', 'acme'),
      installation(42, 'bolt', 'bolt'),
      installation(52, 'sprocket', 'sprocket'),
    ]);
  mints = createTokenMintStore(db);
});

afterEach(async () => {
  await close();
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
  42: [repository(420, 'bolt/site')],
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

/**
 * A verifier that knows what each region's cell signed: `signedBy` returns the string a cell
 * would send, and only those strings are signed.
 */
function fakeCells() {
  const signed = new Map<string, { region: Region; payload: unknown }>();
  const verifier: CellRequestVerifier = {
    async verifyTokenRequest(value) {
      const found = signed.get(value);
      return found ? { kind: 'signed', ...found } : { kind: 'unsigned' };
    },
  };
  const signedBy = (region: Region, payload: unknown) => {
    const value = `signed-${signed.size}`;
    signed.set(value, { region, payload });
    return value;
  };
  return { verifier, signedBy };
}

const ask = (overrides: Partial<GitHubTokenAsk> = {}) =>
  gitHubTokenRequest({
    workspaceId: 'acme',
    installationId: 41,
    purpose: 'factory-pull',
    repositoryIds: [410],
    issuedAt: now,
    ...overrides,
  });

function setUp(github: ReturnType<typeof fakeGitHub> | null = fakeGitHub()) {
  const cells = fakeCells();
  const mint = (signed: string) =>
    mintGitHubToken(
      { cellRequests: cells.verifier, mints, github: github?.github ?? null },
      signed,
      now,
    );
  return { ...cells, mint };
}

describe('minting a GitHub token for a cell', () => {
  it('mints a token narrowed to the repositories and the purpose’s permissions, and records it', async () => {
    const github = fakeGitHub();
    const { mint, signedBy } = setUp(github);

    expect(await mint(signedBy('eu', ask()))).toEqual({
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

  it('gives each purpose its own permissions, whatever else the cell would like', async () => {
    const github = fakeGitHub();
    const { mint, signedBy } = setUp(github);
    await mint(signedBy('eu', ask({ purpose: 'factory-save' })));
    await mint(signedBy('eu', ask({ purpose: 'review-run', repositoryIds: [411, 410] })));
    await mint(
      signedBy('us', ask({ workspaceId: 'sprocket', installationId: 52, repositoryIds: [520] })),
    );

    expect(github.asked.map(({ scope }) => scope)).toEqual([
      { repositoryIds: [410], permissions: { contents: 'write' } },
      { repositoryIds: [410, 411], permissions: { contents: 'read', pull_requests: 'write' } },
      { repositoryIds: [520], permissions: { contents: 'read' } },
    ]);
  });

  it('records every mint', async () => {
    const { mint, signedBy } = setUp();
    await mint(signedBy('eu', ask()));
    await mint(signedBy('eu', ask({ purpose: 'factory-save' })));
    await mint(
      signedBy('us', ask({ workspaceId: 'sprocket', installationId: 52, repositoryIds: [521] })),
    );
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
      for (const workspace of ['acme', 'bolt', 'sprocket']) {
        expect(await mints.mintsOf(workspace)).toEqual([]);
      }
    }

    it('a request no cell signed', async () => {
      const github = fakeGitHub();
      const { mint } = setUp(github);
      expect(await mint('a-request-nobody-signed')).toEqual({ kind: 'unsigned' });
      await nothingMinted(github);
    });

    it('a signed request the contract does not read, saying why', async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      const expired = ask({ issuedAt: now - GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS - 60 });
      expect(await mint(signedBy('eu', expired))).toEqual({
        kind: 'unreadable',
        reason: 'the request has expired',
      });
      expect(
        await mint(signedBy('eu', { ...ask(), permissions: { administration: 'write' } })),
      ).toEqual({
        kind: 'unreadable',
        reason: 'the request has `permissions`, which the contract does not name',
      });
      await nothingMinted(github);
    });

    it('a request for no repository, never a token for the whole installation', async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('eu', ask({ repositoryIds: [] })))).toEqual({
        kind: 'invalid',
        problems: ['no-repositories'],
      });
      await nothingMinted(github);
    });

    it('a factory token for more than its one repository', async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      expect(
        await mint(signedBy('eu', ask({ purpose: 'factory-save', repositoryIds: [410, 411] }))),
      ).toEqual({ kind: 'invalid', problems: ['too-many-repositories'] });
      await nothingMinted(github);
    });

    it("another workspace's installation, in the same region: Bolt never gets Acme's", async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('eu', ask({ workspaceId: 'bolt', installationId: 41 })))).toEqual({
        kind: 'installation-not-found',
      });
      expect(
        await mint(
          signedBy('eu', ask({ workspaceId: 'acme', installationId: 42, repositoryIds: [420] })),
        ),
      ).toEqual({ kind: 'installation-not-found' });
      await nothingMinted(github);
    });

    it('an installation no workspace holds, or a workspace that is not there', async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('eu', ask({ installationId: 99 })))).toEqual({
        kind: 'installation-not-found',
      });
      expect(await mint(signedBy('eu', ask({ workspaceId: 'nobody' })))).toEqual({
        kind: 'installation-not-found',
      });
      await nothingMinted(github);
    });

    it("a workspace in another region than the cell that signed: the US cell never gets Acme's", async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('us', ask()))).toEqual({ kind: 'other-region' });
      expect(
        await mint(
          signedBy(
            'eu',
            ask({ workspaceId: 'sprocket', installationId: 52, repositoryIds: [520] }),
          ),
        ),
      ).toEqual({ kind: 'other-region' });
      await nothingMinted(github);
    });

    it('a repository the installation does not cover, naming each one', async () => {
      const github = fakeGitHub();
      const { mint, signedBy } = setUp(github);
      // 520 is Sprocket's, 420 Bolt's: neither is Acme's installation's.
      expect(
        await mint(signedBy('eu', ask({ purpose: 'review-run', repositoryIds: [410, 520, 420] }))),
      ).toEqual({ kind: 'not-covered', repositoryIds: [420, 520] });
      await nothingMinted(github);
    });

    it('anything, when this server has no GitHub App', async () => {
      const { mint, signedBy } = setUp(null);
      expect(await mint(signedBy('eu', ask()))).toEqual({ kind: 'not-configured' });
      expect(await mints.mintsOf('acme')).toEqual([]);
    });

    it('an installation GitHub no longer has, or a list GitHub would not give', async () => {
      const gone = fakeGitHub(undefined, { kind: 'gone' });
      const goneCells = setUp(gone);
      expect(await goneCells.mint(goneCells.signedBy('eu', ask()))).toEqual({
        kind: 'installation-gone',
      });
      await nothingMinted(gone);

      const silent = fakeGitHub(undefined, { kind: 'unavailable' });
      const silentCells = setUp(silent);
      expect(await silentCells.mint(silentCells.signedBy('eu', ask()))).toEqual({
        kind: 'unavailable',
      });
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
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('eu', ask()))).toEqual(outcome);
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
      const { mint, signedBy } = setUp(github);
      expect(await mint(signedBy('eu', ask()))).toEqual({ kind: 'not-as-asked' });
      expect(github.revoked).toEqual(['ghs_too_wide']);
      expect(await mints.mintsOf('acme')).toEqual([]);
    },
  );

  it('revokes the token and hands out nothing when the mint cannot be recorded', async () => {
    const github = fakeGitHub();
    const cells = fakeCells();
    const failing: TokenMintStore = {
      ...mints,
      record: async () => {
        throw new Error('the database is gone');
      },
    };
    await expect(
      mintGitHubToken(
        { cellRequests: cells.verifier, mints: failing, github: github.github },
        cells.signedBy('eu', ask()),
        now,
      ),
    ).rejects.toThrow('the database is gone');
    expect(github.revoked).toEqual(['ghs_narrowed_1']);
  });
});

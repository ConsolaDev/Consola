import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInstallStateSigner } from '../adapters/github/installStateSigner.js';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { GitHubInstallation, InstallState } from '../domain/connections.js';
import type { Person, SignedIn } from '../domain/person.js';
import {
  disconnectGitHub,
  finishGitHubInstall,
  listConnections,
  startGitHubInstall,
} from './connections.js';
import type { InstallReturn } from './connections.js';
import type { GitHubApp } from './ports.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;

const states = createInstallStateSigner('sprocket-test-secret-that-is-long-enough-to-sign-with');
const now = 1_795_000_000;

const dana: Person = { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', image: null };
const lee: Person = { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', image: null };
const ana: Person = { id: 'ana', name: 'Ana', email: 'ana@catalog.test', image: null };

const session = (person: Person, activeWorkspaceId: string | null = 'sprocket'): SignedIn => ({
  sessionId: `s-${person.id}`,
  person,
  activeWorkspaceId,
});

const sprocketOrg: GitHubInstallation = {
  id: 41,
  account: { id: 9001, login: 'sprocket', type: 'Organization' },
  repositorySelection: 'selected',
};
const catalogOrg: GitHubInstallation = {
  id: 52,
  account: { id: 9002, login: 'catalog', type: 'Organization' },
  repositorySelection: 'all',
};

/**
 * GitHub, as the use cases ask it: the person with code `good-code` is GitHub user
 * `gitHubUserId`, can reach `reachable`, and has `organizationRole` in each organisation; every
 * code is refused once used.
 */
function fakeGitHub(
  reachable: GitHubInstallation[] = [sprocketOrg],
  person: { gitHubUserId: number; organizationRole: 'admin' | 'member' | null } = {
    gitHubUserId: 7,
    organizationRole: 'admin',
  },
) {
  const asked: string[] = [];
  const used = new Set<string>();
  const github: GitHubApp = {
    installUrl: (state) => `https://github.test/install?state=${state}`,
    async installerFacts(code, installationId) {
      asked.push(code);
      if (code !== 'good-code' || used.has(code)) return { kind: 'code-refused' };
      used.add(code);
      const installation = reachable.find((each) => each.id === installationId) ?? null;
      return {
        kind: 'read',
        facts: {
          installation,
          gitHubUserId: person.gitHubUserId,
          organizationRole:
            installation?.account.type === 'Organization' ? person.organizationRole : null,
        },
      };
    },
    async repositoriesOf(installationId) {
      if (installationId === catalogOrg.id) return { kind: 'gone' };
      return {
        kind: 'listed',
        repositories: [
          {
            id: 1,
            fullName: 'sprocket/catalog-portal',
            private: true,
            url: 'https://github.com/sprocket/catalog-portal',
          },
        ],
      };
    },
  };
  return { github, asked };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

async function started(person = dana, github = fakeGitHub().github) {
  const answer = await startGitHubInstall(
    { memberships: stores.memberships, github, states },
    session(person),
    now,
  );
  if (answer.kind !== 'started') throw new Error(`not started: ${answer.kind}`);
  return stateOf(answer.url);
}

function finish(
  person: Person,
  returned: InstallReturn,
  github = fakeGitHub().github,
  at = now + 30,
) {
  return finishGitHubInstall(
    { memberships: stores.memberships, installations: stores.installations, github, states },
    session(person),
    returned,
    at,
  );
}

const returned = (state: string, extra: Partial<InstallReturn> = {}): InstallReturn => ({
  state,
  code: 'good-code',
  installationId: String(sprocketOrg.id),
  setupAction: 'install',
  ...extra,
});

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values(
    [dana, lee, ana].map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      emailVerified: true,
    })),
  );
  stores = createDrizzleStores(db);
  for (const [slug, owner] of [
    ['sprocket', dana],
    ['catalog', ana],
  ] as const) {
    await db
      .insert(schema.organization)
      .values({ id: slug, name: slug, slug, region: 'eu', createdAt: new Date() });
    await db.insert(schema.member).values({
      id: `m-${slug}-${owner.id}`,
      organizationId: slug,
      userId: owner.id,
      role: 'owner',
      createdAt: new Date(),
    });
  }
  await db.insert(schema.member).values({
    id: 'm-sprocket-lee',
    organizationId: 'sprocket',
    userId: lee.id,
    role: 'member',
    createdAt: new Date(),
  });
});

afterEach(async () => {
  await close();
});

describe('connecting GitHub', () => {
  it('an owner connects an installation GitHub says they can reach', async () => {
    const state = await started();
    expect(await finish(dana, returned(state))).toEqual({
      kind: 'connected',
      workspaceId: 'sprocket',
    });
    expect(await stores.installations.ofWorkspace('sprocket')).toEqual([
      { id: 41, account: sprocketOrg.account, connectedAt: new Date((now + 30) * 1000) },
    ]);
  });

  it('an admin may too', async () => {
    await db
      .update(schema.member)
      .set({ role: 'admin' })
      .where(eq(schema.member.id, 'm-sprocket-lee'));
    const state = await started(lee);
    expect((await finish(lee, returned(state))).kind).toBe('connected');
  });

  it('a member may not start one', async () => {
    const answer = await startGitHubInstall(
      { memberships: stores.memberships, github: fakeGitHub().github, states },
      session(lee),
      now,
    );
    expect(answer).toEqual({ kind: 'not-allowed' });
  });

  it('needs a workspace the person is in, and the app configured', async () => {
    const ports = { memberships: stores.memberships, github: fakeGitHub().github, states };
    expect(await startGitHubInstall(ports, session(dana, null), now)).toEqual({
      kind: 'no-workspace',
    });
    expect(await startGitHubInstall(ports, session(dana, 'catalog'), now)).toEqual({
      kind: 'not-a-member',
    });
    expect(await startGitHubInstall({ ...ports, github: null }, session(dana), now)).toEqual({
      kind: 'not-configured',
    });
  });

  it('records the installation for the workspace the Connect was for, whatever is active now', async () => {
    await db.insert(schema.member).values({
      id: 'm-catalog-dana',
      organizationId: 'catalog',
      userId: dana.id,
      role: 'owner',
      createdAt: new Date(),
    });
    const state = await started();
    const outcome = await finishGitHubInstall(
      {
        memberships: stores.memberships,
        installations: stores.installations,
        github: fakeGitHub().github,
        states,
      },
      session(dana, 'catalog'),
      returned(state),
      now + 30,
    );
    expect(outcome).toEqual({ kind: 'connected', workspaceId: 'sprocket' });
    expect(await stores.installations.ofWorkspace('catalog')).toEqual([]);
  });

  it('refuses an installation id GitHub does not list for this person, and records nothing', async () => {
    const state = await started();
    const forged = returned(state, { installationId: String(catalogOrg.id) });
    expect(await finish(dana, forged)).toEqual({ kind: 'not-installer' });
    expect(await stores.installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it("refuses an organisation's installation to a member who does not own the organisation", async () => {
    // GitHub lists it for every member who can read one of its repositories.
    const state = await started();
    const member = fakeGitHub([sprocketOrg], { gitHubUserId: 7, organizationRole: 'member' });
    expect(await finish(dana, returned(state), member.github)).toEqual({
      kind: 'not-account-admin',
    });
    const outsider = fakeGitHub([sprocketOrg], { gitHubUserId: 7, organizationRole: null });
    expect(await finish(dana, returned(await started()), outsider.github)).toEqual({
      kind: 'not-account-admin',
    });
    expect(await stores.installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it("connects a person's own installation, and refuses someone else's", async () => {
    const danaOwn: GitHubInstallation = {
      id: 63,
      account: { id: 7, login: 'dana', type: 'User' },
      repositorySelection: 'all',
    };
    const leeOwn: GitHubInstallation = {
      ...danaOwn,
      id: 64,
      account: { ...danaOwn.account, id: 8 },
    };
    const github = () => fakeGitHub([danaOwn, leeOwn], { gitHubUserId: 7, organizationRole: null });

    const own = returned(await started(), { installationId: '63' });
    expect((await finish(dana, own, github().github)).kind).toBe('connected');
    const someoneElses = returned(await started(), { installationId: '64' });
    expect(await finish(dana, someoneElses, github().github)).toEqual({
      kind: 'not-account-admin',
    });
  });

  it('refuses an installation another workspace holds', async () => {
    const reach = [sprocketOrg];
    await stores.installations.connect({
      installation: sprocketOrg,
      workspaceId: 'catalog',
      connectedBy: ana.id,
      at: new Date(),
    });
    const state = await started();
    expect(await finish(dana, returned(state), fakeGitHub(reach).github)).toEqual({
      kind: 'taken',
    });
    expect(await stores.installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('connecting one the workspace holds again is already-connected', async () => {
    const github = fakeGitHub();
    await finish(dana, returned(await started()), github.github);
    const again = fakeGitHub();
    expect(await finish(dana, returned(await started()), again.github)).toEqual({
      kind: 'already-connected',
      workspaceId: 'sprocket',
    });
  });

  it('refuses a state from another session, and never spends the code', async () => {
    const state = await started();
    const github = fakeGitHub();
    const outcome = await finishGitHubInstall(
      {
        memberships: stores.memberships,
        installations: stores.installations,
        github: github.github,
        states,
      },
      { ...session(dana), sessionId: 'another-browser' },
      returned(state),
      now + 30,
    );
    expect(outcome).toEqual({ kind: 'bad-state' });
    expect(github.asked).toEqual([]);
  });

  it("refuses another person's state", async () => {
    const state = await started();
    expect(await finish(lee, returned(state))).toEqual({ kind: 'bad-state' });
  });

  it('refuses a state Consola did not sign, or none', async () => {
    const forged: InstallState = {
      workspaceId: 'sprocket',
      userId: dana.id,
      sessionId: 's-dana',
      expiresAt: now + 600,
    };
    const other = createInstallStateSigner('another-secret-that-is-also-long-enough-to-sign');
    expect(await finish(dana, returned(other.sign(forged)))).toEqual({ kind: 'bad-state' });
    expect(await finish(dana, { ...returned(''), state: undefined })).toEqual({
      kind: 'bad-state',
    });
  });

  it('refuses a state past its ten minutes', async () => {
    const state = await started();
    expect(await finish(dana, returned(state), fakeGitHub().github, now + 600)).toEqual({
      kind: 'expired',
    });
  });

  it('refuses a Connect finished by someone no longer an owner or admin', async () => {
    const state = await started();
    await db
      .update(schema.member)
      .set({ role: 'member' })
      .where(eq(schema.member.id, 'm-sprocket-dana'));
    expect(await finish(dana, returned(state))).toEqual({ kind: 'not-allowed' });
  });

  it('a code GitHub refuses connects nothing', async () => {
    const state = await started();
    expect(await finish(dana, returned(state, { code: 'used-code' }))).toEqual({
      kind: 'code-refused',
    });
  });

  it('a redirect with no code or a bad installation id is invalid', async () => {
    const state = await started();
    expect(await finish(dana, returned(state, { code: undefined }))).toEqual({ kind: 'invalid' });
    for (const installationId of [undefined, '', '0', '041', '4.1', '-41', '9'.repeat(17)]) {
      expect(await finish(dana, returned(state, { installationId }))).toEqual({ kind: 'invalid' });
    }
  });

  it('says so when the person only asked an organisation to install it, or said no', async () => {
    const state = await started();
    expect(await finish(dana, { state, setupAction: 'request', code: 'good-code' })).toEqual({
      kind: 'requested',
    });
    expect(await finish(dana, { state, error: 'access_denied' })).toEqual({ kind: 'cancelled' });
  });

  it('is unavailable when GitHub does not answer', async () => {
    const state = await started();
    const down: GitHubApp = {
      ...fakeGitHub().github,
      installerFacts: async () => ({ kind: 'unavailable' }),
    };
    expect(await finish(dana, returned(state), down)).toEqual({ kind: 'unavailable' });
  });
});

describe('listing connections', () => {
  const ports = (github: GitHubApp | null = fakeGitHub().github) => ({
    memberships: stores.memberships,
    installations: stores.installations,
    github,
  });

  it('shows every member the installations with their repositories, and only managers may change them', async () => {
    await finish(dana, returned(await started()));

    const forDana = await listConnections(ports(), session(dana));
    const forLee = await listConnections(ports(), session(lee));
    const expected = {
      kind: 'listed',
      github: {
        configured: true,
        installations: [
          {
            installation: {
              id: 41,
              account: sprocketOrg.account,
              connectedAt: new Date((now + 30) * 1000),
            },
            repositories: {
              kind: 'listed',
              repositories: [expect.objectContaining({ fullName: 'sprocket/catalog-portal' })],
            },
          },
        ],
      },
    };
    expect(forDana).toEqual({ ...expected, canManage: true });
    expect(forLee).toEqual({ ...expected, canManage: false });
  });

  it('names an installation GitHub no longer has as gone', async () => {
    await stores.installations.connect({
      installation: catalogOrg,
      workspaceId: 'sprocket',
      connectedBy: dana.id,
      at: new Date(),
    });
    const answer = await listConnections(ports(), session(dana));
    expect(answer.kind === 'listed' && answer.github.installations[0]?.repositories).toEqual({
      kind: 'gone',
    });
  });

  it('still lists what is recorded when the app is not configured here', async () => {
    await stores.installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: dana.id,
      at: new Date(),
    });
    const answer = await listConnections(ports(null), session(dana));
    expect(answer).toMatchObject({
      github: { configured: false, installations: [{ repositories: { kind: 'unavailable' } }] },
    });
  });

  it("shows nothing of another workspace's", async () => {
    await finish(dana, returned(await started()));
    const answer = await listConnections(ports(), session(ana, 'catalog'));
    expect(answer).toMatchObject({ github: { installations: [] } });
    expect(await listConnections(ports(), session(ana, 'sprocket'))).toEqual({
      kind: 'not-a-member',
    });
  });
});

describe('disconnecting GitHub', () => {
  const ports = () => ({ memberships: stores.memberships, installations: stores.installations });

  it('an owner disconnects, and the record goes', async () => {
    await finish(dana, returned(await started()));
    expect(await disconnectGitHub(ports(), session(dana), 41)).toEqual({ kind: 'disconnected' });
    expect(await stores.installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('a member may not', async () => {
    await finish(dana, returned(await started()));
    expect(await disconnectGitHub(ports(), session(lee), 41)).toEqual({ kind: 'not-allowed' });
    expect(await stores.installations.ofWorkspace('sprocket')).toHaveLength(1);
  });

  it("another workspace's installation is not found, and stays", async () => {
    await finish(dana, returned(await started()));
    expect(await disconnectGitHub(ports(), session(ana, 'catalog'), 41)).toEqual({
      kind: 'not-found',
    });
    expect(await stores.installations.ofWorkspace('sprocket')).toHaveLength(1);
  });
});

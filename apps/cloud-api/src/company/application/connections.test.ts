import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import { createInstallStateSigner } from '../adapters/github/installStateSigner.js';
import { createGitHubStores } from '../adapters/persistence/gitHubStores.js';
import * as gitHubTables from '../adapters/persistence/gitHubTables.js';
import { admitCaller } from '../domain/caller.js';
import type { Caller, SignedInPerson } from '../domain/caller.js';
import type { GitHubInstallation, InstallState } from '../domain/connections.js';
import {
  disconnectGitHub,
  finishGitHubInstall,
  listConnections,
  startGitHubInstall,
} from './connections.js';
import type { InstallReturn } from './connections.js';
import type { GitHubApp, InstallationStore } from './gitHubPorts.js';
import type { MembershipReader } from './ports.js';

let client: PGlite;
let installations: InstallationStore;

const states = createInstallStateSigner('sprocket-test-secret-that-is-long-enough-to-sign-with');
const now = 1_795_000_000;

/** Who is a member of which workspace, by `<workspace>/<person>`, as `member` would hold it. */
let roles: Map<string, WorkspaceRole>;

const membership: MembershipReader = {
  roleOf: async (personId, workspaceId) => roles.get(`${workspaceId}/${personId}`) ?? null,
  memberIds: async (workspaceId) =>
    [...roles.keys()]
      .filter((key) => key.startsWith(`${workspaceId}/`))
      .map((key) => key.slice(workspaceId.length + 1)),
  workspaceIds: async () => [...new Set([...roles.keys()].map((key) => key.split('/')[0] ?? ''))],
};

/** The person signed in, in their one session, with `activeWorkspaceId` active in it. */
const signedIn = (personId: string, activeWorkspaceId: string | null = 'sprocket') =>
  ({ personId, sessionId: `session-of-${personId}`, activeWorkspaceId }) satisfies SignedInPerson;

/** The caller a company route would admit: the person, in their session's active workspace. */
function callerOf(personId: string, workspaceId = 'sprocket'): Caller {
  const admitted = admitCaller({
    signedIn: signedIn(personId, workspaceId),
    shownWorkspaceId: workspaceId,
    role: roles.get(`${workspaceId}/${personId}`) ?? null,
  });
  if (!admitted.ok) throw new Error(`not admitted: ${admitted.error}`);
  return admitted.caller;
}

const sprocketOrg: GitHubInstallation = {
  id: 41,
  account: { id: 9001, login: 'sprocket', type: 'Organization' },
  repositorySelection: 'selected',
};
const acmeOrg: GitHubInstallation = {
  id: 52,
  account: { id: 9002, login: 'acme', type: 'Organization' },
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
      if (installationId === acmeOrg.id) return { kind: 'gone' };
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

function started(personId = 'dana', github = fakeGitHub().github) {
  const answer = startGitHubInstall({ github, states }, callerOf(personId), now);
  if (answer.kind !== 'started') throw new Error(`not started: ${answer.kind}`);
  return stateOf(answer.url);
}

function finish(
  personId: string,
  returned: InstallReturn,
  github = fakeGitHub().github,
  at = now + 30,
) {
  return finishGitHubInstall(
    { membership, installations, github, states },
    signedIn(personId),
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
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  ({ installations } = createGitHubStores(drizzle(client)));
  // Dana owns Sprocket and Lee is a member of it; Ana owns Acme.
  roles = new Map<string, WorkspaceRole>([
    ['sprocket/dana', 'owner'],
    ['sprocket/lee', 'member'],
    ['acme/ana', 'owner'],
  ]);
});

afterEach(async () => {
  await client.close();
});

describe('connecting GitHub', () => {
  it('an owner connects an installation GitHub says they can reach', async () => {
    const state = started();
    expect(await finish('dana', returned(state))).toEqual({
      kind: 'connected',
      workspaceId: 'sprocket',
    });
    expect(await installations.ofWorkspace('sprocket')).toEqual([
      { id: 41, account: sprocketOrg.account, connectedAt: new Date((now + 30) * 1000) },
    ]);
  });

  it('an admin may too', async () => {
    roles.set('sprocket/lee', 'admin');
    const state = started('lee');
    expect((await finish('lee', returned(state))).kind).toBe('connected');
  });

  it('a member may not start one', () => {
    const answer = startGitHubInstall(
      { github: fakeGitHub().github, states },
      callerOf('lee'),
      now,
    );
    expect(answer).toEqual({ kind: 'not-allowed' });
  });

  it('needs the app configured', () => {
    expect(startGitHubInstall({ github: null, states }, callerOf('dana'), now)).toEqual({
      kind: 'not-configured',
    });
  });

  it('records the installation for the workspace the Connect was for, whatever is active now', async () => {
    roles.set('acme/dana', 'owner');
    const state = started();
    const outcome = await finishGitHubInstall(
      { membership, installations, github: fakeGitHub().github, states },
      signedIn('dana', 'acme'),
      returned(state),
      now + 30,
    );
    expect(outcome).toEqual({ kind: 'connected', workspaceId: 'sprocket' });
    expect(await installations.ofWorkspace('acme')).toEqual([]);
  });

  it('refuses an installation id GitHub does not list for this person, and records nothing', async () => {
    const state = started();
    const forged = returned(state, { installationId: String(acmeOrg.id) });
    expect(await finish('dana', forged)).toEqual({ kind: 'not-installer' });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it("refuses an organisation's installation to a member who does not own the organisation", async () => {
    // GitHub lists it for every member who can read one of its repositories.
    const state = started();
    const member = fakeGitHub([sprocketOrg], { gitHubUserId: 7, organizationRole: 'member' });
    expect(await finish('dana', returned(state), member.github)).toEqual({
      kind: 'not-account-admin',
    });
    const outsider = fakeGitHub([sprocketOrg], { gitHubUserId: 7, organizationRole: null });
    expect(await finish('dana', returned(started()), outsider.github)).toEqual({
      kind: 'not-account-admin',
    });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
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

    const own = returned(started(), { installationId: '63' });
    expect((await finish('dana', own, github().github)).kind).toBe('connected');
    const someoneElses = returned(started(), { installationId: '64' });
    expect(await finish('dana', someoneElses, github().github)).toEqual({
      kind: 'not-account-admin',
    });
  });

  it('refuses an installation another workspace holds', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'acme',
      connectedBy: 'ana',
      at: new Date(),
    });
    const state = started();
    expect(await finish('dana', returned(state), fakeGitHub([sprocketOrg]).github)).toEqual({
      kind: 'taken',
    });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('connecting one the workspace holds again is already-connected', async () => {
    await finish('dana', returned(started()), fakeGitHub().github);
    expect(await finish('dana', returned(started()), fakeGitHub().github)).toEqual({
      kind: 'already-connected',
      workspaceId: 'sprocket',
    });
  });

  it("refuses another person's state, and never spends the code", async () => {
    const state = started();
    const github = fakeGitHub();
    expect(await finish('lee', returned(state), github.github)).toEqual({ kind: 'bad-state' });
    expect(github.asked).toEqual([]);
  });

  it("refuses the person's own state from another of their sessions, and never spends the code", async () => {
    // Dana started the Connect in one browser; the redirect comes back to another, signed in too.
    const state = started();
    const github = fakeGitHub();
    const elsewhere = { ...signedIn('dana'), sessionId: 'session-of-dana-elsewhere' };
    const outcome = await finishGitHubInstall(
      { membership, installations, github: github.github, states },
      elsewhere,
      returned(state),
      now + 30,
    );
    expect(outcome).toEqual({ kind: 'bad-state' });
    expect(github.asked).toEqual([]);
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('refuses a state Consola did not sign, or none', async () => {
    const forged: InstallState = {
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-of-dana',
      expiresAt: now + 600,
    };
    const other = createInstallStateSigner('another-secret-that-is-also-long-enough-to-sign');
    expect(await finish('dana', returned(other.sign(forged)))).toEqual({ kind: 'bad-state' });
    expect(await finish('dana', { ...returned(''), state: undefined })).toEqual({
      kind: 'bad-state',
    });
  });

  it('refuses a state past its ten minutes', async () => {
    const state = started();
    expect(await finish('dana', returned(state), fakeGitHub().github, now + 600)).toEqual({
      kind: 'expired',
    });
  });

  it('refuses a Connect finished by someone no longer an owner or admin', async () => {
    const state = started();
    roles.set('sprocket/dana', 'member');
    expect(await finish('dana', returned(state))).toEqual({ kind: 'not-allowed' });
  });

  it('refuses a Connect finished by someone no longer in the workspace', async () => {
    const state = started();
    roles.delete('sprocket/dana');
    expect(await finish('dana', returned(state))).toEqual({ kind: 'not-allowed' });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('a code GitHub refuses connects nothing', async () => {
    const state = started();
    expect(await finish('dana', returned(state, { code: 'used-code' }))).toEqual({
      kind: 'code-refused',
    });
  });

  it('a redirect with no code or a bad installation id is invalid', async () => {
    const state = started();
    expect(await finish('dana', returned(state, { code: undefined }))).toEqual({
      kind: 'invalid',
    });
    for (const installationId of [undefined, '', '0', '041', '4.1', '-41', '9'.repeat(17)]) {
      expect(await finish('dana', returned(state, { installationId }))).toEqual({
        kind: 'invalid',
      });
    }
  });

  it('says so when the person only asked an organisation to install it, or said no', async () => {
    const state = started();
    expect(await finish('dana', { state, setupAction: 'request', code: 'good-code' })).toEqual({
      kind: 'requested',
    });
    expect(await finish('dana', { state, error: 'access_denied' })).toEqual({
      kind: 'cancelled',
    });
  });

  it('is unavailable when GitHub does not answer', async () => {
    const state = started();
    const down: GitHubApp = {
      ...fakeGitHub().github,
      installerFacts: async () => ({ kind: 'unavailable' }),
    };
    expect(await finish('dana', returned(state), down)).toEqual({ kind: 'unavailable' });
  });

  it('is not configured when this server has no GitHub App, whatever came back', async () => {
    const state = started();
    expect(
      await finishGitHubInstall(
        { membership, installations, github: null, states },
        signedIn('dana'),
        returned(state),
        now + 30,
      ),
    ).toEqual({ kind: 'not-configured' });
  });
});

describe('listing connections', () => {
  const ports = (github: GitHubApp | null = fakeGitHub().github) => ({ installations, github });

  it('shows every member the installations with their repositories, and only managers may change them', async () => {
    await finish('dana', returned(started()));

    const forDana = await listConnections(ports(), callerOf('dana'));
    const forLee = await listConnections(ports(), callerOf('lee'));
    const expected = {
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
    await installations.connect({
      installation: acmeOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: new Date(),
    });
    const answer = await listConnections(ports(), callerOf('dana'));
    expect(answer.github.installations[0]?.repositories).toEqual({ kind: 'gone' });
  });

  it('still lists what is recorded when the app is not configured here', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: new Date(),
    });
    const answer = await listConnections(ports(null), callerOf('dana'));
    expect(answer).toMatchObject({
      github: { configured: false, installations: [{ repositories: { kind: 'unavailable' } }] },
    });
  });

  it("shows nothing of another workspace's", async () => {
    await finish('dana', returned(started()));
    const answer = await listConnections(ports(), callerOf('ana', 'acme'));
    expect(answer).toMatchObject({ github: { installations: [] } });
  });
});

describe('disconnecting GitHub', () => {
  const ports = () => ({ installations });

  it('an owner disconnects, and the record goes', async () => {
    await finish('dana', returned(started()));
    expect(await disconnectGitHub(ports(), callerOf('dana'), 41)).toEqual({
      kind: 'disconnected',
    });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('a member may not', async () => {
    await finish('dana', returned(started()));
    expect(await disconnectGitHub(ports(), callerOf('lee'), 41)).toEqual({
      kind: 'not-allowed',
    });
    expect(await installations.ofWorkspace('sprocket')).toHaveLength(1);
  });

  it("another workspace's installation is not found, and stays", async () => {
    await finish('dana', returned(started()));
    expect(await disconnectGitHub(ports(), callerOf('ana', 'acme'), 41)).toEqual({
      kind: 'not-found',
    });
    expect(await installations.ofWorkspace('sprocket')).toHaveLength(1);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import { createInstallChoiceSigner } from '../adapters/github/installChoiceSigner.js';
import { createInstallStateSigner } from '../adapters/github/installStateSigner.js';
import { createGitHubStores } from '../adapters/persistence/gitHubStores.js';
import * as gitHubTables from '../adapters/persistence/gitHubTables.js';
import { admitCaller } from '../domain/caller.js';
import type { Caller, SignedInPerson } from '../domain/caller.js';
import { INSTALL_CHOICE_LIFETIME_SECONDS, MAX_INSTALL_CANDIDATES } from '../domain/connections.js';
import type { GitHubInstallation, InstallChoice, InstallState } from '../domain/connections.js';
import {
  connectChosenInstallation,
  disconnectGitHub,
  finishGitHubInstall,
  listConnections,
  readGitHubChoice,
  startGitHubInstall,
} from './connections.js';
import type { InstallReturn } from './connections.js';
import type { GitHubApp, InstallationStore } from './gitHubPorts.js';
import type { MembershipReader } from './ports.js';

let client: PGlite;
let installations: InstallationStore;

const SECRET = 'sprocket-test-secret-that-is-long-enough-to-sign-with';
const states = createInstallStateSigner(SECRET);
const choices = createInstallChoiceSigner(SECRET);
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
  const factsOf = (installation: GitHubInstallation | null) => ({
    installation,
    gitHubUserId: person.gitHubUserId,
    organizationRole:
      installation?.account.type === 'Organization' ? person.organizationRole : null,
  });
  const github: GitHubApp = {
    signInUrl: (state) => `https://github.test/sign-in?state=${state}`,
    installUrl: (state) => `https://github.test/install?state=${state}`,
    async installerFacts(code, installationId) {
      asked.push(code);
      if (code !== 'good-code' || used.has(code)) return { kind: 'code-refused' };
      used.add(code);
      const installation = reachable.find((each) => each.id === installationId) ?? null;
      return { kind: 'read', facts: factsOf(installation) };
    },
    async installationsOf(code) {
      asked.push(code);
      if (code !== 'good-code' || used.has(code)) return { kind: 'code-refused' };
      used.add(code);
      return { kind: 'read', installations: reachable.map(factsOf) };
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
    { membership, installations, github, states, choices },
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
      { membership, installations, github: fakeGitHub().github, states, choices },
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
      { membership, installations, github: github.github, states, choices },
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
    // From signing in, with no installation named, a code is needed all the same.
    expect(
      await finish('dana', returned(state, { code: undefined, installationId: undefined })),
    ).toEqual({ kind: 'invalid' });
    for (const installationId of ['', '0', '041', '4.1', '-41', '9'.repeat(17)]) {
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
        { membership, installations, github: null, states, choices },
        signedIn('dana'),
        returned(state),
        now + 30,
      ),
    ).toEqual({ kind: 'not-configured' });
  });
});

describe('connecting an installation the person already has, by signing in first', () => {
  const danaOwn: GitHubInstallation = {
    id: 63,
    account: { id: 7, login: 'dana', type: 'User' },
    repositorySelection: 'all',
  };
  const leeOwn: GitHubInstallation = {
    id: 64,
    account: { id: 8, login: 'lee', type: 'User' },
    repositorySelection: 'all',
  };

  /** GitHub sending Dana back from signing in: a code, the state, and no installation. */
  const signedInReturn = (state: string, extra: Partial<InstallReturn> = {}): InstallReturn => ({
    state,
    code: 'good-code',
    ...extra,
  });

  /** The choice a sign-in ended in, read back as the signer reads it. */
  async function choiceAfterSignIn(
    github: GitHubApp,
    personId = 'dana',
  ): Promise<{ token: string; choice: InstallChoice }> {
    const outcome = await finish(personId, signedInReturn(started(personId, github)), github);
    if (outcome.kind !== 'choose') throw new Error(`no choice: ${outcome.kind}`);
    const choice = choices.read(outcome.choice);
    if (choice === null) throw new Error('the choice does not read');
    return { token: outcome.choice, choice };
  }

  it('starts at GitHub sign-in, with the install page beside it, both carrying one state', () => {
    const answer = startGitHubInstall(
      { github: fakeGitHub().github, states },
      callerOf('dana'),
      now,
    );
    if (answer.kind !== 'started') throw new Error(answer.kind);
    expect(answer.url).toMatch(/^https:\/\/github\.test\/sign-in\?state=/);
    expect(answer.installUrl).toMatch(/^https:\/\/github\.test\/install\?state=/);
    const state = states.read(stateOf(answer.url));
    expect(state).toEqual({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-of-dana',
      expiresAt: now + 600,
    });
    expect(states.read(stateOf(answer.installUrl))).toEqual(state);
  });

  it('offers the one installation the person administers, and records nothing yet', async () => {
    const { choice } = await choiceAfterSignIn(fakeGitHub([sprocketOrg]).github);
    expect(choice).toEqual({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-of-dana',
      expiresAt: now + 30 + INSTALL_CHOICE_LIFETIME_SECONDS,
      candidates: [{ id: 41, account: sprocketOrg.account }],
    });
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('offers only what the person administers and no workspace holds, and connects the one chosen', async () => {
    await installations.connect({
      installation: acmeOrg,
      workspaceId: 'acme',
      connectedBy: 'ana',
      at: new Date(),
    });
    // Dana reaches sprocket (an owner), acme (held by Ana's workspace), her own account and Lee's.
    const github = fakeGitHub([sprocketOrg, acmeOrg, danaOwn, leeOwn]);
    const { token, choice } = await choiceAfterSignIn(github.github);
    expect(choice.candidates).toEqual([
      { id: 41, account: sprocketOrg.account },
      { id: 63, account: danaOwn.account },
    ]);

    expect(
      await connectChosenInstallation(
        { choices, installations },
        callerOf('dana'),
        { choice: token, installationId: 63 },
        now + 60,
      ),
    ).toEqual({ kind: 'connected' });
    expect(await installations.ofWorkspace('sprocket')).toEqual([
      { id: 63, account: danaOwn.account, connectedAt: new Date((now + 60) * 1000) },
    ]);
    expect(await installations.holderOf(41)).toBeNull();
  });

  it('offers at most twenty, in the order GitHub lists them', async () => {
    const many: GitHubInstallation[] = Array.from({ length: 25 }, (_, n) => ({
      id: 1000 + n,
      account: { id: 5000 + n, login: `org-${n}`, type: 'Organization' },
      repositorySelection: 'all',
    }));
    const { choice } = await choiceAfterSignIn(fakeGitHub(many).github);
    expect(choice.candidates.map((each) => each.id)).toEqual(
      many.slice(0, MAX_INSTALL_CANDIDATES).map((each) => each.id),
    );
  });

  it('goes on to install the app, with a fresh state, when the person administers none', async () => {
    const member = fakeGitHub([sprocketOrg, leeOwn], {
      gitHubUserId: 7,
      organizationRole: 'member',
    });
    const outcome = await finish(
      'dana',
      signedInReturn(started('dana', member.github)),
      member.github,
    );
    if (outcome.kind !== 'install') throw new Error(outcome.kind);
    expect(outcome.url).toMatch(/^https:\/\/github\.test\/install\?state=/);
    expect(states.read(stateOf(outcome.url))).toEqual({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-of-dana',
      expiresAt: now + 30 + 600,
    });

    const none = fakeGitHub([]);
    expect(
      (await finish('dana', signedInReturn(started('dana', none.github)), none.github)).kind,
    ).toBe('install');
  });

  it('goes on to install the app when every installation the person administers is held already', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'acme',
      connectedBy: 'ana',
      at: new Date(),
    });
    await installations.connect({
      installation: danaOwn,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: new Date(),
    });
    const github = fakeGitHub([sprocketOrg, danaOwn]);
    const outcome = await finish(
      'dana',
      signedInReturn(started('dana', github.github)),
      github.github,
    );
    expect(outcome.kind).toBe('install');
  });

  it("refuses another person's state, and never spends the code", async () => {
    const github = fakeGitHub();
    const state = started('dana', github.github);
    expect(await finish('lee', signedInReturn(state), github.github)).toEqual({
      kind: 'bad-state',
    });
    expect(github.asked).toEqual([]);
  });

  it("refuses the person's own state from another of their sessions, and never spends the code", async () => {
    const github = fakeGitHub();
    const state = started('dana', github.github);
    const elsewhere = { ...signedIn('dana'), sessionId: 'session-of-dana-elsewhere' };
    const outcome = await finishGitHubInstall(
      { membership, installations, github: github.github, states, choices },
      elsewhere,
      signedInReturn(state),
      now + 30,
    );
    expect(outcome).toEqual({ kind: 'bad-state' });
    expect(github.asked).toEqual([]);
  });

  it('refuses someone no longer an owner or admin before GitHub is asked', async () => {
    const github = fakeGitHub();
    const state = started('dana', github.github);
    roles.set('sprocket/dana', 'member');
    expect(await finish('dana', signedInReturn(state), github.github)).toEqual({
      kind: 'not-allowed',
    });
    expect(github.asked).toEqual([]);
  });

  it('says so when GitHub refuses the code, or does not answer', async () => {
    const state = started();
    expect(await finish('dana', signedInReturn(state, { code: 'used-code' }))).toEqual({
      kind: 'code-refused',
    });
    const down: GitHubApp = {
      ...fakeGitHub().github,
      installationsOf: async () => ({ kind: 'unavailable' }),
    };
    expect(await finish('dana', signedInReturn(state), down)).toEqual({ kind: 'unavailable' });
  });

  it('says so when the person said no to signing in', async () => {
    const github = fakeGitHub();
    const state = started('dana', github.github);
    expect(await finish('dana', { state, error: 'access_denied' }, github.github)).toEqual({
      kind: 'cancelled',
    });
    expect(github.asked).toEqual([]);
  });

  describe('the choice', () => {
    const sprocketChoice = (overrides: Partial<InstallChoice> = {}): InstallChoice => ({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-of-dana',
      expiresAt: now + 300,
      candidates: [{ id: 41, account: sprocketOrg.account }],
      ...overrides,
    });
    const token = (overrides: Partial<InstallChoice> = {}) =>
      choices.sign(sprocketChoice(overrides));
    const connectAs = (caller: Caller, choice: string, installationId = 41, at = now) =>
      connectChosenInstallation({ choices, installations }, caller, { choice, installationId }, at);

    it('reads its candidates back for the session that signed in', () => {
      expect(readGitHubChoice({ choices }, callerOf('dana'), token(), now)).toEqual({
        kind: 'read',
        candidates: [{ id: 41, account: sprocketOrg.account }],
      });
    });

    it('is refused to another session or another person, or one Consola did not sign', () => {
      const elsewhere = admitCaller({
        signedIn: { ...signedIn('dana'), sessionId: 'session-of-dana-elsewhere' },
        shownWorkspaceId: 'sprocket',
        role: 'owner',
      });
      if (!elsewhere.ok) throw new Error(elsewhere.error);
      roles.set('sprocket/lee', 'owner');
      const forged = createInstallChoiceSigner('another-secret-that-is-also-long-enough-to-sign');
      // A Connect's state, signed with the state's own key, is no choice either.
      const aState = states.sign({
        workspaceId: 'sprocket',
        personId: 'dana',
        sessionId: 'session-of-dana',
        expiresAt: now + 300,
      });
      for (const [caller, choice] of [
        [elsewhere.caller, token()],
        [callerOf('lee'), token()],
        [callerOf('dana'), forged.sign(sprocketChoice())],
        [callerOf('dana'), aState],
        [callerOf('dana'), 'not-a-choice'],
      ] as const) {
        expect(readGitHubChoice({ choices }, caller, choice, now)).toEqual({ kind: 'bad-choice' });
      }
    });

    it('is expired from the second its five minutes end', () => {
      expect(readGitHubChoice({ choices }, callerOf('dana'), token(), now + 299).kind).toBe('read');
      expect(readGitHubChoice({ choices }, callerOf('dana'), token(), now + 300)).toEqual({
        kind: 'expired',
      });
    });

    it('is refused once the session has another workspace active', () => {
      roles.set('acme/dana', 'owner');
      expect(readGitHubChoice({ choices }, callerOf('dana', 'acme'), token(), now)).toEqual({
        kind: 'other-workspace',
      });
    });

    it('is shown only to an owner or admin, by their role now', () => {
      roles.set('sprocket/dana', 'member');
      expect(readGitHubChoice({ choices }, callerOf('dana'), token(), now)).toEqual({
        kind: 'not-allowed',
      });
    });

    it('connects only one of its candidates', async () => {
      expect(await connectAs(callerOf('dana'), token(), 52)).toEqual({ kind: 'not-a-candidate' });
      expect(await installations.ofWorkspace('sprocket')).toEqual([]);
    });

    it('connects nothing for someone no longer an owner or admin', async () => {
      const choice = token();
      roles.set('sprocket/dana', 'member');
      expect(await connectAs(callerOf('dana'), choice)).toEqual({ kind: 'not-allowed' });
      expect(await installations.ofWorkspace('sprocket')).toEqual([]);
    });

    it('connects nothing another workspace connected since the choice was made', async () => {
      const choice = token();
      await installations.connect({
        installation: sprocketOrg,
        workspaceId: 'acme',
        connectedBy: 'ana',
        at: new Date(),
      });
      expect(await connectAs(callerOf('dana'), choice)).toEqual({ kind: 'taken' });
      expect(await installations.ofWorkspace('sprocket')).toEqual([]);
    });

    it('is already-connected the second time, and checks the whole choice each time', async () => {
      const choice = token();
      expect(await connectAs(callerOf('dana'), choice)).toEqual({ kind: 'connected' });
      expect(await connectAs(callerOf('dana'), choice)).toEqual({ kind: 'already-connected' });
      expect(await connectAs(callerOf('dana'), choice, 41, now + 300)).toEqual({
        kind: 'expired',
      });
      expect(await installations.ofWorkspace('sprocket')).toHaveLength(1);
    });

    it('connects nothing for an expired, forged or foreign choice', async () => {
      const forged = createInstallChoiceSigner('another-secret-that-is-also-long-enough-to-sign');
      roles.set('acme/dana', 'owner');
      expect(await connectAs(callerOf('dana'), token(), 41, now + 300)).toEqual({
        kind: 'expired',
      });
      expect(await connectAs(callerOf('dana'), forged.sign(sprocketChoice()))).toEqual({
        kind: 'bad-choice',
      });
      expect(await connectAs(callerOf('dana'), token({ sessionId: 'session-of-lee' }))).toEqual({
        kind: 'bad-choice',
      });
      expect(await connectAs(callerOf('dana', 'acme'), token())).toEqual({
        kind: 'other-workspace',
      });
      expect(await installations.holderOf(41)).toBeNull();
    });
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

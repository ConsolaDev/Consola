import type { Caller, SignedInPerson } from '../domain/caller.js';
import {
  administeredInstallations,
  candidateOf,
  checkInstallChoice,
  checkInstaller,
  checkInstallState,
  mayManageConnections,
  newInstallChoice,
  newInstallState,
  readGitHubId,
} from '../domain/connections.js';
import type {
  AskingSession,
  ConnectedInstallation,
  GitHubRepository,
  InstallCandidate,
} from '../domain/connections.js';
import type {
  GitHubApp,
  InstallationStore,
  InstallChoiceSigner,
  InstallStateSigner,
} from './gitHubPorts.js';
import type { MembershipReader } from './ports.js';

/** What GitHub says an installation covers, or why it could not say. */
export type RepositoriesAnswer =
  | { kind: 'listed'; repositories: GitHubRepository[] }
  | { kind: 'gone' }
  | { kind: 'unavailable' };

/** A GitHub installation the workspace holds, with the repositories GitHub says it covers now. */
export type GitHubConnection = {
  installation: ConnectedInstallation;
  repositories: RepositoriesAnswer;
};

/** What the caller's workspace is connected to, and whether they may change it. */
export type Connections = {
  canManage: boolean;
  github: { configured: boolean; installations: GitHubConnection[] };
};

/**
 * What the caller's workspace is connected to, for any of its members, and whether the caller
 * may change it (`canManage`, from their role at this request). The repositories are asked of
 * GitHub each time rather than kept, so they are never stale; when GitHub cannot answer, or the
 * app is not configured on this server, the installation is still listed, with `unavailable`
 * repositories.
 */
export async function listConnections(
  ports: { installations: InstallationStore; github: GitHubApp | null },
  caller: Caller,
): Promise<Connections> {
  const { github } = ports;
  const held = await ports.installations.ofWorkspace(caller.workspaceId);
  const installations = await Promise.all(
    held.map(
      async (installation): Promise<GitHubConnection> => ({
        installation,
        repositories: github
          ? await github.repositoriesOf(installation.id)
          : { kind: 'unavailable' },
      }),
    ),
  );
  return {
    canManage: mayManageConnections(caller.role),
    github: { configured: github !== null, installations },
  };
}

/**
 * Starts connecting the caller's workspace to GitHub, with a signed state that only this person,
 * in this session, can finish with, until `INSTALL_STATE_LIFETIME_SECONDS` after `now` (whole
 * seconds since the epoch): `url`, GitHub's sign-in authorization for the app, which a Connect
 * starts with, since GitHub always sends the person back from it; and `installUrl`, the app's
 * install page, for installing it on another account. Only an owner or an admin may
 * (`not-allowed` otherwise).
 */
export function startGitHubInstall(
  ports: { github: GitHubApp | null; states: InstallStateSigner },
  caller: Caller,
  now: number,
):
  | { kind: 'started'; url: string; installUrl: string }
  | { kind: 'not-allowed' }
  | { kind: 'not-configured' } {
  if (!mayManageConnections(caller.role)) return { kind: 'not-allowed' };
  if (!ports.github) return { kind: 'not-configured' };

  const state = ports.states.sign(newInstallState(caller, caller.workspaceId, now));
  return {
    kind: 'started',
    url: ports.github.signInUrl(state),
    installUrl: ports.github.installUrl(state),
  };
}

/** What GitHub's redirect back to Consola carries, each as the query string has it. */
export type InstallReturn = {
  state?: string;
  code?: string;
  installationId?: string;
  setupAction?: string;
  error?: string;
};

/** How a Connect that GitHub sent back ended. */
export type InstallOutcome =
  | { kind: 'connected'; workspaceId: string }
  | { kind: 'already-connected'; workspaceId: string }
  /** The person asked a GitHub organisation's owners to install the app; nothing is installed yet. */
  | { kind: 'requested' }
  /** The person said no to GitHub's authorisation. */
  | { kind: 'cancelled' }
  /** No state, one Consola did not sign, or another session's (another person's above all). */
  | { kind: 'bad-state' }
  | { kind: 'expired' }
  /** The person is no longer an owner or admin of the workspace the Connect was for. */
  | { kind: 'not-allowed' }
  /** GitHub refused the code: used already, expired or made up. */
  | { kind: 'code-refused' }
  /** The installation is not one GitHub says this person can reach. */
  | { kind: 'not-installer' }
  /**
   * The person can reach the installation but does not administer its account: a member, not an
   * owner, of its organisation, or someone else's personal installation.
   */
  | { kind: 'not-account-admin' }
  /** Another workspace holds the installation. */
  | { kind: 'taken' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'not-configured' }
  /**
   * The person signed in, and administers no installation of the app that is free: on to the
   * app's install page, with a fresh state, to install it on an account.
   */
  | { kind: 'install'; url: string }
  /**
   * The person signed in, and administers installations of the app no workspace holds: theirs to
   * choose from, as a signed choice (`InstallChoice`) the page reads and sends back.
   */
  | { kind: 'choose'; choice: string };

/**
 * Finishes a Connect when GitHub sends the person back, for the workspace the Connect was started
 * for, whatever their session has active by then. The person is the signed-in one (`signedIn`),
 * and each check comes before anything that trusts what the redirect says:
 *
 * 1. the state is this session's own (this person's, in the browser they started in), signed by
 *    Consola and in time;
 * 2. the person is still an owner or admin of that workspace, read from `member` now.
 *
 * A redirect from installing the app names the installation (`installation_id`), which is then
 * recorded once:
 *
 * 3. GitHub, asked with the redirect's one-time code, lists the installation among those this
 *    person can reach, since the `installation_id` in the address can be forged, and says they
 *    administer its account (`checkInstaller`): reaching it is not enough, since every member
 *    of an organisation reaches its installation;
 * 4. no other workspace holds it.
 *
 * A redirect from signing in names none (`chooseOrInstall`): GitHub, asked with the code, lists
 * the installations the person administers, and those no workspace holds are theirs to choose
 * from, or, with none, the person goes on to install the app.
 */
export async function finishGitHubInstall(
  ports: {
    membership: MembershipReader;
    installations: InstallationStore;
    github: GitHubApp | null;
    states: InstallStateSigner;
    choices: InstallChoiceSigner;
  },
  signedIn: SignedInPerson,
  returned: InstallReturn,
  now: number,
): Promise<InstallOutcome> {
  const { github } = ports;
  if (!github) return { kind: 'not-configured' };

  const state = returned.state === undefined ? null : ports.states.read(returned.state);
  const checked = checkInstallState(state, signedIn, now);
  if (checked === 'expired') return { kind: 'expired' };
  if (checked !== 'ok' || state === null) return { kind: 'bad-state' };

  if (returned.error !== undefined) return { kind: 'cancelled' };
  if (returned.setupAction === 'request') return { kind: 'requested' };

  const { workspaceId } = state;
  const role = await ports.membership.roleOf(signedIn.personId, workspaceId);
  if (role === null || !mayManageConnections(role)) return { kind: 'not-allowed' };

  if (returned.installationId === undefined) {
    if (!returned.code) return { kind: 'invalid' };
    return chooseOrInstall({ ...ports, github }, signedIn, workspaceId, returned.code, now);
  }

  const installationId = readGitHubId(returned.installationId);
  if (installationId === null || !returned.code) return { kind: 'invalid' };

  const asked = await github.installerFacts(returned.code, installationId);
  if (asked.kind !== 'read') return asked;
  const installer = checkInstaller(asked.facts);
  if (!installer.ok) return { kind: installer.reason };
  const { installation } = installer;

  const recorded = await ports.installations.connect({
    installation,
    workspaceId,
    connectedBy: signedIn.personId,
    at: new Date(now * 1000),
  });
  if (recorded === 'taken') return { kind: 'taken' };
  return { kind: recorded, workspaceId };
}

/**
 * What a Connect that GitHub sent back from signing in goes on to: GitHub, asked with the one-time
 * `code`, lists the installations of the app the person can reach, of which they administer
 * some (`administeredInstallations`), and those no workspace holds, this one included, are theirs
 * to choose from (`choose`, at most `MAX_INSTALL_CANDIDATES`). With none, the person goes on to
 * the app's install page, with a fresh state (`install`), from where GitHub sends them back with
 * the installation they make.
 */
async function chooseOrInstall(
  ports: {
    installations: InstallationStore;
    github: GitHubApp;
    states: InstallStateSigner;
    choices: InstallChoiceSigner;
  },
  asking: AskingSession,
  workspaceId: string,
  code: string,
  now: number,
): Promise<InstallOutcome> {
  const { github } = ports;
  const asked = await github.installationsOf(code);
  if (asked.kind !== 'read') return asked;

  const free: InstallCandidate[] = [];
  for (const installation of administeredInstallations(asked.installations)) {
    if ((await ports.installations.holderOf(installation.id)) === null) free.push(installation);
  }
  if (free.length === 0) {
    const state = ports.states.sign(newInstallState(asking, workspaceId, now));
    return { kind: 'install', url: github.installUrl(state) };
  }
  const choice = newInstallChoice(asking, workspaceId, free, now);
  return { kind: 'choose', choice: ports.choices.sign(choice) };
}

/** Why a choice of installation the page sent back cannot be made. */
export type ChoiceRefusal =
  /** Not one Consola signed, or another session's (another person's above all). */
  | { kind: 'bad-choice' }
  | { kind: 'expired' }
  /** Made for another workspace than the session has active now. */
  | { kind: 'other-workspace' }
  /** The person is no longer an owner or admin of the workspace. */
  | { kind: 'not-allowed' };

/** The choice the page sent back, once checked as this session's own, in time, for here. */
function readChoice(
  choices: InstallChoiceSigner,
  caller: Caller,
  token: string,
  now: number,
):
  | { kind: 'read'; candidates: InstallCandidate[] }
  | Exclude<ChoiceRefusal, { kind: 'not-allowed' }> {
  const choice = choices.read(token);
  const checked = checkInstallChoice(choice, caller, now);
  if (checked === 'expired') return { kind: 'expired' };
  if (checked === 'other-workspace') return { kind: 'other-workspace' };
  if (checked !== 'ok' || choice === null) return { kind: 'bad-choice' };
  return { kind: 'read', candidates: choice.candidates };
}

/**
 * The installations a choice offers the caller (`InstallChoice`), as the page shows them once
 * GitHub sent the person back from signing in. Only for the session that signed in, in time, in
 * the workspace it was for, and only for an owner or an admin, read at this request.
 */
export function readGitHubChoice(
  ports: { choices: InstallChoiceSigner },
  caller: Caller,
  token: string,
  now: number,
): { kind: 'read'; candidates: InstallCandidate[] } | ChoiceRefusal {
  const read = readChoice(ports.choices, caller, token, now);
  if (read.kind !== 'read') return read;
  if (!mayManageConnections(caller.role)) return { kind: 'not-allowed' };
  return read;
}

/**
 * Connects the installation the caller chose of a choice's candidates to the caller's workspace,
 * and records it as a fresh install records one. Everything that can change since the choice was
 * signed is checked again first, in this order: the choice is this session's own, in time, for
 * this workspace; the installation is one of its candidates (`not-a-candidate`); the caller is
 * still an owner or admin, by their role at this request; and no other workspace holds it
 * (`taken`, even at the same moment). The choice itself is kept nowhere: each call checks it
 * whole.
 */
export async function connectChosenInstallation(
  ports: { choices: InstallChoiceSigner; installations: InstallationStore },
  caller: Caller,
  chosen: { choice: string; installationId: number },
  now: number,
): Promise<
  | { kind: 'connected' }
  | { kind: 'already-connected' }
  | ChoiceRefusal
  | { kind: 'not-a-candidate' }
  | { kind: 'taken' }
> {
  const read = readChoice(ports.choices, caller, chosen.choice, now);
  if (read.kind !== 'read') return read;
  const candidate = candidateOf(read, chosen.installationId);
  if (candidate === null) return { kind: 'not-a-candidate' };
  if (!mayManageConnections(caller.role)) return { kind: 'not-allowed' };

  const recorded = await ports.installations.connect({
    installation: candidate,
    workspaceId: caller.workspaceId,
    connectedBy: caller.personId,
    at: new Date(now * 1000),
  });
  return { kind: recorded };
}

/**
 * Disconnects a GitHub installation from the caller's workspace: Consola's record goes, and the
 * app stays installed on GitHub until someone uninstalls it there. Only an owner or an admin may
 * (`not-allowed` otherwise). An installation the workspace does not hold, another workspace's
 * included, is `not-found`.
 */
export async function disconnectGitHub(
  ports: { installations: InstallationStore },
  caller: Caller,
  installationId: number,
): Promise<{ kind: 'disconnected' } | { kind: 'not-found' } | { kind: 'not-allowed' }> {
  if (!mayManageConnections(caller.role)) return { kind: 'not-allowed' };
  const removed = await ports.installations.disconnect({
    workspaceId: caller.workspaceId,
    installationId,
  });
  return removed ? { kind: 'disconnected' } : { kind: 'not-found' };
}

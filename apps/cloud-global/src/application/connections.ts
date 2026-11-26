import {
  checkInstaller,
  checkInstallState,
  mayManageConnections,
  newInstallState,
  readGitHubId,
} from '../domain/connections.js';
import type { ConnectedInstallation, GitHubRepository } from '../domain/connections.js';
import type { SignedIn } from '../domain/person.js';
import type { MyWorkspace } from '../domain/workspace.js';
import type { GitHubApp, InstallationStore, InstallStateSigner, MembershipStore } from './ports.js';

/**
 * The session's active workspace as the person is in it now, read from the store: `no-workspace`
 * when the session names none, `not-a-member` when it names one the person is not in, or one
 * that is not there.
 */
async function activeWorkspace(
  memberships: MembershipStore,
  session: SignedIn,
): Promise<
  | { kind: 'workspace'; workspace: MyWorkspace }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
> {
  if (session.activeWorkspaceId === null) return { kind: 'no-workspace' };
  const workspace = await memberships.workspaceFor({
    workspaceId: session.activeWorkspaceId,
    userId: session.person.id,
  });
  return workspace ? { kind: 'workspace', workspace } : { kind: 'not-a-member' };
}

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

/**
 * What the session's active workspace is connected to, for any of its members, and whether this
 * person may change it (`canManage`). The repositories are asked of GitHub each time rather than
 * kept, so they are never stale; when GitHub cannot answer, or the app is not configured on this
 * server, the installation is still listed, with `unavailable` repositories.
 */
export async function listConnections(
  ports: {
    memberships: MembershipStore;
    installations: InstallationStore;
    github: GitHubApp | null;
  },
  session: SignedIn,
): Promise<
  | {
      kind: 'listed';
      canManage: boolean;
      github: { configured: boolean; installations: GitHubConnection[] };
    }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
> {
  const active = await activeWorkspace(ports.memberships, session);
  if (active.kind !== 'workspace') return active;
  const { workspace } = active;

  const { github } = ports;
  const held = await ports.installations.ofWorkspace(workspace.id);
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
    kind: 'listed',
    canManage: mayManageConnections(workspace.role),
    github: { configured: github !== null, installations },
  };
}

/**
 * Starts connecting the session's active workspace to GitHub: the address that installs
 * Consola's GitHub App, carrying a signed state that only this session can finish with, until
 * `INSTALL_STATE_LIFETIME_SECONDS` after `now` (whole seconds since the epoch). Only an owner or
 * an admin may (`not-allowed` otherwise).
 */
export async function startGitHubInstall(
  ports: { memberships: MembershipStore; github: GitHubApp | null; states: InstallStateSigner },
  session: SignedIn,
  now: number,
): Promise<
  | { kind: 'started'; url: string }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
  | { kind: 'not-allowed' }
  | { kind: 'not-configured' }
> {
  const active = await activeWorkspace(ports.memberships, session);
  if (active.kind !== 'workspace') return active;
  if (!mayManageConnections(active.workspace.role)) return { kind: 'not-allowed' };
  if (!ports.github) return { kind: 'not-configured' };

  const state = ports.states.sign(newInstallState(session, active.workspace.id, now));
  return { kind: 'started', url: ports.github.installUrl(state) };
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
  /** No state, one Consola did not sign, or another session's. */
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
  | { kind: 'not-configured' };

/**
 * Finishes a Connect when GitHub sends the person back, and records the installation for the
 * workspace the Connect was started for. Each check comes before anything that trusts what the
 * redirect says:
 *
 * 1. the state is this session's own, signed by Consola and in time;
 * 2. the person is still an owner or admin of that workspace;
 * 3. GitHub, asked with the redirect's one-time code, lists the installation among those this
 *    person can reach, since the `installation_id` in the address can be forged, and says they
 *    administer its account (`checkInstaller`): reaching it is not enough, since every member
 *    of an organisation reaches its installation;
 * 4. no other workspace holds it.
 */
export async function finishGitHubInstall(
  ports: {
    memberships: MembershipStore;
    installations: InstallationStore;
    github: GitHubApp | null;
    states: InstallStateSigner;
  },
  session: SignedIn,
  returned: InstallReturn,
  now: number,
): Promise<InstallOutcome> {
  const { github } = ports;
  if (!github) return { kind: 'not-configured' };

  const state = returned.state === undefined ? null : ports.states.read(returned.state);
  const checked = checkInstallState(state, session, now);
  if (checked === 'expired') return { kind: 'expired' };
  if (checked !== 'ok' || state === null) return { kind: 'bad-state' };

  if (returned.error !== undefined) return { kind: 'cancelled' };
  if (returned.setupAction === 'request') return { kind: 'requested' };

  const workspace = await ports.memberships.workspaceFor({
    workspaceId: state.workspaceId,
    userId: session.person.id,
  });
  if (!workspace || !mayManageConnections(workspace.role)) return { kind: 'not-allowed' };

  const installationId = readGitHubId(returned.installationId);
  if (installationId === null || !returned.code) return { kind: 'invalid' };

  const asked = await github.installerFacts(returned.code, installationId);
  if (asked.kind !== 'read') return asked;
  const installer = checkInstaller(asked.facts);
  if (!installer.ok) return { kind: installer.reason };
  const { installation } = installer;

  const recorded = await ports.installations.connect({
    installation,
    workspaceId: workspace.id,
    connectedBy: session.person.id,
    at: new Date(now * 1000),
  });
  if (recorded === 'taken') return { kind: 'taken' };
  return { kind: recorded, workspaceId: workspace.id };
}

/**
 * Disconnects a GitHub installation from the session's active workspace: Consola's record goes,
 * and the app stays installed on GitHub until someone uninstalls it there. Only an owner or an
 * admin may (`not-allowed` otherwise). An installation the workspace does not hold, another
 * workspace's included, is `not-found`.
 */
export async function disconnectGitHub(
  ports: { memberships: MembershipStore; installations: InstallationStore },
  session: SignedIn,
  installationId: number,
): Promise<
  | { kind: 'disconnected' }
  | { kind: 'not-found' }
  | { kind: 'not-allowed' }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
> {
  const active = await activeWorkspace(ports.memberships, session);
  if (active.kind !== 'workspace') return active;
  if (!mayManageConnections(active.workspace.role)) return { kind: 'not-allowed' };

  const removed = await ports.installations.disconnect({
    workspaceId: active.workspace.id,
    installationId,
  });
  return removed ? { kind: 'disconnected' } : { kind: 'not-found' };
}

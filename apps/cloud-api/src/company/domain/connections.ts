import type { WorkspaceRole } from '@consola/cloud-contract';
import type { SignedIn } from './person.js';

/**
 * Who may connect a workspace to another service, and disconnect it: its owners and admins.
 * Every member sees what is connected.
 */
export function mayManageConnections(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** The GitHub account, an organisation or a person, that Consola's GitHub App is installed on. */
export type GitHubAccount = { id: number; login: string; type: 'Organization' | 'User' };

/**
 * One installation of Consola's GitHub App, as GitHub describes it: its id, the account it is on
 * and whether it covers all of that account's repositories or only those chosen.
 */
export type GitHubInstallation = {
  id: number;
  account: GitHubAccount;
  repositorySelection: 'all' | 'selected';
};

/** An installation a workspace holds, as recorded when it was connected. */
export type ConnectedInstallation = {
  id: number;
  account: GitHubAccount;
  connectedAt: Date;
};

/**
 * A GitHub id (an installation's, say) as an address has it: digits only, with no leading zero,
 * read as a safe integer. Anything else is null.
 */
export function readGitHubId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Where on GitHub the installation's settings are: which repositories it covers, and where it is
 * uninstalled. Disconnecting in Consola leaves the app installed, so this is where to go next.
 */
export function installationSettingsUrl(installation: {
  id: number;
  account: GitHubAccount;
}): string {
  const { id, account } = installation;
  return account.type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/** A repository an installation covers. */
export type GitHubRepository = { id: number; fullName: string; private: boolean; url: string };

/**
 * What GitHub says of the person who came back from a Connect, about the one installation the
 * redirect names. GitHub lists an installation for anyone who can reach one of its
 * repositories, an organisation's members included, so reaching it is not enough: the person
 * must administer the account it is on.
 */
export type InstallerFacts = {
  /** The installation, when GitHub lists it among those the person can reach; else null. */
  installation: GitHubInstallation | null;
  /** The person's own GitHub account. */
  gitHubUserId: number;
  /**
   * For an organisation's installation, the person's active membership of that organisation
   * (`admin` being an owner); null when they have none, or it is still pending.
   */
  organizationRole: 'admin' | 'member' | null;
};

/**
 * Whether the person may connect the installation: GitHub must list it for them
 * (`not-installer` otherwise), and they must administer its account, owning the organisation or
 * being the person it is on (`not-account-admin` otherwise). So a member of a company's GitHub
 * organisation cannot claim its installation for a workspace of their own.
 */
export function checkInstaller(
  facts: InstallerFacts,
):
  | { ok: true; installation: GitHubInstallation }
  | { ok: false; reason: 'not-installer' | 'not-account-admin' } {
  const { installation } = facts;
  if (installation === null) return { ok: false, reason: 'not-installer' };
  const administers =
    installation.account.type === 'User'
      ? installation.account.id === facts.gitHubUserId
      : facts.organizationRole === 'admin';
  return administers ? { ok: true, installation } : { ok: false, reason: 'not-account-admin' };
}

/** How long a Connect started in Consola may take to come back from GitHub, in seconds. */
export const INSTALL_STATE_LIFETIME_SECONDS = 10 * 60;

/**
 * What Consola sends GitHub as the install link's `state`, signed, and reads back when GitHub
 * sends the person back: the workspace being connected, the session that asked and until when
 * (whole seconds since the epoch).
 */
export type InstallState = {
  workspaceId: string;
  userId: string;
  sessionId: string;
  expiresAt: number;
};

/** The state for a Connect the session starts now, for its active workspace. */
export function newInstallState(session: SignedIn, workspaceId: string, now: number): InstallState {
  return {
    workspaceId,
    userId: session.person.id,
    sessionId: session.sessionId,
    expiresAt: now + INSTALL_STATE_LIFETIME_SECONDS,
  };
}

/**
 * Whether a state GitHub brought back finishes a Connect this session started: one that could
 * not be read is `unreadable`, one past its time `expired`, and one another session started
 * (another person's, or this person's in another browser) `not-this-session`. Only this
 * session's own state lets an installation be recorded, so a link someone else made cannot
 * connect a workspace through you.
 */
export function checkInstallState(
  state: InstallState | null,
  session: SignedIn,
  now: number,
): 'ok' | 'unreadable' | 'expired' | 'not-this-session' {
  if (state === null) return 'unreadable';
  if (state.sessionId !== session.sessionId || state.userId !== session.person.id) {
    return 'not-this-session';
  }
  if (now >= state.expiresAt) return 'expired';
  return 'ok';
}

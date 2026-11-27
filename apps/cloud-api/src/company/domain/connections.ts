import type { WorkspaceRole } from '../../shared/workspaceRole.js';

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
 * sends the person back: the workspace being connected, the person and the session that asked,
 * and until when (whole seconds since the epoch).
 */
export type InstallState = {
  workspaceId: string;
  personId: string;
  sessionId: string;
  expiresAt: number;
};

/** Who asks: a person, by their id, in one of their sessions, by its id. */
export type AskingSession = { personId: string; sessionId: string };

/** The state for a Connect the session starts now, for the workspace it has active. */
export function newInstallState(
  asking: AskingSession,
  workspaceId: string,
  now: number,
): InstallState {
  return {
    workspaceId,
    personId: asking.personId,
    sessionId: asking.sessionId,
    expiresAt: now + INSTALL_STATE_LIFETIME_SECONDS,
  };
}

/** What a signed state or choice says of the session it is for, and until when. */
type ForASession = { personId: string; sessionId: string; expiresAt: number };

/** Whether something signed for a session is this session's own, and still in time. */
function checkForSession(
  signed: ForASession | null,
  asking: AskingSession,
  now: number,
): 'ok' | 'unreadable' | 'expired' | 'not-this-session' {
  if (signed === null) return 'unreadable';
  if (signed.sessionId !== asking.sessionId || signed.personId !== asking.personId) {
    return 'not-this-session';
  }
  if (now >= signed.expiresAt) return 'expired';
  return 'ok';
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
  asking: AskingSession,
  now: number,
): 'ok' | 'unreadable' | 'expired' | 'not-this-session' {
  return checkForSession(state, asking, now);
}

/**
 * The installations the person administers, of those GitHub lists for them once they signed in:
 * each `checkInstaller` lets them connect. Reaching one is not enough, as for a fresh install:
 * every member of an organisation reaches its installation.
 */
export function administeredInstallations(facts: readonly InstallerFacts[]): GitHubInstallation[] {
  return facts.flatMap((each) => {
    const checked = checkInstaller(each);
    return checked.ok ? [checked.installation] : [];
  });
}

/** How long a choice of installation, made once the person signed in, waits for them, in seconds. */
export const INSTALL_CHOICE_LIFETIME_SECONDS = 5 * 60;

/**
 * At most this many installations are offered in one choice, in the order GitHub listed them, so
 * the signed choice fits in an address.
 */
export const MAX_INSTALL_CANDIDATES = 20;

/**
 * An installation a person administers, as a choice names it: its id, its account, and whether
 * another workspace holds it (`heldElsewhere`), which says nothing of which one. A held one is
 * shown, so the person knows why it is not offered, and not offered.
 */
export type InstallCandidate = { id: number; account: GitHubAccount; heldElsewhere: boolean };

/**
 * What Consola signs when a person who signed in to GitHub administers installations of the app
 * that this workspace does not hold, and reads back when they choose one: the workspace being
 * connected, the person and the session that asked, until when (whole seconds since the epoch),
 * and the installations, those another workspace holds marked so. Never a GitHub token: the
 * person's is revoked before the choice is signed, and never another workspace's id.
 */
export type InstallChoice = ForASession & {
  workspaceId: string;
  candidates: InstallCandidate[];
};

/**
 * The choice for the session's Connect into `workspaceId`, of `installations`, those no workspace
 * holds first, each in the order given, and at most `MAX_INSTALL_CANDIDATES` of them, so a cut
 * drops a held one before a free one; for `INSTALL_CHOICE_LIFETIME_SECONDS` from `now`.
 */
export function newInstallChoice(
  asking: AskingSession,
  workspaceId: string,
  installations: readonly InstallCandidate[],
  now: number,
): InstallChoice {
  const free = installations.filter((each) => !each.heldElsewhere);
  const held = installations.filter((each) => each.heldElsewhere);
  return {
    workspaceId,
    personId: asking.personId,
    sessionId: asking.sessionId,
    expiresAt: now + INSTALL_CHOICE_LIFETIME_SECONDS,
    candidates: [...free, ...held]
      .slice(0, MAX_INSTALL_CANDIDATES)
      .map(({ id, account, heldElsewhere }) => ({ id, account: { ...account }, heldElsewhere })),
  };
}

/**
 * Where a Connect back from signing in goes, by the installations the person administers that
 * this workspace does not hold: with none, on to install the app (`install`); with one no
 * workspace holds, to choose (`choose`); with every one held by another workspace, to say so
 * (`taken-elsewhere`), which installing the app on another account answers.
 */
export function choiceOutcome(
  candidates: readonly InstallCandidate[],
): 'install' | 'choose' | 'taken-elsewhere' {
  if (candidates.length === 0) return 'install';
  return candidates.some((each) => !each.heldElsewhere) ? 'choose' : 'taken-elsewhere';
}

/**
 * Whether a choice the page sends back is one this session may make now, in the workspace it has
 * active: one that could not be read is `unreadable`, another session's (another person's, or
 * this person's in another browser) `not-this-session`, one past its time `expired`, and one made
 * for another workspace than the session has active now `other-workspace`.
 */
export function checkInstallChoice(
  choice: InstallChoice | null,
  asking: AskingSession & { workspaceId: string },
  now: number,
): 'ok' | 'unreadable' | 'expired' | 'not-this-session' | 'other-workspace' {
  const checked = checkForSession(choice, asking, now);
  if (checked !== 'ok') return checked;
  return choice?.workspaceId === asking.workspaceId ? 'ok' : 'other-workspace';
}

/** The candidate of `choice` with this installation id, or null when it offers none. */
export function candidateOf(
  choice: Pick<InstallChoice, 'candidates'>,
  installationId: number,
): InstallCandidate | null {
  return choice.candidates.find((each) => each.id === installationId) ?? null;
}

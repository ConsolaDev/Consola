import type { components } from './apiContract';

/*
 * What a workspace is connected to, as `cloud-global` answers `GET /api/connections` (its
 * `AGENTS.md`, "Connections"). The server is the authority on every rule: who may connect, which
 * installation a workspace may hold. The page only shows what it answers.
 */

type Schemas = components['schemas'];

/** The GitHub account, an organisation or a person, that Consola's GitHub App is installed on. */
export type GitHubAccount = Schemas['GitHubAccount'];

/** A repository an installation covers. */
export type GitHubRepository = Schemas['GitHubRepository'];

/**
 * What GitHub says an installation covers now, or why it could not say: `gone` when GitHub no
 * longer has the installation (uninstalled there, or suspended), `unavailable` when it did not say.
 */
export type RepositoriesAnswer = Schemas['GitHubRepositories'];

/** An installation the workspace holds; `connectedAt` is an ISO 8601 time. */
export type GitHubConnection = Schemas['GitHubConnection'];

/** What the workspace is connected to, and whether this person may change it. */
export type Connections = Schemas['Connections'];

export type ConnectionsState =
  | { kind: 'loaded'; connections: Connections }
  | { kind: 'signed-out' }
  | { kind: 'no-workspace' }
  | { kind: 'unavailable' };

/** The answer to starting a Connect: the address on GitHub to send the person to. */
export type ConnectAnswer =
  | { kind: 'started'; url: string }
  | { kind: 'not-allowed' }
  | { kind: 'not-configured' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

export type DisconnectAnswer =
  | { kind: 'disconnected' }
  | { kind: 'not-found' }
  | { kind: 'not-allowed' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/**
 * How a Connect ended, as `cloud-global`'s callback names it in `?github=` when it sends the
 * person back to the Connections section.
 */
export const GITHUB_RESULTS = [
  'connected',
  'already_connected',
  'requested',
  'cancelled',
  'bad_state',
  'expired',
  'not_allowed',
  'code_refused',
  'not_installer',
  'not_account_admin',
  'taken',
  'invalid',
  'unavailable',
  'not_configured',
  'signed_out',
] as const;

export type GitHubResult = (typeof GITHUB_RESULTS)[number];

/** The result `?github=` names, `unknown` for one this page does not know, null for none. */
export function readGitHubResult(value: string | null): GitHubResult | 'unknown' | null {
  if (value === null) return null;
  return (GITHUB_RESULTS as readonly string[]).includes(value)
    ? (value as GitHubResult)
    : 'unknown';
}

/** Whether a Connect's result is good news. */
export function isSuccess(result: GitHubResult | 'unknown'): boolean {
  return result === 'connected' || result === 'already_connected';
}

/** Another service, listed beside GitHub, that a workspace cannot connect yet. */
export type LaterService = { id: string; name: string; purpose: string };

/** The services that come after GitHub (after the POC: Slack and Linear first). */
export const LATER_SERVICES: readonly LaterService[] = [
  {
    id: 'slack',
    name: 'Slack',
    purpose: 'Post a run’s results to a channel, and start one from a message.',
  },
  {
    id: 'linear',
    name: 'Linear',
    purpose: 'Start work from an issue, and keep its status in step.',
  },
  { id: 'jira', name: 'Jira', purpose: 'Start work from a ticket, and move it as the work moves.' },
];

/** How many of an installation's repositories its card names before "and N more". */
export const REPOSITORIES_SHOWN = 8;

/** The repositories a card names, in name order, and how many more there are. */
export function shownRepositories(repositories: readonly GitHubRepository[]): {
  shown: GitHubRepository[];
  more: number;
} {
  const sorted = [...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName));
  return {
    shown: sorted.slice(0, REPOSITORIES_SHOWN),
    more: Math.max(0, sorted.length - REPOSITORIES_SHOWN),
  };
}

/**
 * How a card names a repository: without its owner when that is the installation's own account,
 * which the card already names, and in full otherwise.
 */
export function repositoryLabel(repository: GitHubRepository, account: GitHubAccount): string {
  const prefix = `${account.login}/`;
  return repository.fullName.toLowerCase().startsWith(prefix.toLowerCase())
    ? repository.fullName.slice(prefix.length)
    : repository.fullName;
}

/** How the page names an installation's account: an organisation, or a personal account. */
export function accountKind(account: GitHubAccount): string {
  return account.type === 'Organization' ? 'Organization' : 'Personal account';
}

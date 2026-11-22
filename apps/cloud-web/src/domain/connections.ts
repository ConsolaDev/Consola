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
 * person back to Settings' Connections page.
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

/**
 * GitHub's picture of an account, by its id, at `size` pixels: the address GitHub serves every
 * account's avatar from. The page only shows it; an account with none, or a picture that does not
 * load, falls back to a plain icon.
 */
export function avatarUrl(account: GitHubAccount, size: number): string {
  return `https://avatars.githubusercontent.com/u/${account.id}?s=${size}&v=4`;
}

/** How recent an installation must be to count as the one a Connect just added. */
export const JUST_CONNECTED_MS = 10 * 60 * 1000;

/**
 * The installation a Connect that GitHub just sent back as `connected` added: the newest one, as
 * long as it was connected in the last few minutes. Null when none is that recent, so an older
 * installation is never marked new.
 */
export function justConnectedId(
  installations: readonly GitHubConnection[],
  now: number,
): number | null {
  let newest: { id: number; at: number } | null = null;
  for (const installation of installations) {
    const at = Date.parse(installation.connectedAt);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest.at) newest = { id: installation.id, at };
  }
  if (newest === null) return null;
  return now - newest.at <= JUST_CONNECTED_MS ? newest.id : null;
}

/**
 * When an installation was connected, as the card says it: today, a few days ago, or on a date.
 * Days are counted in calendar days where the person is. Null for a time that cannot be read.
 */
export type ConnectedWhen =
  | { kind: 'today' }
  | { kind: 'days-ago'; days: number }
  | { kind: 'on'; date: Date };

/** How many calendar days back an installation still reads as "N days ago". */
export const DAYS_AGO_SHOWN = 6;

export function whenConnected(connectedAt: string, now: Date): ConnectedWhen | null {
  const date = new Date(connectedAt);
  if (Number.isNaN(date.getTime())) return null;
  const startOf = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate());
  // Rounded, so a day that is 23 or 25 hours long (a clock change) still counts as one.
  const days = Math.round((startOf(now).getTime() - startOf(date).getTime()) / 86_400_000);
  if (days <= 0) return { kind: 'today' };
  if (days <= DAYS_AGO_SHOWN) return { kind: 'days-ago', days };
  return { kind: 'on', date };
}

/** How the page names an installation's account: an organisation, or a personal account. */
export function accountKind(account: GitHubAccount): string {
  return account.type === 'Organization' ? 'Organization' : 'Personal account';
}

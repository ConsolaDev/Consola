import { whenConnected } from './connections';
import type {
  ChoiceRefusal,
  ChoiceState,
  ChooseAnswer,
  ConnectAnswer,
  DisconnectAnswer,
  GitHubResult,
} from './connections';

const ON_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const AT_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
// English like every other sentence on the page, so "3 days ago" never reads in another language.
const DAYS_AGO = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * When an installation was connected, as its card says it: "connected today", "connected
 * yesterday", "connected 3 days ago", then "connected Nov 2, 2026". Null for a time that cannot
 * be read, which the card leaves out.
 */
export function connectedSentence(connectedAt: string, now: Date): string | null {
  const when = whenConnected(connectedAt, now);
  if (when === null) return null;
  switch (when.kind) {
    case 'today':
      return 'connected today';
    case 'days-ago':
      return `connected ${DAYS_AGO.format(-when.days, 'day')}`;
    case 'on':
      return `connected ${ON_DATE.format(when.date)}`;
  }
}

/** The exact time an installation was connected, for the card's tooltip. Null if unreadable. */
export function connectedAtLong(connectedAt: string): string | null {
  const date = new Date(connectedAt);
  return Number.isNaN(date.getTime()) ? null : `Connected ${AT_TIME.format(date)}`;
}

/** What an installation that covers no repositories says. */
export const NO_REPOSITORIES = 'No repositories yet. Choose them on GitHub.';

const NOT_ANSWERING = 'Consola Cloud’s service isn’t answering. Try again in a moment.';
const ONLY_MANAGERS = 'Only this workspace’s owners and admins can change its connections.';
const CONNECT_AGAIN = 'Connect again from here.';

/** What the page says when GitHub cannot be connected on this server at all. */
export const GITHUB_NOT_CONFIGURED =
  'GitHub isn’t set up on this server yet. Whoever runs it adds the GitHub App’s settings.';

/** What GitHub is for, on its card. */
export const GITHUB_PURPOSE =
  'Pull requests, pushes and repository files, for automations and factories kept in a repository.';

/** What the services that come later say, over their cards. */
export const LATER_SERVICES_HINT =
  'These can’t be connected yet. Each will connect here, the way GitHub does.';

/** How many accounts a service has connected: "1 account", "3 accounts". */
export function accountCount(count: number): string {
  return count === 1 ? '1 account' : `${count} accounts`;
}

/** How many repositories an installation covers: "1 repository", "12 repositories". */
export function repositoryCount(count: number): string {
  return count === 1 ? '1 repository' : `${count} repositories`;
}

/** What the GitHub card says before anything is connected, to someone who may connect it. */
export const GITHUB_CONNECT_HINT =
  'Connecting signs you in to GitHub, then connects an account or organization you own: one that has Consola’s GitHub App already, or one you install it on.';

/** The heading over the accounts a person who signed in to GitHub may choose from. */
export const GITHUB_CHOICE_LABEL = 'Choose an account';

/** What the choice says over its accounts. */
export const GITHUB_CHOICE_HINT =
  'Consola’s GitHub App is already installed on these accounts, which you own. Connect the one this workspace works with.';

/** The last row of the choice, which installs the app on an account it is not on yet. */
export const INSTALL_ELSEWHERE = 'Install on another account';

/** What a candidate's button says. */
export function connectAccountLabel(login: string): string {
  return `Connect ${login}`;
}

const CHOICE_FOR_ANOTHER_WORKSPACE =
  'That choice was for another workspace. Connect again from the workspace you want GitHub in.';

/** The sentence for why a choice cannot be shown or made. */
function messageForChoiceRefusal(reason: ChoiceRefusal | 'not-a-candidate' | 'taken'): string {
  switch (reason) {
    case 'bad-choice':
      return `That choice was made in another session. ${CONNECT_AGAIN}`;
    case 'expired':
      return `That choice took too long. ${CONNECT_AGAIN}`;
    case 'other-workspace':
      return CHOICE_FOR_ANOTHER_WORKSPACE;
    case 'not-allowed':
      return ONLY_MANAGERS;
    case 'not-a-candidate':
      return `GitHub didn’t offer that account just now. ${CONNECT_AGAIN}`;
    case 'taken':
      return 'Another Consola workspace connected that account a moment ago.';
  }
}

/** The sentence for a choice the page could not show, or the server did not connect. */
export function messageForChoiceFailure(
  answer:
    | Exclude<ChoiceState, { kind: 'loaded' }>
    | Exclude<ChooseAnswer, { kind: 'connected' | 'already-connected' }>,
): string {
  switch (answer.kind) {
    case 'refused':
      return messageForChoiceRefusal(answer.reason);
    case 'switched':
      return CHOICE_FOR_ANOTHER_WORKSPACE;
    case 'signed-out':
      return 'Your session ended. Sign in, then connect again.';
    case 'unavailable':
      return NOT_ANSWERING;
  }
}

/** What the GitHub card says before anything is connected, to a member who may not. */
export const GITHUB_ASK_HINT = 'Ask an owner or admin of this workspace to connect GitHub.';

/** What the page says when the workspace's connections could not be loaded. */
export const CONNECTIONS_UNAVAILABLE = 'The connections couldn’t be loaded. Try again in a moment.';

/** What Disconnect asks before it removes the record. */
export const DISCONNECT_QUESTION =
  'Consola stops using this installation. The app stays installed on GitHub until you uninstall it there.';

/** What an installation GitHub no longer has says. */
export const INSTALLATION_GONE =
  'GitHub no longer has this installation: it was uninstalled or suspended there. Disconnect it here.';

/** What an installation says when GitHub did not list its repositories. */
export const REPOSITORIES_UNAVAILABLE = 'GitHub didn’t list the repositories just now.';

/** The sentence for how a Connect that GitHub sent back ended. */
export function messageForGitHubResult(result: GitHubResult | 'unknown'): string {
  switch (result) {
    case 'connected':
      return 'GitHub is connected.';
    case 'already_connected':
      return 'GitHub was already connected. Its account is up to date.';
    case 'requested':
      return 'GitHub sent your request to the organization’s owners. Once one of them installs the app, connect again.';
    case 'cancelled':
      return 'GitHub wasn’t connected: the authorization was cancelled.';
    case 'bad_state':
      return `That connection was started in another session. ${CONNECT_AGAIN}`;
    case 'expired':
    case 'code_refused':
      return `That connection took too long, or was already used. ${CONNECT_AGAIN}`;
    case 'not_allowed':
      return ONLY_MANAGERS;
    case 'not_installer':
      return 'GitHub doesn’t list that installation for your account. Connect again and choose the account on GitHub.';
    case 'not_account_admin':
      return 'Only an owner of the GitHub organization can connect it. Ask one of them to connect it from this page.';
    case 'taken':
      return 'Another Consola workspace has already connected that GitHub account.';
    case 'invalid':
      return `GitHub sent back something Consola couldn’t read. ${CONNECT_AGAIN}`;
    case 'unavailable':
      return 'GitHub isn’t answering. Try again in a moment.';
    case 'not_configured':
      return GITHUB_NOT_CONFIGURED;
    case 'signed_out':
      return 'Your session ended before GitHub sent you back. Sign in, then connect again.';
    // A choice the address did not carry (`readGitHubReturn`): nothing to choose from.
    case 'choose':
    case 'unknown':
      return `GitHub didn’t finish connecting. ${CONNECT_AGAIN}`;
  }
}

/** The sentence for a Connect the server would not start. */
export function messageForConnectFailure(
  answer: Extract<ConnectAnswer, { kind: 'not-allowed' | 'not-configured' | 'unavailable' }>,
): string {
  switch (answer.kind) {
    case 'not-allowed':
      return ONLY_MANAGERS;
    case 'not-configured':
      return GITHUB_NOT_CONFIGURED;
    case 'unavailable':
      return NOT_ANSWERING;
  }
}

/** The sentence for a Disconnect the server did not do. */
export function messageForDisconnectFailure(
  answer: Extract<DisconnectAnswer, { kind: 'not-allowed' | 'unavailable' }>,
): string {
  return answer.kind === 'not-allowed' ? ONLY_MANAGERS : NOT_ANSWERING;
}

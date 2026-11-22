import type { ConnectAnswer, DisconnectAnswer, GitHubResult } from './connections';

const NOT_ANSWERING = 'Consola Cloud’s service isn’t answering. Try again in a moment.';
const ONLY_MANAGERS = 'Only this workspace’s owners and admins can change its connections.';
const CONNECT_AGAIN = 'Connect again from here.';

/** What the page says when GitHub cannot be connected on this server at all. */
export const GITHUB_NOT_CONFIGURED =
  'GitHub isn’t set up on this server yet. Whoever runs it adds the GitHub App’s settings.';

/** What the GitHub card says before anything is connected, to someone who may connect it. */
export const GITHUB_CONNECT_HINT =
  'Connecting installs Consola’s GitHub App on an account or organization you own, for the repositories you choose there.';

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

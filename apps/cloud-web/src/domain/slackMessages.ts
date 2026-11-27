import { whenConnected } from './connections';
import { FIELD_OF_PROBLEM, slackTeamLabel } from './slack';
import type {
  ConfirmLinkAnswer,
  GoneWhy,
  SlackApp,
  SlackAppState,
  SlackCredentialsAnswer,
  SlackCredentialsField,
  SlackCredentialsProblem,
  SlackDisconnectAnswer,
  SlackInstallAnswer,
  SlackLinkRequest,
  SlackResult,
  SlackStepId,
  UnlinkAnswer,
} from './slack';

/*
 * What the pages say of Slack: a factory's Slack app in its settings, the one-time link page,
 * and Slack on Settings › Connections. Plain, short sentences, as the other pages say theirs.
 */

const NOT_ANSWERING = 'Consola Cloud’s service isn’t answering. Try again in a moment.';
const ONLY_MANAGERS = 'Only this workspace’s owners and admins can set up a factory’s Slack app.';
const FACTORY_GONE = 'This factory is gone, or now belongs to a team you’re not in.';

/** What Slack is for, on a factory's settings and on Connections. */
export const SLACK_PURPOSE =
  'Each factory has a Slack app of its own. Mention its bot in a channel, or message it, to send the factory a request.';

/** What the page says when Slack cannot be set up on this server at all. */
export const SLACK_NOT_CONFIGURED =
  'Slack isn’t set up on this server yet. Whoever runs it adds the key Consola keeps Slack’s secrets with.';

/** What a member who may not set the app up reads while there is none. */
export const SLACK_ASK_HINT = 'Ask an owner or admin of this workspace to set up its Slack app.';

/** What the section says when the app could not be read. */
export const SLACK_APP_UNAVAILABLE = 'The Slack app couldn’t be loaded. Try again in a moment.';

/** A state as its chip says it. */
export const SLACK_STATE_WORDS: Record<SlackAppState, string> = {
  not_set_up: 'Not set up',
  awaiting_install: 'Waiting for Add to Slack',
  installed: 'Installed',
  needs_reinstall: 'Needs reinstalling',
};

/** Each step's title, numbered by the list that shows it. */
export const SLACK_STEP_TITLES: Record<SlackStepId, string> = {
  create: 'Create the app in Slack',
  credentials: 'Paste the app’s credentials',
  install: 'Add to Slack',
};

/** What creating the app asks, under its title. `handle` is the bot's, without its `@`. */
export function createStepHint(handle: string): string {
  return `Slack opens with the app’s manifest filled in. Pick your Slack workspace, then Create. Its bot is @${handle}. Your Slack workspace may need an admin to approve the app.`;
}

/** Where the credentials are, under their step's title. */
export const CREDENTIALS_HINT =
  'In the app’s Basic Information page in Slack, under App Credentials.';

/** What Add to Slack does, under its step's title. */
export const INSTALL_HINT =
  'Slack asks you to allow the app in your workspace, then sends you back here.';

/** What Add to Slack says before the credentials are saved. */
export const INSTALL_WAITS = 'Paste the credentials first.';

/** How each credential's field is labelled. */
export const CREDENTIAL_LABELS: Record<SlackCredentialsField, string> = {
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  signingSecret: 'Signing Secret',
};

const FOR_PROBLEM: Record<SlackCredentialsProblem, string> = {
  client_id_missing: 'Paste the Client ID.',
  client_id_invalid:
    'A Client ID is two numbers joined by a dot, like 1234567890.1234567890. The App ID is another value.',
  client_secret_missing: 'Paste the Client Secret.',
  client_secret_invalid: 'Paste the Client Secret alone, with no spaces in it.',
  signing_secret_missing: 'Paste the Signing Secret.',
  signing_secret_invalid: 'Paste the Signing Secret alone, with no spaces in it.',
};

/** What the form says under each field, and for the form as a whole. */
export type CredentialsMessages = Partial<Record<SlackCredentialsField | 'form', string>>;

/** The sentences for what the page's check, or the API, found wrong with the credentials. */
export function messagesForCredentialsProblems(
  problems: readonly SlackCredentialsProblem[],
): CredentialsMessages {
  const messages: CredentialsMessages = {};
  for (const problem of problems) messages[FIELD_OF_PROBLEM[problem]] ??= FOR_PROBLEM[problem];
  return messages;
}

/** The sentences for a save of the credentials that did not go through. */
export function messagesForCredentialsAnswer(
  answer: Exclude<SlackCredentialsAnswer, { kind: 'saved' }>,
): CredentialsMessages {
  switch (answer.kind) {
    case 'invalid':
      return answer.problems.length > 0
        ? messagesForCredentialsProblems(answer.problems)
        : { form: 'Slack’s credentials didn’t look right. Copy them again from App Credentials.' };
    case 'not-allowed':
      return { form: ONLY_MANAGERS };
    case 'not-found':
      return { form: FACTORY_GONE };
    case 'not-configured':
      return { form: SLACK_NOT_CONFIGURED };
    case 'switched':
    case 'signed-out':
    case 'unavailable':
      return { form: messageForSlackRefusal(answer.kind) };
  }
}

/** The sentence for an Add to Slack the server would not start. */
export function messageForInstallFailure(
  answer: Exclude<SlackInstallAnswer, { kind: 'started' }>,
): string {
  switch (answer.kind) {
    case 'no-credentials':
      return 'The app’s credentials aren’t saved. Paste them first.';
    case 'not-allowed':
      return ONLY_MANAGERS;
    case 'not-found':
      return FACTORY_GONE;
    case 'not-configured':
      return SLACK_NOT_CONFIGURED;
    default:
      return messageForSlackRefusal(answer.kind);
  }
}

/** The sentence for a Disconnect the server did not do. */
export function messageForDisconnectFailure(
  answer: Exclude<SlackDisconnectAnswer, { kind: 'disconnected' }>,
): string {
  switch (answer.kind) {
    case 'not-allowed':
      return ONLY_MANAGERS;
    case 'not-found':
      return 'This factory has no Slack app any more.';
    case 'not-configured':
      return SLACK_NOT_CONFIGURED;
    default:
      return messageForSlackRefusal(answer.kind);
  }
}

/** The caller's refusals, as Slack's controls say them. */
function messageForSlackRefusal(kind: 'switched' | 'signed-out' | 'unavailable'): string {
  switch (kind) {
    case 'switched':
      return 'Your session has another workspace open now, perhaps from another tab. Reload to see it.';
    case 'signed-out':
      return 'You’ve been signed out. Reload to sign in again.';
    case 'unavailable':
      return NOT_ANSWERING;
  }
}

/** What an installed app says: where it is. */
export function installedWhere(app: Pick<SlackApp, 'handle' | 'team'>): string {
  return app.team ? `@${app.handle} in ${app.team.name}` : `@${app.handle}`;
}

/** How the bot is let into a channel, before the command a person copies. */
export const INVITE_HINT = 'Invite it to each channel it should listen in:';

/** What the page says of linking, once the app is installed. */
export const LINKING_HINT =
  'The first time someone mentions it, the bot sends them a link to connect their Slack account to Consola.';

/** What an app whose token Slack no longer accepts says. */
export const NEEDS_REINSTALL =
  'Slack no longer accepts the app’s token: it was revoked, or the app was removed from the Slack workspace. Add it to Slack again.';

/** What Disconnect asks before it forgets the app. */
export const DISCONNECT_QUESTION =
  'Consola revokes the bot’s token and forgets the app’s credentials. The app stays in Slack: delete it there, at the end of its Basic Information page.';

/** The label of the link to the app's page in Slack. */
export const APP_IN_SLACK = 'Open the app in Slack';

/** The sentence for how "Add to Slack" ended, as the callback named it. */
export function messageForSlackResult(result: SlackResult | 'unknown'): string {
  const again = 'Try Add to Slack again.';
  switch (result) {
    case 'installed':
      return 'The app is in Slack. Invite its bot to the channels it should listen in.';
    case 'cancelled':
      return 'The app wasn’t added: Slack’s authorization was cancelled.';
    case 'bad_state':
    case 'expired':
    case 'code_refused':
      return `That took too long, or was already used. ${again}`;
    case 'not_allowed':
      return ONLY_MANAGERS;
    case 'factory_not_found':
      return FACTORY_GONE;
    case 'credentials_missing':
      return 'The app’s credentials aren’t saved any more. Paste them, then add it to Slack.';
    case 'credentials_changed':
      return `The app’s credentials changed while Slack was asking. ${again}`;
    case 'not_a_bot':
      return 'Slack added the app without its bot. Check the app was created from Consola’s manifest, then try again.';
    case 'enterprise_install':
      return 'Slack added the app to a whole Enterprise Grid organization. Add it to one Slack workspace instead.';
    case 'app_taken':
      return 'That Slack app is already another factory’s. Create a new app for this factory.';
    case 'wrong_app':
      return 'Slack added a different app than the one whose credentials are saved here. Check the credentials, then try again.';
    case 'invalid':
      return `Slack sent back something Consola couldn’t read. ${again}`;
    case 'unavailable':
      return 'Slack isn’t answering. Try again in a moment.';
    case 'not_configured':
      return SLACK_NOT_CONFIGURED;
    case 'unknown':
      return `Slack didn’t finish adding the app. ${again}`;
  }
}

/** Whether "Add to Slack" ended well. */
export function isSlackSuccess(result: SlackResult | 'unknown'): boolean {
  return result === 'installed';
}

// ---- The link page ----

/**
 * The link page's question: "Link Slack account U012AB3CD in Sprocket to you in Sprocket?". The
 * Slack account is named by its id, as Consola keeps no Slack name.
 */
export function linkQuestion(request: SlackLinkRequest, workspaceName: string): string {
  const team = slackTeamLabel({ id: request.slackTeamId, name: request.slackTeamName });
  return `Link Slack account ${request.slackUserId} in ${team} to you in ${workspaceName}?`;
}

/** What linking does, under the question. */
export const LINK_EXPLAINED =
  'Then the factories you can see in this workspace take your requests from Slack. You can unlink it in Settings › Connections.';

/** What a link that no longer works says: why, and how to get a new one. */
export function linkGoneWords(why: GoneWhy, factoryName: string | null): string {
  const first =
    why === 'used'
      ? 'This link was already used.'
      : why === 'expired'
        ? 'This link has expired.'
        : 'This link doesn’t work.';
  const bot = factoryName ? `${factoryName}’s bot` : 'the factory’s bot';
  return `${first} Mention ${bot} in Slack again for a new one.`;
}

/** What the page says once the account is linked. */
export const LINKED_WORDS = 'Your Slack account is linked. Send your request again in Slack.';

/** What a link for a workspace the person is not in says. */
export const NOT_A_MEMBER_WORDS =
  'This link is for a workspace you’re not a member of. Ask one of its owners or admins to invite you, then open the link again.';

/** What a link for another of the person's workspaces says, over Switch. */
export function otherWorkspaceWords(target: string | null, active: string): string {
  const name = target ?? 'another of your workspaces';
  return `This link is for ${name}, and you have ${active} open. Switch to link your account there.`;
}

/** What the page says to someone signed in with no workspace open. */
export const NO_WORKSPACE_WORDS = 'Open the workspace this link is for, then open the link again.';

/** What the sign-in card says on a link page. */
export const LINK_SIGN_IN_HINT =
  'Sign in to link your Slack account. You’ll come back to this link.';

/** The sentence for a confirm the server did not do. */
export function messageForConfirmFailure(
  answer: Exclude<ConfirmLinkAnswer, { kind: 'linked' }>,
  factoryName: string | null,
): string {
  switch (answer.kind) {
    case 'gone':
      return linkGoneWords(answer.why, factoryName);
    case 'other-workspace':
    case 'switched':
      return 'Your session has another workspace open now, perhaps from another tab. Reload this link.';
    case 'taken':
      return 'That Slack account is already linked to someone else in this workspace.';
    case 'not-configured':
      return SLACK_NOT_CONFIGURED;
    case 'signed-out':
      return 'You’ve been signed out. Reload to sign in again.';
    case 'unavailable':
      return NOT_ANSWERING;
  }
}

// ---- Settings › Connections ----

/** What Slack says on Connections while no factory has an app, to someone who may set one up. */
export const SLACK_SET_UP_HINT = 'Set up a factory’s app in that factory’s Settings.';

/** How many factories have an app: "1 factory", "3 factories". */
export function factoryCount(count: number): string {
  return count === 1 ? '1 factory' : `${count} factories`;
}

const ON_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
// English like every other sentence on the page, so "3 days ago" never reads in another language.
const DAYS_AGO = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * When a Slack account was linked, as its row says it: "linked today", "linked yesterday",
 * "linked 3 days ago", then "linked Nov 2, 2026". Null for a time that cannot be read.
 */
export function linkedSentence(linkedAt: string, now: Date): string | null {
  const when = whenConnected(linkedAt, now);
  if (when === null) return null;
  switch (when.kind) {
    case 'today':
      return 'linked today';
    case 'days-ago':
      return `linked ${DAYS_AGO.format(-when.days, 'day')}`;
    case 'on':
      return `linked ${ON_DATE.format(when.date)}`;
  }
}

/** What Slack says on Connections to someone who may set an app up, with no factory yet. */
export const SLACK_NO_FACTORY_HINT =
  'Each factory has a Slack app of its own. Make a factory, then set up its app in its Settings.';

/** The heading of the person's own linked accounts. */
export const YOUR_ACCOUNTS = 'Your Slack accounts';

/** What the list of linked accounts says while it is empty. */
export const NO_LINKED_ACCOUNTS =
  'None linked yet. Mention a factory’s bot in Slack, and it sends you a link.';

/** The sentence for an Unlink that did not go through. */
export function messageForUnlinkFailure(
  answer: Exclude<UnlinkAnswer, { kind: 'unlinked' }>,
): string {
  if (answer.kind === 'not-found') return 'That account isn’t linked any more.';
  if (answer.kind === 'not-configured') return SLACK_NOT_CONFIGURED;
  return messageForSlackRefusal(answer.kind);
}

/** What Slack on Connections says when it could not be read. */
export const SLACK_CONNECTIONS_UNAVAILABLE =
  'Slack’s apps couldn’t be loaded. Try again in a moment.';

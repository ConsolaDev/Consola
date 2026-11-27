import type { Caller } from '../domain/caller.js';
import { mayManageConnections } from '../domain/connections.js';
import type { Factory } from '../domain/factory.js';
import {
  checkSlackCredentials,
  createSlackAppUrl,
  newSlackInstallState,
  SLACK_OAUTH_CALLBACK_PATH,
  slackAppSettingsUrl,
  slackAppState,
  slackAuthorizeUrl,
  slackEventsPath,
  slackHandle,
  slackInstallStateInTime,
  slackManifest,
} from '../domain/slack.js';
import type {
  SlackAppState,
  SlackCredentialProblem,
  SlackManifest,
  StoredSlackApp,
} from '../domain/slack.js';
import { seenFactory } from './factories.js';
import type { Clock, FactoryStore, MembershipReader, TeamStore } from './ports.js';
import type {
  SecretSealer,
  SlackApi,
  SlackAppStore,
  SlackError,
  SlackInstallStateSigner,
} from './slackPorts.js';

/*
 * A factory's Slack app (CON-144): its state, its credentials, "Add to Slack" and Disconnect.
 * Every member who sees the factory sees its app; only owners and admins change it
 * (`mayManageConnections`). A use case answers in the order it checks: the caller's role (a
 * member is refused before anything is read), what was sent, the factory, then what the store
 * finds. No answer holds a secret.
 */

/** What these use cases need. */
export type SlackAppPorts = {
  teams: TeamStore;
  factories: FactoryStore;
  apps: SlackAppStore;
  sealer: SecretSealer;
  states: SlackInstallStateSigner;
  slack: SlackApi;
  membership: MembershipReader;
  clock: Clock;
  /** Hears what failed on Slack's side, by ids alone, one line each. */
  report: (line: string) => void;
};

/** A factory's Slack app as its settings show it, and how to set it up. Never a secret. */
export type SlackAppStatus = {
  canManage: boolean;
  state: SlackAppState;
  handle: string;
  clientId: string | null;
  appId: string | null;
  appSettingsUrl: string | null;
  team: { id: string; name: string } | null;
  installedAt: Date | null;
  setup: { manifest: SlackManifest; createAppUrl: string; requestUrl: string; redirectUrl: string };
};

const NOT_FOUND = { kind: 'not-found' } as const;
const NOT_ALLOWED = { kind: 'not-allowed' } as const;

/** Where Slack sends a person back after "Add to Slack", on Slack's public address. */
export const slackRedirectUri = (slackPublicUrl: string) =>
  `${slackPublicUrl}${SLACK_OAUTH_CALLBACK_PATH}`;

function statusOf(
  caller: Caller,
  factory: Factory,
  app: StoredSlackApp | null,
  slackPublicUrl: string,
): SlackAppStatus {
  const manifest = slackManifest(factory, slackPublicUrl);
  const install = app?.install ?? null;
  return {
    canManage: mayManageConnections(caller.role),
    state: slackAppState(app),
    handle: app?.handle ?? slackHandle(factory.name),
    clientId: app?.clientId ?? null,
    appId: install?.appId ?? null,
    appSettingsUrl: install ? slackAppSettingsUrl(install.appId) : null,
    team: install ? { id: install.teamId, name: install.teamName } : null,
    installedAt: install?.installedAt ?? null,
    setup: {
      manifest,
      createAppUrl: createSlackAppUrl(manifest),
      requestUrl: `${slackPublicUrl}${slackEventsPath(factory.id)}`,
      redirectUrl: slackRedirectUri(slackPublicUrl),
    },
  };
}

/** The factory's Slack app, for anyone who sees the factory. */
export async function getSlackApp(
  ports: Pick<SlackAppPorts, 'teams' | 'factories' | 'apps'>,
  caller: Caller,
  factoryId: string,
  slackPublicUrl: string,
): Promise<{ kind: 'found'; status: SlackAppStatus } | typeof NOT_FOUND> {
  const factory = await seenFactory(ports.teams, ports.factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  const app = await ports.apps.get(caller.workspaceId, factory.id);
  return { kind: 'found', status: statusOf(caller, factory, app, slackPublicUrl) };
}

/** Revokes a bot token, as far as Slack answers. A failure is reported by ids, never thrown. */
async function revokeQuietly(
  ports: Pick<SlackAppPorts, 'sealer' | 'slack' | 'report'>,
  app: StoredSlackApp,
): Promise<void> {
  const sealed = app.sealed.botToken;
  const token = sealed === null ? null : ports.sealer.open(sealed);
  const what = `factory ${app.factoryId} (workspace ${app.workspaceId})`;
  if (token === null) {
    if (sealed !== null) {
      ports.report(`Could not revoke the Slack bot token of ${what}: it does not open.`);
    }
    return;
  }
  const answer = await ports.slack.authRevoke(token);
  if (!answer.ok) {
    ports.report(`Slack did not revoke the bot token of ${what}: ${wordsOf(answer.error)}.`);
  }
}

/** A Slack error in words for a log line: Slack's code, or why it could not be asked. */
export function wordsOf(error: SlackError): string {
  return error.kind === 'refused' ? error.code : error.reason;
}

/**
 * Saves the factory's app's credentials, sealed, and answers its app as it is now. Saved with
 * another client ID than the one it has, its install was another app's: its bot token is revoked
 * as far as Slack answers, and forgotten.
 */
export async function saveSlackCredentials(
  ports: SlackAppPorts,
  caller: Caller,
  factoryId: string,
  input: { clientId?: unknown; clientSecret?: unknown; signingSecret?: unknown },
  slackPublicUrl: string,
): Promise<
  | { kind: 'saved'; status: SlackAppStatus }
  | { kind: 'invalid'; problems: SlackCredentialProblem[] }
  | typeof NOT_FOUND
  | typeof NOT_ALLOWED
> {
  if (!mayManageConnections(caller.role)) return NOT_ALLOWED;
  const credentials = checkSlackCredentials(input);
  if (!credentials.ok) return { kind: 'invalid', problems: credentials.problems };
  const factory = await seenFactory(ports.teams, ports.factories, caller, factoryId);
  if (!factory) return NOT_FOUND;

  const held = await ports.apps.get(caller.workspaceId, factory.id);
  if (held?.install && held.clientId !== credentials.clientId) await revokeQuietly(ports, held);

  const saved = await ports.apps.saveCredentials({
    workspaceId: caller.workspaceId,
    factoryId: factory.id,
    clientId: credentials.clientId,
    clientSecret: ports.sealer.seal(credentials.clientSecret),
    signingSecret: ports.sealer.seal(credentials.signingSecret),
    handle: slackHandle(factory.name),
    configuredBy: caller.personId,
    at: new Date(ports.clock.nowSeconds() * 1000),
  });
  if (saved === 'not-found') return NOT_FOUND;
  const app = await ports.apps.get(caller.workspaceId, factory.id);
  return { kind: 'saved', status: statusOf(caller, factory, app, slackPublicUrl) };
}

/**
 * Starts adding the factory's app to Slack: Slack's authorise page for the app, with a state
 * signed for this person and factory, for `SLACK_INSTALL_STATE_LIFETIME_SECONDS`. The app needs
 * its credentials first (`credentials-missing`).
 */
export async function startSlackInstall(
  ports: Pick<SlackAppPorts, 'teams' | 'factories' | 'apps' | 'states' | 'clock'>,
  caller: Caller,
  factoryId: string,
  slackPublicUrl: string,
): Promise<
  | { kind: 'started'; url: string }
  | { kind: 'credentials-missing' }
  | typeof NOT_FOUND
  | typeof NOT_ALLOWED
> {
  if (!mayManageConnections(caller.role)) return NOT_ALLOWED;
  const factory = await seenFactory(ports.teams, ports.factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  const app = await ports.apps.get(caller.workspaceId, factory.id);
  if (!app) return { kind: 'credentials-missing' };
  const state = ports.states.sign(
    newSlackInstallState(caller, factory.id, ports.clock.nowSeconds()),
  );
  return {
    kind: 'started',
    url: slackAuthorizeUrl({
      clientId: app.clientId,
      redirectUri: slackRedirectUri(slackPublicUrl),
      state,
    }),
  };
}

/** What Slack's redirect back to Consola carries, each as the query string has it. */
export type SlackInstallReturn = { state?: string; code?: string; error?: string };

/** How an "Add to Slack" that Slack sent back ended. A factory is named once the state is read. */
export type SlackInstallOutcome =
  | { kind: 'bad-state' }
  | { factoryId: string; kind: SlackInstallEnd };

export type SlackInstallEnd =
  | 'installed'
  /** The person said no on Slack's page. */
  | 'cancelled'
  | 'expired'
  /** The person who started it is no longer an owner or admin of the workspace. */
  | 'not-allowed'
  | 'factory-not-found'
  /** The app has no credentials now, or they do not open with this server's key. */
  | 'credentials-missing'
  /** The app's client ID changed since the install started. */
  | 'credentials-changed'
  /** Slack refused the code: used already, expired, or not this app's. */
  | 'code-refused'
  /** Slack granted no bot token. */
  | 'not-a-bot'
  /** It was installed on a whole Enterprise Grid org, which release 1 does not take. */
  | 'enterprise-install'
  /** Another factory's app is this Slack app. */
  | 'app-taken'
  /** The factory was installed with another Slack app before. */
  | 'wrong-app'
  | 'invalid'
  | 'unavailable';

/**
 * Finishes an "Add to Slack" when Slack sends the browser back. It needs no session: the signed
 * state names the workspace, the factory and the person, and each check comes before anything
 * trusts the redirect:
 *
 * 1. the state is one Consola signed (`bad-state` otherwise), and in time;
 * 2. the person is still an owner or admin of that workspace, read from `member` now;
 * 3. the factory is still there, and its app has credentials that open;
 * 4. Slack exchanges the code (`oauth.v2.access`) with that app's own client ID and secret, so
 *    the token is that app's, and grants a bot token for one Slack workspace;
 * 5. the factory was never installed with another Slack app, and no other factory holds this one.
 *
 * Then the bot token is sealed and kept, with the Slack workspace, the bot and who added it. The
 * bot's handle is asked of Slack (`auth.test`), as far as it answers. A token not kept is not
 * revoked: Slack hands the same app the same bot token, which another factory, or this one, may
 * already hold.
 */
export async function finishSlackInstall(
  ports: SlackAppPorts,
  returned: SlackInstallReturn,
  slackPublicUrl: string,
): Promise<SlackInstallOutcome> {
  const state = returned.state === undefined ? null : ports.states.read(returned.state);
  if (state === null) return { kind: 'bad-state' };
  const { workspaceId, factoryId, personId } = state;
  const end = (kind: SlackInstallEnd): SlackInstallOutcome => ({ factoryId, kind });
  const now = ports.clock.nowSeconds();
  if (!slackInstallStateInTime(state, now)) return end('expired');
  if (returned.error !== undefined) return end('cancelled');

  const role = await ports.membership.roleOf(personId, workspaceId);
  if (role === null || !mayManageConnections(role)) return end('not-allowed');
  if (!(await ports.factories.get(workspaceId, factoryId))) return end('factory-not-found');
  const app = await ports.apps.get(workspaceId, factoryId);
  const clientSecret = app ? ports.sealer.open(app.sealed.clientSecret) : null;
  if (!app || clientSecret === null) return end('credentials-missing');
  if (!returned.code) return end('invalid');

  const granted = await ports.slack.oauthAccess({
    clientId: app.clientId,
    clientSecret,
    code: returned.code,
    redirectUri: slackRedirectUri(slackPublicUrl),
  });
  if (!granted.ok) {
    ports.report(
      `Slack did not finish adding the app of factory ${factoryId} (workspace ${workspaceId}): ${wordsOf(granted.error)}.`,
    );
    return end(granted.error.kind === 'refused' ? 'code-refused' : 'unavailable');
  }
  const grant = granted.value;
  if (grant.tokenType !== 'bot') return end('not-a-bot');
  if (grant.enterpriseInstall) return end('enterprise-install');
  if (app.install && app.install.appId !== grant.appId) return end('wrong-app');

  const identity = await ports.slack.authTest(grant.botToken);
  const handle = identity.ok && identity.value.user !== '' ? identity.value.user : app.handle;
  const installed = await ports.apps.install({
    workspaceId,
    factoryId,
    clientId: app.clientId,
    install: {
      appId: grant.appId,
      teamId: grant.team.id,
      teamName: grant.team.name,
      botUserId: grant.botUserId,
      installedBy: personId,
      installedAt: new Date(now * 1000),
    },
    botToken: ports.sealer.seal(grant.botToken),
    handle,
  });
  switch (installed) {
    case 'installed':
      return end('installed');
    case 'not-found':
      return end('credentials-missing');
    case 'credentials-changed':
      return end('credentials-changed');
    case 'app-taken':
      return end('app-taken');
  }
}

/**
 * Disconnects the factory's Slack app: forgets everything Consola kept for it, then revokes its
 * bot token as far as Slack answers. The app stays in Slack until someone deletes it there.
 */
export async function disconnectSlack(
  ports: Pick<SlackAppPorts, 'teams' | 'factories' | 'apps' | 'sealer' | 'slack' | 'report'>,
  caller: Caller,
  factoryId: string,
): Promise<
  { kind: 'disconnected' } | { kind: 'not-set-up' } | typeof NOT_FOUND | typeof NOT_ALLOWED
> {
  if (!mayManageConnections(caller.role)) return NOT_ALLOWED;
  const factory = await seenFactory(ports.teams, ports.factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  const forgotten = await ports.apps.forget(caller.workspaceId, factory.id);
  if (!forgotten) return { kind: 'not-set-up' };
  await revokeQuietly(ports, forgotten);
  return { kind: 'disconnected' };
}

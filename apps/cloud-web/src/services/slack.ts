import { isCredentialsProblem, isSlackAddress, isSlackAppState } from '../domain/slack';
import type {
  ConfirmLinkAnswer,
  FactorySlackApp,
  LinkRequestAnswer,
  SlackApp,
  SlackAppAnswer,
  SlackConnectionsAnswer,
  SlackCredentials,
  SlackCredentialsAnswer,
  SlackDisconnectAnswer,
  SlackInstallAnswer,
  SlackLink,
  SlackLinkRequest,
  SlackLinksAnswer,
  UnlinkAnswer,
} from '../domain/slack';
import type { ApiOptions } from './api';
import { codeOf, UNAVAILABLE, workspaceCalls } from './workspaceCalls';

/*
 * Slack (CON-144), from the API: a factory's Slack app (its state, saving its credentials,
 * starting "Add to Slack", disconnecting it), the person's own linked Slack accounts, and the
 * one-time link page's link. Every call names the workspace the page shows, through
 * `workspaceCalls`, and the link page's names the session's active one: the API answers whether
 * the link is for it (`inActiveWorkspace`), and refuses to confirm one that is not.
 *
 * Every call answers in domain types and never throws; anything a call does not expect, an API
 * that does not answer included, is `unavailable`. With Slack off on the server, every route
 * answers 503 `slack_not_configured`, which each call says as `not-configured`. An answer is read
 * defensively, as the contract's types check nothing that arrives.
 */

type Answer = { data?: unknown; error?: unknown; response: Response };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): boolean => value === null || isText(value);

/** Whether a body has the shape of a factory's Slack app, as far as the page reads one. */
export function isSlackApp(value: unknown): value is SlackApp {
  if (!isObject(value)) return false;
  const { team, setup } = value;
  return (
    isSlackAppState(value.state) &&
    typeof value.canManage === 'boolean' &&
    isText(value.handle) &&
    isTextOrNull(value.clientId) &&
    isTextOrNull(value.appId) &&
    isTextOrNull(value.appSettingsUrl) &&
    (team === null || (isObject(team) && isText(team.id) && isText(team.name))) &&
    isTextOrNull(value.installedAt) &&
    isObject(setup) &&
    isObject(setup.manifest) &&
    isText(setup.createAppUrl) &&
    isText(setup.requestUrl) &&
    isText(setup.redirectUrl)
  );
}

function isLink(value: unknown): value is SlackLink {
  return (
    isObject(value) &&
    isText(value.id) &&
    isText(value.slackTeamId) &&
    isTextOrNull(value.slackTeamName) &&
    isText(value.slackUserId) &&
    isText(value.linkedAt)
  );
}

const LINK_STATES: ReadonlySet<unknown> = new Set<SlackLinkRequest['state']>([
  'open',
  'used',
  'expired',
]);

function isLinkRequest(value: unknown): value is SlackLinkRequest {
  if (!isObject(value)) return false;
  const { factory } = value;
  return (
    LINK_STATES.has(value.state) &&
    isText(value.workspaceId) &&
    typeof value.inActiveWorkspace === 'boolean' &&
    isText(value.slackTeamId) &&
    isText(value.slackUserId) &&
    isTextOrNull(value.slackTeamName) &&
    (factory === null || (isObject(factory) && isText(factory.id) && isText(factory.name))) &&
    isText(value.expiresAt)
  );
}

/** Slack off on the server: every Slack route says so the same way. */
function isNotConfigured(answer: Answer): boolean {
  return answer.response.status === 503 && codeOf(answer.error) === 'slack_not_configured';
}

const NOT_CONFIGURED = { kind: 'not-configured' } as const;

/** The answers every change to a factory's app shares, or null for one a call reads itself. */
function sharedAnswer(
  answer: Answer,
): { kind: 'not-allowed' } | { kind: 'not-found' } | { kind: 'not-configured' } | null {
  const { status } = answer.response;
  const code = codeOf(answer.error);
  if (status === 403 && code === 'not_allowed') return { kind: 'not-allowed' };
  if (status === 404 && code === 'factory_not_found') return { kind: 'not-found' };
  if (isNotConfigured(answer)) return NOT_CONFIGURED;
  return null;
}

export type SlackService = {
  /** A factory's Slack app, set up or not, and whether the person may change it. */
  loadApp(workspace: { id: string }, factoryId: string): Promise<SlackAppAnswer>;
  /** Saves the app's credentials, which the API seals; it answers the app as it is then. */
  saveCredentials(
    workspace: { id: string },
    factoryId: string,
    credentials: SlackCredentials,
  ): Promise<SlackCredentialsAnswer>;
  /** Starts "Add to Slack": Slack's authorise page, which the page sends the person to. */
  startInstall(workspace: { id: string }, factoryId: string): Promise<SlackInstallAnswer>;
  /** Revokes the bot's token and forgets the app. The app stays in Slack. */
  disconnect(workspace: { id: string }, factoryId: string): Promise<SlackDisconnectAnswer>;
  /** What Settings › Connections shows of Slack: the factories' apps and the person's links. */
  loadConnections(workspace: { id: string }): Promise<SlackConnectionsAnswer>;
  /** The person's own Slack accounts, linked to them in the workspace. */
  loadLinks(workspace: { id: string }): Promise<SlackLinksAnswer>;
  unlink(workspace: { id: string }, linkId: string): Promise<UnlinkAnswer>;
  /** What a one-time link is, read for `workspace`, the session's active one. */
  readLink(workspace: { id: string }, token: string): Promise<LinkRequestAnswer>;
  /** Links the Slack account a link names to the person in `workspace`, which must be the link's. */
  confirmLink(workspace: { id: string }, token: string): Promise<ConfirmLinkAnswer>;
};

/**
 * The Slack service. The page uses `slackService`; a test builds its own with the API's `fetch`
 * stood in for, and an origin to resolve its address against.
 */
export function createSlackService(options: ApiOptions = {}): SlackService {
  const onWorkspace = workspaceCalls(options);

  async function loadApp(workspace: { id: string }, factoryId: string): Promise<SlackAppAnswer> {
    try {
      const answer = await onWorkspace(workspace.id, (api) =>
        api.GET('/api/factories/{factoryId}/slack', { params: { path: { factoryId } } }),
      );
      if ('kind' in answer) return answer;
      if (answer.response.status === 200 && isSlackApp(answer.data)) {
        return { kind: 'found', app: answer.data };
      }
      const shared = sharedAnswer(answer);
      if (shared && shared.kind !== 'not-allowed') return shared;
      return UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  async function loadLinks(workspace: { id: string }): Promise<SlackLinksAnswer> {
    try {
      const answer = await onWorkspace(workspace.id, (api) => api.GET('/api/slack/links'));
      if ('kind' in answer) return answer;
      const links: unknown = answer.data?.links;
      if (answer.response.status === 200 && Array.isArray(links) && links.every(isLink)) {
        return { kind: 'listed', links };
      }
      if (isNotConfigured(answer)) return NOT_CONFIGURED;
      return UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    loadApp,
    loadLinks,

    async saveCredentials(workspace, factoryId, credentials) {
      try {
        const { clientId, clientSecret, signingSecret } = credentials;
        const answer = await onWorkspace(workspace.id, (api) =>
          api.PUT('/api/factories/{factoryId}/slack/credentials', {
            params: { path: { factoryId } },
            body: { clientId, clientSecret, signingSecret },
          }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && isSlackApp(data)) return { kind: 'saved', app: data };
        if (response.status === 400 && codeOf(error) === 'invalid_credentials') {
          const body: unknown = error;
          const problems = isObject(body) ? body.problems : undefined;
          return {
            kind: 'invalid',
            problems: Array.isArray(problems) ? problems.filter(isCredentialsProblem) : [],
          };
        }
        return sharedAnswer(answer) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async startInstall(workspace, factoryId) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.POST('/api/factories/{factoryId}/slack/install', {
            params: { path: { factoryId } },
          }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        const url: unknown = data?.url;
        // Only Slack's own page is somewhere the page sends the person.
        if (response.status === 200 && isText(url) && isSlackAddress(url)) {
          return { kind: 'started', url };
        }
        if (response.status === 409 && codeOf(error) === 'credentials_missing') {
          return { kind: 'no-credentials' };
        }
        return sharedAnswer(answer) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async disconnect(workspace, factoryId) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.DELETE('/api/factories/{factoryId}/slack', { params: { path: { factoryId } } }),
        );
        if ('kind' in answer) return answer;
        if (answer.response.status === 204) return { kind: 'disconnected' };
        if (answer.response.status === 404 && codeOf(answer.error) === 'slack_not_set_up') {
          return { kind: 'not-found' };
        }
        return sharedAnswer(answer) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadConnections(workspace) {
      try {
        const listed = await onWorkspace(workspace.id, (api) => api.GET('/api/factories'));
        if ('kind' in listed) return listed;
        const factories = listed.data?.factories;
        if (listed.response.status !== 200 || !Array.isArray(factories)) return UNAVAILABLE;
        const [answers, links] = await Promise.all([
          Promise.all(factories.map((factory) => loadApp(workspace, factory.id))),
          loadLinks(workspace),
        ]);
        if (links.kind !== 'listed') return links;
        const apps: FactorySlackApp[] = [];
        let canManage = false;
        for (const [index, answer] of answers.entries()) {
          // A factory gone, or moved away, since the list was read is left out.
          if (answer.kind === 'not-found') continue;
          if (answer.kind !== 'found') return answer;
          canManage = answer.app.canManage;
          if (answer.app.state === 'not_set_up') continue;
          const { id, name } = factories[index];
          apps.push({ factory: { id, name }, app: answer.app });
        }
        return {
          kind: 'listed',
          apps,
          factoryCount: factories.length,
          canManage,
          links: links.links,
        };
      } catch {
        return UNAVAILABLE;
      }
    },

    async unlink(workspace, linkId) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.DELETE('/api/slack/links/{linkId}', { params: { path: { linkId } } }),
        );
        if ('kind' in answer) return answer;
        if (answer.response.status === 204) return { kind: 'unlinked' };
        if (answer.response.status === 404 && codeOf(answer.error) === 'link_not_found') {
          return { kind: 'not-found' };
        }
        if (isNotConfigured(answer)) return NOT_CONFIGURED;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async readLink(workspace, token) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.GET('/api/slack/link-requests/{token}', { params: { path: { token } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && isLinkRequest(data)) return { kind: 'found', request: data };
        if (response.status === 404 && codeOf(error) === 'link_not_found') {
          return { kind: 'not-found' };
        }
        if (isNotConfigured(answer)) return NOT_CONFIGURED;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async confirmLink(workspace, token) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.POST('/api/slack/link-requests/{token}', { params: { path: { token } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        const code = codeOf(error);
        if (response.status === 200 && isLink(data)) return { kind: 'linked', link: data };
        if (response.status === 404 && code === 'link_not_found') {
          return { kind: 'gone', why: 'not-found' };
        }
        if (response.status === 409) {
          if (code === 'link_used') return { kind: 'gone', why: 'used' };
          if (code === 'link_expired') return { kind: 'gone', why: 'expired' };
          if (code === 'other_workspace') return { kind: 'other-workspace' };
          if (code === 'linked_to_someone_else') return { kind: 'taken' };
        }
        if (isNotConfigured(answer)) return NOT_CONFIGURED;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** The page's Slack service. */
export const slackService = createSlackService();

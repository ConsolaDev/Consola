import { describe, expect, it } from 'vitest';
import type { Factory } from '../domain/factories';
import type { SlackApp, SlackLink, SlackLinkRequest } from '../domain/slack';
import { createSlackService } from './slack';

const SPROCKET = { id: 'ws-sprocket' };
const APP = '/api/factories/f-1/slack';

const app: SlackApp = {
  canManage: true,
  state: 'awaiting_install',
  handle: 'code-review',
  clientId: '1234567890.0987654321',
  appId: null,
  appSettingsUrl: null,
  team: null,
  installedAt: null,
  setup: {
    manifest: {
      display_information: { name: 'Code review' },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: 'code-review', always_online: false },
      },
      oauth_config: {
        redirect_urls: ['https://cloud.sprocket.example/api/slack/oauth/callback'],
        scopes: { bot: ['app_mentions:read'] },
      },
      settings: {
        event_subscriptions: {
          request_url: 'https://cloud.sprocket.example/api/slack/events/f-1',
          bot_events: ['app_mention'],
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    createAppUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
    requestUrl: 'https://cloud.sprocket.example/api/slack/events/f-1',
    redirectUrl: 'https://cloud.sprocket.example/api/slack/oauth/callback',
  },
};
const installed: SlackApp = {
  ...app,
  state: 'installed',
  appId: 'A0123456789',
  appSettingsUrl: 'https://api.slack.com/apps/A0123456789',
  team: { id: 'T024BE7LD', name: 'Sprocket' },
  installedAt: '2026-11-27T10:00:00.000Z',
};
const link: SlackLink = {
  id: 'l-1',
  slackTeamId: 'T024BE7LD',
  slackTeamName: 'Sprocket',
  slackUserId: 'U012AB3CD',
  linkedAt: '2026-11-27T10:05:00.000Z',
};
const request: SlackLinkRequest = {
  state: 'open',
  workspaceId: 'ws-sprocket',
  inActiveWorkspace: true,
  slackTeamId: 'T024BE7LD',
  slackUserId: 'U012AB3CD',
  slackTeamName: 'Sprocket',
  factory: { id: 'f-1', name: 'Code review' },
  expiresAt: '2026-11-27T10:15:00.000Z',
};
const codeReview: Factory = {
  id: 'f-1',
  name: 'Code review',
  teamId: 't-1',
  source: { kind: 'stored' },
  latestVersion: 2,
  updatedAt: '2026-11-27T09:00:00.000Z',
};
const releases: Factory = { ...codeReview, id: 'f-2', name: 'Releases' };

type Reply = { status: number; body?: unknown };
type Seen = { method: string; path: string; workspace: string | null; body: string };

const json = ({ status, body }: Reply) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/** A service against a stand-in for the API, which answers each route by `METHOD path`. */
function harness(routes: Record<string, Reply> = {}) {
  const seen: Seen[] = [];
  const service = createSlackService({
    baseUrl: 'http://web.test',
    fetch: async (incoming) => {
      const entry = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        workspace: incoming.headers.get('x-consola-workspace'),
        body: await incoming.text(),
      };
      seen.push(entry);
      const reply = routes[`${entry.method} ${entry.path}`];
      return json(reply ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { service, seen };
}

const SWITCHED = { status: 409, body: { error: 'workspace_switched' } };
const NOT_CONFIGURED = { status: 503, body: { error: 'slack_not_configured' } };

describe('loadApp', () => {
  it('reads the factory’s app for the workspace the page shows', async () => {
    const { service, seen } = harness({ [`GET ${APP}`]: { status: 200, body: app } });
    expect(await service.loadApp(SPROCKET, 'f-1')).toEqual({ kind: 'found', app });
    expect(seen[0]?.workspace).toBe('ws-sprocket');
  });

  it('says Slack is off on the server, and a factory gone', async () => {
    expect(
      await harness({ [`GET ${APP}`]: NOT_CONFIGURED }).service.loadApp(SPROCKET, 'f-1'),
    ).toEqual({ kind: 'not-configured' });
    expect(
      await harness({
        [`GET ${APP}`]: { status: 404, body: { error: 'factory_not_found' } },
      }).service.loadApp(SPROCKET, 'f-1'),
    ).toEqual({ kind: 'not-found' });
  });

  it('reads the caller’s refusals as every route does', async () => {
    expect(await harness({ [`GET ${APP}`]: SWITCHED }).service.loadApp(SPROCKET, 'f-1')).toEqual({
      kind: 'switched',
    });
    expect(
      await harness({
        [`GET ${APP}`]: { status: 401, body: { error: 'signed_out' } },
      }).service.loadApp(SPROCKET, 'f-1'),
    ).toEqual({ kind: 'signed-out' });
  });

  it('is unavailable for an app it cannot read, never a secret’s field read', async () => {
    for (const body of [
      { ...app, state: 'installing' },
      { ...app, canManage: 'yes' },
      { ...app, setup: { ...app.setup, createAppUrl: undefined } },
      'html',
    ]) {
      expect(
        await harness({ [`GET ${APP}`]: { status: 200, body } }).service.loadApp(SPROCKET, 'f-1'),
      ).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('saveCredentials', () => {
  const credentials = {
    clientId: '1234567890.0987654321',
    clientSecret: '0123456789abcdef0123456789abcdef',
    signingSecret: 'fedcba9876543210fedcba9876543210',
  };

  it('sends the three values and answers the app as it is then', async () => {
    const { service, seen } = harness({
      [`PUT ${APP}/credentials`]: { status: 200, body: app },
    });
    expect(await service.saveCredentials(SPROCKET, 'f-1', credentials)).toEqual({
      kind: 'saved',
      app,
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(credentials);
    expect(seen[0]?.workspace).toBe('ws-sprocket');
  });

  it('names the problems the API found, dropping those it does not know', async () => {
    const { service } = harness({
      [`PUT ${APP}/credentials`]: {
        status: 400,
        body: { error: 'invalid_credentials', problems: ['client_id_invalid', 'too_shiny'] },
      },
    });
    expect(await service.saveCredentials(SPROCKET, 'f-1', credentials)).toEqual({
      kind: 'invalid',
      problems: ['client_id_invalid'],
    });
  });

  it('says a member may not, and Slack off on the server', async () => {
    expect(
      await harness({
        [`PUT ${APP}/credentials`]: { status: 403, body: { error: 'not_allowed' } },
      }).service.saveCredentials(SPROCKET, 'f-1', credentials),
    ).toEqual({ kind: 'not-allowed' });
    expect(
      await harness({ [`PUT ${APP}/credentials`]: NOT_CONFIGURED }).service.saveCredentials(
        SPROCKET,
        'f-1',
        credentials,
      ),
    ).toEqual({ kind: 'not-configured' });
  });
});

describe('startInstall', () => {
  it('answers Slack’s authorise page', async () => {
    const url = 'https://slack.com/oauth/v2/authorize?client_id=1234567890.0987654321';
    const { service } = harness({ [`POST ${APP}/install`]: { status: 200, body: { url } } });
    expect(await service.startInstall(SPROCKET, 'f-1')).toEqual({ kind: 'started', url });
  });

  it('never sends the person anywhere but Slack', async () => {
    for (const url of ['https://example.com/oauth', 'http://slack.com/oauth/v2/authorize']) {
      const { service } = harness({ [`POST ${APP}/install`]: { status: 200, body: { url } } });
      expect(await service.startInstall(SPROCKET, 'f-1')).toEqual({ kind: 'unavailable' });
    }
  });

  it('says the credentials are not saved yet', async () => {
    const { service } = harness({
      [`POST ${APP}/install`]: { status: 409, body: { error: 'credentials_missing' } },
    });
    expect(await service.startInstall(SPROCKET, 'f-1')).toEqual({ kind: 'no-credentials' });
  });
});

describe('disconnect', () => {
  it('forgets the app', async () => {
    const { service, seen } = harness({ [`DELETE ${APP}`]: { status: 204 } });
    expect(await service.disconnect(SPROCKET, 'f-1')).toEqual({ kind: 'disconnected' });
    expect(seen[0]?.method).toBe('DELETE');
  });

  it('says an app already gone, and a member who may not', async () => {
    for (const error of ['slack_not_set_up', 'factory_not_found']) {
      expect(
        await harness({
          [`DELETE ${APP}`]: { status: 404, body: { error } },
        }).service.disconnect(SPROCKET, 'f-1'),
      ).toEqual({ kind: 'not-found' });
    }
    expect(
      await harness({
        [`DELETE ${APP}`]: { status: 403, body: { error: 'not_allowed' } },
      }).service.disconnect(SPROCKET, 'f-1'),
    ).toEqual({ kind: 'not-allowed' });
  });
});

describe('the person’s Slack accounts', () => {
  it('lists them, and unlinks one', async () => {
    const { service, seen } = harness({
      'GET /api/slack/links': { status: 200, body: { links: [link] } },
      'DELETE /api/slack/links/l-1': { status: 204 },
    });
    expect(await service.loadLinks(SPROCKET)).toEqual({ kind: 'listed', links: [link] });
    expect(await service.unlink(SPROCKET, 'l-1')).toEqual({ kind: 'unlinked' });
    expect(seen.map((one) => one.workspace)).toEqual(['ws-sprocket', 'ws-sprocket']);
  });

  it('says one already unlinked', async () => {
    const { service } = harness({
      'DELETE /api/slack/links/l-1': { status: 404, body: { error: 'link_not_found' } },
    });
    expect(await service.unlink(SPROCKET, 'l-1')).toEqual({ kind: 'not-found' });
  });
});

describe('loadConnections', () => {
  const factories = { status: 200, body: { factories: [codeReview, releases] } };

  it('lists the factories with an app, and the person’s accounts', async () => {
    const { service } = harness({
      'GET /api/factories': factories,
      [`GET ${APP}`]: { status: 200, body: installed },
      'GET /api/factories/f-2/slack': {
        status: 200,
        body: { ...app, state: 'not_set_up', appId: null },
      },
      'GET /api/slack/links': { status: 200, body: { links: [link] } },
    });
    expect(await service.loadConnections(SPROCKET)).toEqual({
      kind: 'listed',
      apps: [{ factory: { id: 'f-1', name: 'Code review' }, app: installed }],
      factoryCount: 2,
      canManage: true,
      links: [link],
    });
  });

  it('leaves out a factory gone since the list was read', async () => {
    const { service } = harness({
      'GET /api/factories': factories,
      [`GET ${APP}`]: { status: 200, body: installed },
      'GET /api/factories/f-2/slack': { status: 404, body: { error: 'factory_not_found' } },
      'GET /api/slack/links': { status: 200, body: { links: [] } },
    });
    expect(await service.loadConnections(SPROCKET)).toMatchObject({
      kind: 'listed',
      apps: [{ factory: { id: 'f-1' } }],
    });
  });

  it('says Slack is off on the server once', async () => {
    const { service } = harness({
      'GET /api/factories': factories,
      [`GET ${APP}`]: NOT_CONFIGURED,
      'GET /api/factories/f-2/slack': NOT_CONFIGURED,
      'GET /api/slack/links': NOT_CONFIGURED,
    });
    expect(await service.loadConnections(SPROCKET)).toEqual({ kind: 'not-configured' });
  });

  it('is the caller’s refusal when the factories are', async () => {
    const { service } = harness({ 'GET /api/factories': SWITCHED });
    expect(await service.loadConnections(SPROCKET)).toEqual({ kind: 'switched' });
  });
});

describe('a one-time link', () => {
  const TOKEN = '/api/slack/link-requests/tok%2Ben';

  it('is read for the session’s active workspace, which says whether it is the link’s', async () => {
    const { service, seen } = harness({ [`GET ${TOKEN}`]: { status: 200, body: request } });
    expect(await service.readLink(SPROCKET, 'tok+en')).toEqual({ kind: 'found', request });
    expect(seen[0]?.workspace).toBe('ws-sprocket');
  });

  it('is not found when no link has the token', async () => {
    const { service } = harness({
      [`GET ${TOKEN}`]: { status: 404, body: { error: 'link_not_found' } },
    });
    expect(await service.readLink(SPROCKET, 'tok+en')).toEqual({ kind: 'not-found' });
  });

  it('is unavailable when it cannot be read', async () => {
    const { service } = harness({
      [`GET ${TOKEN}`]: { status: 200, body: { ...request, state: 'pending' } },
    });
    expect(await service.readLink(SPROCKET, 'tok+en')).toEqual({ kind: 'unavailable' });
  });

  it('asks a signed-out person to sign in', async () => {
    const { service } = harness({
      [`GET ${TOKEN}`]: { status: 401, body: { error: 'signed_out' } },
    });
    expect(await service.readLink(SPROCKET, 'tok+en')).toEqual({ kind: 'signed-out' });
  });

  it('is confirmed for the link’s own workspace', async () => {
    const { service, seen } = harness({ [`POST ${TOKEN}`]: { status: 200, body: link } });
    expect(await service.confirmLink(SPROCKET, 'tok+en')).toEqual({ kind: 'linked', link });
    expect(seen[0]?.workspace).toBe('ws-sprocket');
  });

  it('says why a confirm was refused', async () => {
    const refusals = [
      [
        { status: 409, body: { error: 'link_used' } },
        { kind: 'gone', why: 'used' },
      ],
      [
        { status: 409, body: { error: 'link_expired' } },
        { kind: 'gone', why: 'expired' },
      ],
      [
        { status: 404, body: { error: 'link_not_found' } },
        { kind: 'gone', why: 'not-found' },
      ],
      [{ status: 409, body: { error: 'other_workspace' } }, { kind: 'other-workspace' }],
      [{ status: 409, body: { error: 'linked_to_someone_else' } }, { kind: 'taken' }],
      [SWITCHED, { kind: 'switched' }],
      [NOT_CONFIGURED, { kind: 'not-configured' }],
    ] as const;
    for (const [reply, said] of refusals) {
      expect(
        await harness({ [`POST ${TOKEN}`]: reply }).service.confirmLink(SPROCKET, 'tok+en'),
      ).toEqual(said);
    }
  });
});

describe('Slack off on the server', () => {
  it('is said by every call, as every route answers it', async () => {
    const { service } = harness({
      [`GET ${APP}`]: NOT_CONFIGURED,
      [`PUT ${APP}/credentials`]: NOT_CONFIGURED,
      [`POST ${APP}/install`]: NOT_CONFIGURED,
      [`DELETE ${APP}`]: NOT_CONFIGURED,
      'GET /api/slack/links': NOT_CONFIGURED,
      'DELETE /api/slack/links/l-1': NOT_CONFIGURED,
      'GET /api/slack/link-requests/t': NOT_CONFIGURED,
    });
    const off = { kind: 'not-configured' };
    expect(await service.loadApp(SPROCKET, 'f-1')).toEqual(off);
    expect(
      await service.saveCredentials(SPROCKET, 'f-1', {
        clientId: '1.2',
        clientSecret: 'x',
        signingSecret: 'y',
      }),
    ).toEqual(off);
    expect(await service.startInstall(SPROCKET, 'f-1')).toEqual(off);
    expect(await service.disconnect(SPROCKET, 'f-1')).toEqual(off);
    expect(await service.loadLinks(SPROCKET)).toEqual(off);
    expect(await service.unlink(SPROCKET, 'l-1')).toEqual(off);
    expect(await service.readLink(SPROCKET, 't')).toEqual(off);
  });
});

describe('an API that does not answer', () => {
  it('is unavailable, never thrown', async () => {
    const service = createSlackService({
      baseUrl: 'http://web.test',
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(await service.loadApp(SPROCKET, 'f-1')).toEqual({ kind: 'unavailable' });
    expect(await service.readLink(SPROCKET, 'tok')).toEqual({ kind: 'unavailable' });
    expect(await service.loadConnections(SPROCKET)).toEqual({ kind: 'unavailable' });
  });
});

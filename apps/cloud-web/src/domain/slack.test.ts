import { describe, expect, it } from 'vitest';
import type { MeState } from './me';
import {
  checkSlackCredentials,
  hashOfSlackLink,
  inviteCommand,
  isInstalled,
  isSlackAddress,
  isSlackAppState,
  linkPageView,
  manifestText,
  readSlackResult,
  SLACK_APP_STATES,
  slackAppPageUrl,
  slackConnected,
  slackLinkTokenOfHash,
  slackSteps,
  slackTeamLabel,
} from './slack';
import type { SlackApp, SlackLink, SlackLinkRequest } from './slack';
import type { MyWorkspace } from './workspace';

const app: SlackApp = {
  canManage: true,
  state: 'not_set_up',
  handle: 'code-review',
  clientId: null,
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

describe('an app’s state', () => {
  it('knows every state the API answers, and nothing else', () => {
    for (const state of SLACK_APP_STATES) expect(isSlackAppState(state)).toBe(true);
    expect(isSlackAppState('installing')).toBe(false);
    expect(isSlackAppState(null)).toBe(false);
  });

  it('is in Slack once installed, even with a token Slack refuses', () => {
    expect(isInstalled({ state: 'installed' })).toBe(true);
    expect(isInstalled({ state: 'needs_reinstall' })).toBe(true);
    expect(isInstalled({ state: 'awaiting_install' })).toBe(false);
    expect(isInstalled({ state: 'not_set_up' })).toBe(false);
  });
});

describe('the setup’s steps', () => {
  it('opens Create and the credentials before anything is saved, Add to Slack waiting', () => {
    expect(slackSteps({ state: 'not_set_up' })).toEqual([
      { id: 'create', status: 'current' },
      { id: 'credentials', status: 'next' },
      { id: 'install', status: 'waiting' },
    ]);
  });

  it('leaves only Add to Slack once the credentials are saved', () => {
    expect(slackSteps({ state: 'awaiting_install' })).toEqual([
      { id: 'create', status: 'done' },
      { id: 'credentials', status: 'done' },
      { id: 'install', status: 'current' },
    ]);
  });

  it('shows no steps for an app in Slack', () => {
    expect(slackSteps({ state: 'installed' })).toBeNull();
    expect(slackSteps({ state: 'needs_reinstall' })).toBeNull();
  });
});

describe('checkSlackCredentials', () => {
  const good = {
    clientId: ' 1234567890.0987654321 ',
    clientSecret: '0123456789abcdef0123456789abcdef\n',
    signingSecret: 'fedcba9876543210fedcba9876543210',
  };

  it('sends them trimmed', () => {
    expect(checkSlackCredentials(good)).toEqual({
      ok: true,
      credentials: {
        clientId: '1234567890.0987654321',
        clientSecret: '0123456789abcdef0123456789abcdef',
        signingSecret: 'fedcba9876543210fedcba9876543210',
      },
    });
  });

  it('names every field left empty', () => {
    expect(checkSlackCredentials({ clientId: '', clientSecret: ' ', signingSecret: '' })).toEqual({
      ok: false,
      problems: ['client_id_missing', 'client_secret_missing', 'signing_secret_missing'],
    });
  });

  it('refuses the App ID, or anything else, pasted for the Client ID', () => {
    for (const clientId of ['A0123456789', '1234567890', '1234567890.', 'abc.def', '1.2.3']) {
      expect(checkSlackCredentials({ ...good, clientId })).toEqual({
        ok: false,
        problems: ['client_id_invalid'],
      });
    }
  });

  it('refuses a secret pasted with something else, or too short to be one', () => {
    expect(
      checkSlackCredentials({
        ...good,
        clientSecret: 'Client Secret 0123456789abcdef',
        signingSecret: 'abc123',
      }),
    ).toEqual({ ok: false, problems: ['client_secret_invalid', 'signing_secret_invalid'] });
  });
});

describe('Slack’s addresses', () => {
  it('are Slack’s own, on https', () => {
    expect(isSlackAddress('https://slack.com/oauth/v2/authorize?client_id=1.2')).toBe(true);
    expect(isSlackAddress(app.setup.createAppUrl)).toBe(true);
    expect(isSlackAddress('https://sprocket.slack.com/archives/C1/p1')).toBe(true);
  });

  it('refuse anything else', () => {
    expect(isSlackAddress('http://slack.com/oauth/v2/authorize')).toBe(false);
    expect(isSlackAddress('https://slack.com.example.com/')).toBe(false);
    expect(isSlackAddress('https://notslack.com/')).toBe(false);
    expect(isSlackAddress('javascript:alert(1)')).toBe(false);
    expect(isSlackAddress('not an address')).toBe(false);
  });

  it('lead to the app’s own page in Slack, or the list of apps without one', () => {
    const page = 'https://api.slack.com/apps/A0123456789';
    expect(slackAppPageUrl({ appSettingsUrl: page })).toBe(page);
    expect(slackAppPageUrl({ appSettingsUrl: null })).toBe('https://api.slack.com/apps');
    expect(slackAppPageUrl({ appSettingsUrl: 'https://example.com/apps/A1' })).toBe(
      'https://api.slack.com/apps',
    );
  });
});

describe('what the page hands a person', () => {
  it('invites the bot by its handle', () => {
    expect(inviteCommand('code-review')).toBe('/invite @code-review');
  });

  it('gives the manifest as JSON, indented', () => {
    expect(manifestText(app)).toBe(JSON.stringify(app.setup.manifest, null, 2));
    expect(manifestText(app)).toContain('\n  "display_information": {\n    "name": "Code review"');
  });
});

describe('readSlackResult', () => {
  it('reads a result the callback names', () => {
    expect(readSlackResult('installed')).toBe('installed');
    expect(readSlackResult('cancelled')).toBe('cancelled');
  });

  it('is unknown for one this page does not know, and null for none', () => {
    expect(readSlackResult('exploded')).toBe('unknown');
    expect(readSlackResult('')).toBe('unknown');
    expect(readSlackResult(null)).toBeNull();
  });
});

describe('a link page’s address', () => {
  it('names its token', () => {
    expect(slackLinkTokenOfHash('#/slack/link/abc123')).toBe('abc123');
    expect(slackLinkTokenOfHash('#/slack/link/abc123/')).toBe('abc123');
    expect(slackLinkTokenOfHash('#/slack/link/abc123?from=slack')).toBe('abc123');
    expect(slackLinkTokenOfHash('#/slack/link/a%2Bb')).toBe('a+b');
  });

  it('is no link page for any other hash', () => {
    expect(slackLinkTokenOfHash('')).toBeNull();
    expect(slackLinkTokenOfHash('#/')).toBeNull();
    expect(slackLinkTokenOfHash('#/slack/link/')).toBeNull();
    expect(slackLinkTokenOfHash('#/slack/links/abc')).toBeNull();
    expect(slackLinkTokenOfHash('#/settings/connections')).toBeNull();
    expect(slackLinkTokenOfHash('#/slack/link/%E0%A4%A')).toBeNull();
  });

  it('is the hash sign-in comes back to', () => {
    expect(hashOfSlackLink('a+b')).toBe('#/slack/link/a%2Bb');
    expect(slackLinkTokenOfHash(hashOfSlackLink('a+b/c'))).toBe('a+b/c');
  });
});

describe('how a Slack workspace is named', () => {
  it('by its name, else its id', () => {
    expect(slackTeamLabel({ id: 'T024BE7LD', name: 'Sprocket' })).toBe('Sprocket');
    expect(slackTeamLabel({ id: 'T024BE7LD', name: null })).toBe('T024BE7LD');
  });
});

describe('whether Slack counts as connected', () => {
  const link: SlackLink = {
    id: 'l-1',
    slackTeamId: 'T024BE7LD',
    slackTeamName: 'Sprocket',
    slackUserId: 'U012AB3CD',
    linkedAt: '2026-11-27T10:00:00.000Z',
  };
  const factory = { id: 'f-1', name: 'Code review' };

  it('is once a factory has an app, or the person linked an account', () => {
    const listed = { kind: 'listed', factoryCount: 1, canManage: true } as const;
    expect(slackConnected({ ...listed, apps: [], links: [] })).toBe(false);
    expect(slackConnected({ ...listed, apps: [{ factory, app }], links: [] })).toBe(true);
    expect(slackConnected({ ...listed, apps: [], links: [link] })).toBe(true);
    expect(slackConnected({ kind: 'not-configured' })).toBe(false);
    expect(slackConnected({ kind: 'unavailable' })).toBe(false);
  });
});

describe('linkPageView', () => {
  const sprocket: MyWorkspace = {
    id: 'ws-sprocket',
    name: 'Sprocket',
    slug: 'sprocket',
    region: 'eu',
    role: 'member',
    icon: null,
    canManage: false,
  };
  const labs: MyWorkspace = { ...sprocket, id: 'ws-labs', name: 'Sprocket Labs', slug: 'labs' };
  const signedIn = (workspace: MyWorkspace | null): MeState => ({
    kind: 'signed-in',
    me: {
      user: { id: 'p-ada', name: 'Ada', email: 'ada@sprocket.example', image: null },
      workspace,
    },
  });
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
  const found = { kind: 'found', request } as const;
  const elsewhere = { kind: 'found', request: { ...request, inActiveWorkspace: false } } as const;
  const named = (workspace: MyWorkspace) => ({ id: workspace.id, name: workspace.name });

  it('waits for who is signed in, then for the link', () => {
    expect(linkPageView({ me: null, workspaces: null, read: null, linked: false })).toEqual({
      kind: 'loading',
    });
    expect(
      linkPageView({ me: signedIn(sprocket), workspaces: [sprocket], read: null, linked: false }),
    ).toEqual({ kind: 'loading' });
  });

  it('asks a signed-out person to sign in, before reading the link', () => {
    expect(
      linkPageView({ me: { kind: 'signed-out' }, workspaces: null, read: null, linked: false }),
    ).toEqual({ kind: 'signed-out' });
    expect(
      linkPageView({
        me: signedIn(sprocket),
        workspaces: [sprocket],
        read: { kind: 'signed-out' },
        linked: false,
      }),
    ).toEqual({ kind: 'signed-out' });
  });

  it('asks someone with no workspace open to open one, since the link cannot be read', () => {
    expect(
      linkPageView({ me: signedIn(null), workspaces: [sprocket], read: null, linked: false }),
    ).toEqual({ kind: 'no-workspace' });
  });

  it('says why a link no longer works', () => {
    const base = { me: signedIn(sprocket), workspaces: [sprocket], linked: false };
    expect(linkPageView({ ...base, read: { kind: 'not-found' } })).toEqual({
      kind: 'gone',
      why: 'not-found',
      request: null,
    });
    for (const state of ['used', 'expired'] as const) {
      const read = { kind: 'found', request: { ...request, state } } as const;
      expect(linkPageView({ ...base, read })).toEqual({
        kind: 'gone',
        why: state,
        request: read.request,
      });
    }
  });

  it('asks to confirm a link for the workspace open', () => {
    expect(
      linkPageView({ me: signedIn(sprocket), workspaces: [sprocket], read: found, linked: false }),
    ).toEqual({ kind: 'confirm', request, workspace: named(sprocket) });
  });

  it('offers to switch to the link’s workspace when another is open', () => {
    expect(
      linkPageView({
        me: signedIn(labs),
        workspaces: [labs, sprocket],
        read: elsewhere,
        linked: false,
      }),
    ).toEqual({
      kind: 'other-workspace',
      request: elsewhere.request,
      target: named(sprocket),
      active: named(labs),
    });
  });

  it('offers the switch unnamed when the workspaces could not be listed: the API decides', () => {
    expect(
      linkPageView({ me: signedIn(labs), workspaces: null, read: elsewhere, linked: false }),
    ).toMatchObject({ kind: 'other-workspace', target: { id: 'ws-sprocket', name: null } });
  });

  it('says a link for a workspace the person is not in is not theirs to take', () => {
    expect(
      linkPageView({ me: signedIn(labs), workspaces: [labs], read: elsewhere, linked: false }),
    ).toEqual({ kind: 'not-a-member', request: elsewhere.request });
  });

  it('says it is linked once confirmed', () => {
    expect(
      linkPageView({ me: signedIn(sprocket), workspaces: [sprocket], read: found, linked: true }),
    ).toEqual({ kind: 'linked', request, workspace: named(sprocket) });
  });

  it('says the API’s states as they are', () => {
    const base = { me: signedIn(sprocket), workspaces: [sprocket], linked: false };
    expect(
      linkPageView({ me: { kind: 'unavailable' }, workspaces: null, read: null, linked: false }),
    ).toEqual({ kind: 'unavailable' });
    for (const kind of ['unavailable', 'switched', 'not-configured'] as const) {
      expect(linkPageView({ ...base, read: { kind } })).toEqual({ kind });
    }
  });
});

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Clock, FactoryStore, MembershipReader, TeamStore } from '../../application/ports.js';
import {
  disconnectSlack,
  finishSlackInstall,
  getSlackApp,
  saveSlackCredentials,
  startSlackInstall,
} from '../../application/slackApps.js';
import type {
  SlackAppPorts,
  SlackAppStatus,
  SlackInstallOutcome,
} from '../../application/slackApps.js';
import type {
  LinkTokens,
  SecretSealer,
  SlackApi,
  SlackAppStore,
  SlackInstallStateSigner,
  SlackLinkStore,
} from '../../application/slackPorts.js';
import { requireCaller } from './caller.js';
import type { CompanyEnv, WhoIsAsking } from './caller.js';
import {
  deleteFactorySlack,
  deleteSlackLink,
  getFactorySlack,
  getSlackLinkRequest,
  getSlackOAuthCallback,
  listSlackLinks,
  postFactorySlackInstall,
  postSlackLinkRequest,
  putFactorySlackCredentials,
  SlackCallbackResult,
} from './slackContract.js';
import type { SLACK_CALLBACK_RESULTS } from './slackContract.js';

/** Every route `registerSlackRoutes` registers, in the order it registers them. */
export const SLACK_ROUTES = [
  getFactorySlack,
  putFactorySlackCredentials,
  postFactorySlackInstall,
  deleteFactorySlack,
  getSlackOAuthCallback,
  getSlackLinkRequest,
  postSlackLinkRequest,
  listSlackLinks,
  deleteSlackLink,
];

type CallbackResult = (typeof SLACK_CALLBACK_RESULTS)[number];

/**
 * Where in the web app an "Add to Slack" ends: the factory's settings
 * (`#/factories/<id>/settings`), or Settings' Connections page when the state names no factory.
 * The web app keeps the same addresses, so the two change together.
 */
const factorySettingsPage = (factoryId: string) =>
  `#/factories/${encodeURIComponent(factoryId)}/settings`;
const CONNECTIONS_PAGE = '#/settings/connections';

type SlackInstallEnd = Exclude<SlackInstallOutcome, { kind: 'bad-state' }>['kind'];

/** How each way an "Add to Slack" ends is named in `?slack=`, as the contract lists them. */
const CALLBACK_RESULT = {
  installed: 'installed',
  cancelled: 'cancelled',
  expired: 'expired',
  'not-allowed': 'not_allowed',
  'factory-not-found': 'factory_not_found',
  'credentials-missing': 'credentials_missing',
  'credentials-changed': 'credentials_changed',
  'code-refused': 'code_refused',
  'not-a-bot': 'not_a_bot',
  'enterprise-install': 'enterprise_install',
  'app-taken': 'app_taken',
  'wrong-app': 'wrong_app',
  invalid: 'invalid',
  unavailable: 'unavailable',
} as const satisfies Record<SlackInstallEnd, CallbackResult>;

/** What Slack's routes need when Slack is on: the stores, the adapters and the time. */
export type SlackOn = {
  teams: TeamStore;
  factories: FactoryStore;
  apps: SlackAppStore;
  links: SlackLinkStore;
  sealer: SecretSealer;
  states: SlackInstallStateSigner;
  api: SlackApi;
  tokens: LinkTokens;
  clock: Clock;
  /** Hears what failed on Slack's side, by ids alone, one line each. */
  report: (line: string) => void;
};

/** What Slack's routes need. */
export type SlackRouteDeps = {
  /** Who a request's session says is asking (accounts' `currentSession`). */
  whoIsAsking: WhoIsAsking;
  /** Who is a member of which workspace, as `member` holds it now. */
  membership: MembershipReader;
  /** The web app's origin (`PUBLIC_URL`): where the callback sends the person back. */
  publicUrl: string;
  /** Where Slack reaches the API (`SLACK_PUBLIC_URL`, else `PUBLIC_URL`). */
  slackPublicUrl: string;
  /** Null without `CONNECTION_SECRETS_KEY`: then Slack is off, and every route says so. */
  slack: SlackOn | null;
};

/** A factory's Slack app, as the contract answers it. */
const statusAnswer = (status: SlackAppStatus) => ({
  ...status,
  installedAt: status.installedAt?.toISOString() ?? null,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Registers Slack's routes on `app` (CON-144): a factory's Slack app, Slack's redirect back after
 * "Add to Slack", and the Slack accounts people link. Every route a page calls takes
 * `requireCaller` as route middleware, so the role is the caller's at this request. The OAuth
 * callback takes none: Slack's redirect reaches it on Slack's public address (a tunnel, in
 * development), where the session cookie may not be, and its signed state says who started it.
 * It is a GET, so the origin check leaves it alone. Slack's events are registered with their own
 * routes. Each route asks a use case and maps its answer to a status and a body. With Slack off,
 * each answers 503 `slack_not_configured`, and the callback sends the person back saying so.
 */
export function registerSlackRoutes(app: OpenAPIHono, deps: SlackRouteDeps): void {
  const { whoIsAsking, membership, publicUrl, slackPublicUrl, slack } = deps;
  const caller = requireCaller({ whoIsAsking, membership });
  const off = { error: 'slack_not_configured' } as const;
  const appPorts: SlackAppPorts | null = slack && {
    teams: slack.teams,
    factories: slack.factories,
    apps: slack.apps,
    sealer: slack.sealer,
    states: slack.states,
    slack: slack.api,
    membership,
    clock: slack.clock,
    report: slack.report,
  };
  // The factory's Slack app, for anyone who sees the factory.
  app.openapi({ ...getFactorySlack, middleware: [caller] as const }, async (c) => {
    if (!appPorts) return c.json(off, 503);
    const answer = await getSlackApp(
      appPorts,
      c.var.caller,
      c.req.valid('param').factoryId,
      slackPublicUrl,
    );
    if (answer.kind === 'not-found') return c.json({ error: 'factory_not_found' } as const, 404);
    return c.json(statusAnswer(answer.status), 200);
  });

  // Saves the app's credentials. A body of the wrong shape still gets every problem named: the
  // use case checks the role first, then the credentials, which refuse whatever the schema does.
  app.openapi(
    { ...putFactorySlackCredentials, middleware: [caller] as const },
    async (c) => {
      if (!appPorts) return c.json(off, 503);
      const answer = await saveSlackCredentials(
        appPorts,
        c.var.caller,
        c.req.valid('param').factoryId,
        c.req.valid('json'),
        slackPublicUrl,
      );
      switch (answer.kind) {
        case 'saved':
          return c.json(statusAnswer(answer.status), 200);
        case 'invalid':
          return c.json({ error: 'invalid_credentials', problems: answer.problems } as const, 400);
        case 'not-allowed':
          return c.json({ error: 'not_allowed' } as const, 403);
        case 'not-found':
          return c.json({ error: 'factory_not_found' } as const, 404);
      }
    },
    (result, c) => {
      if (result.success || result.target !== 'json') return undefined;
      const shapeless = async () => {
        if (!appPorts) return c.json(off, 503);
        const sent: unknown = await c.req.json();
        // The hook runs after the route's middleware, so the caller is set; its type does not say so.
        const { caller: asking } = c.var as unknown as CompanyEnv['Variables'];
        const answer = await saveSlackCredentials(
          appPorts,
          asking,
          c.req.param('factoryId'),
          isObject(sent) ? sent : {},
          slackPublicUrl,
        );
        if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
        const problems = answer.kind === 'invalid' ? answer.problems : [];
        return c.json({ error: 'invalid_credentials', problems } as const, 400);
      };
      return shapeless();
    },
  );

  // Starts "Add to Slack": Slack's authorise page, which the web app sends the person to.
  app.openapi({ ...postFactorySlackInstall, middleware: [caller] as const }, async (c) => {
    if (!appPorts) return c.json(off, 503);
    const answer = await startSlackInstall(
      appPorts,
      c.var.caller,
      c.req.valid('param').factoryId,
      slackPublicUrl,
    );
    switch (answer.kind) {
      case 'started':
        c.header('cache-control', 'no-store');
        return c.json({ url: answer.url }, 200);
      case 'credentials-missing':
        return c.json({ error: 'credentials_missing' } as const, 409);
      case 'not-allowed':
        return c.json({ error: 'not_allowed' } as const, 403);
      case 'not-found':
        return c.json({ error: 'factory_not_found' } as const, 404);
    }
  });

  // Disconnects the factory's app: forgets it, and revokes its bot token as far as Slack answers.
  app.openapi({ ...deleteFactorySlack, middleware: [caller] as const }, async (c) => {
    if (!appPorts) return c.json(off, 503);
    const answer = await disconnectSlack(appPorts, c.var.caller, c.req.valid('param').factoryId);
    switch (answer.kind) {
      case 'disconnected':
        return c.body(null, 204);
      case 'not-set-up':
        return c.json({ error: 'slack_not_set_up' } as const, 404);
      case 'not-allowed':
        return c.json({ error: 'not_allowed' } as const, 403);
      case 'not-found':
        return c.json({ error: 'factory_not_found' } as const, 404);
    }
  });

  // Where Slack sends the browser back after "Add to Slack". Its query is read as it comes, never
  // validated: whatever Slack sends, it redirects to the web app.
  app.openapi(getSlackOAuthCallback, async (c) => {
    const back = (result: CallbackResult, factoryId?: string) => {
      c.header('cache-control', 'no-store');
      // The address carried a code and a state; neither goes on in a Referer.
      c.header('referrer-policy', 'no-referrer');
      const page = factoryId === undefined ? CONNECTIONS_PAGE : factorySettingsPage(factoryId);
      return c.redirect(`${publicUrl}/?slack=${result}${page}`, 302);
    };
    if (!appPorts) return back('not_configured');
    const outcome = await finishSlackInstall(
      appPorts,
      { state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error') },
      slackPublicUrl,
    );
    if (outcome.kind === 'bad-state') return back('bad_state');
    return back(CALLBACK_RESULT[outcome.kind], outcome.factoryId);
  });
  // No body carries the results, so the document names them itself, for clients to check theirs.
  app.openAPIRegistry.register('SlackCallbackResult', SlackCallbackResult);

  // The Slack accounts people link: not built yet, so they answer that Slack is off.
  app.openapi({ ...getSlackLinkRequest, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...postSlackLinkRequest, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...listSlackLinks, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...deleteSlackLink, middleware: [caller] as const }, (c) => c.json(off, 503));
}

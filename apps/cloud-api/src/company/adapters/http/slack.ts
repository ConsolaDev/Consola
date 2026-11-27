import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MembershipReader } from '../../application/ports.js';
import type { SecretSealer } from '../../application/slackPorts.js';
import { requireCaller } from './caller.js';
import type { WhoIsAsking } from './caller.js';
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

/** Where in the web app an "Add to Slack" ends when its state names no factory. */
const CONNECTIONS_PAGE = '#/settings/connections';

/** What Slack's routes need. */
export type SlackRouteDeps = {
  /** Who a request's session says is asking (accounts' `currentSession`). */
  whoIsAsking: WhoIsAsking;
  /** Who is a member of which workspace, as `member` holds it now. */
  membership: MembershipReader;
  /** The web app's origin (`PUBLIC_URL`): where the callback sends the person back. */
  publicUrl: string;
  /** Seals Slack's secrets: null without `CONNECTION_SECRETS_KEY`, and then Slack is off. */
  sealer: SecretSealer | null;
};

/**
 * Registers Slack's routes on `app`. Every route a page calls takes `requireCaller` as route
 * middleware; the OAuth callback, a browser redirect from Slack, takes none.
 *
 * Until each is built, a route answers that Slack is off (503 `slack_not_configured`), and the
 * callback sends the person back saying so.
 */
export function registerSlackRoutes(app: OpenAPIHono, deps: SlackRouteDeps): void {
  const { whoIsAsking, membership, publicUrl } = deps;
  const caller = requireCaller({ whoIsAsking, membership });
  const off = { error: 'slack_not_configured' } as const;

  app.openapi({ ...getFactorySlack, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...putFactorySlackCredentials, middleware: [caller] as const }, (c) =>
    c.json(off, 503),
  );
  app.openapi({ ...postFactorySlackInstall, middleware: [caller] as const }, (c) =>
    c.json(off, 503),
  );
  app.openapi({ ...deleteFactorySlack, middleware: [caller] as const }, (c) => c.json(off, 503));

  app.openapi(getSlackOAuthCallback, (c) => {
    const result: CallbackResult = 'not_configured';
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(`${publicUrl}/?slack=${result}${CONNECTIONS_PAGE}`, 302);
  });
  // No body carries the results, so the document names them itself, for clients to check theirs.
  app.openAPIRegistry.register('SlackCallbackResult', SlackCallbackResult);

  app.openapi({ ...getSlackLinkRequest, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...postSlackLinkRequest, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...listSlackLinks, middleware: [caller] as const }, (c) => c.json(off, 503));
  app.openapi({ ...deleteSlackLink, middleware: [caller] as const }, (c) => c.json(off, 503));
}

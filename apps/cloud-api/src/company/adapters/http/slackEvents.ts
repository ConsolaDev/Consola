import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { SLACK_EVENT_MAX_BYTES } from '../../domain/slackEvents.js';
import { postSlackEvent } from './slackEventsContract.js';

/** Every route `registerSlackEventRoutes` registers. */
export const SLACK_EVENT_ROUTES = [postSlackEvent];

/** Where the route logs: ids and outcomes, never a body, a signature or a secret. */
export type SlackEventLog = Pick<Console, 'info' | 'warn'>;

/** What Slack's events route needs. */
export type SlackEventRouteDeps = { log: SlackEventLog };

/**
 * `POST /api/slack/events/{factoryId}` (`postSlackEvent` in the contract): each factory's Events
 * API request URL. Slack calls it, with no session and no Origin header, so the composition
 * exempts it from the origin check. The body is read as bytes, after a size check that refuses
 * anything over `SLACK_EVENT_MAX_BYTES` without reading it (413).
 */
export function registerSlackEventRoutes(app: OpenAPIHono, deps: SlackEventRouteDeps): void {
  const { log } = deps;

  const size = bodyLimit({
    maxSize: SLACK_EVENT_MAX_BYTES,
    onError: (c) => {
      log.warn(`Refused a Slack event: its body is over ${SLACK_EVENT_MAX_BYTES} bytes.`);
      return c.json({ error: 'too_large' } as const, 413);
    },
  });

  app.openapi({ ...postSlackEvent, middleware: [size] as const }, async (c) => {
    await c.req.arrayBuffer();
    log.warn('Refused a Slack event: Slack is off on this server (no CONNECTION_SECRETS_KEY).');
    return c.json({ error: 'slack_not_configured' } as const, 503);
  });
}

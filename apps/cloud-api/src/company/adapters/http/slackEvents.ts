import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { receiveSlackEvent } from '../../application/slackEvents.js';
import type { SlackEventOutcome, SlackEventPorts } from '../../application/slackEvents.js';
import { SLACK_EVENT_MAX_BYTES } from '../../domain/slackEvents.js';
import { postSlackEvent } from './slackEventsContract.js';

/** Every route `registerSlackEventRoutes` registers. */
export const SLACK_EVENT_ROUTES = [postSlackEvent];

/** Where the route logs: ids and outcomes, never a body, a signature or a secret. */
export type SlackEventLog = Pick<Console, 'info' | 'warn'>;

/**
 * The line logged for an outcome, and how loud. The factory is named only once it is known to
 * exist, and an event's id and type only once its signature has checked: before that they are
 * anyone's words. Never a challenge, a body, a signature or a secret.
 */
export function slackEventLine(outcome: SlackEventOutcome): {
  level: 'info' | 'warn';
  line: string;
} {
  switch (outcome.kind) {
    case 'unknown-factory':
      return { level: 'warn', line: 'Refused a Slack event: no factory has the id it names.' };
    case 'challenge':
      return {
        level: 'info',
        line: outcome.checked
          ? `Answered Slack's check of factory ${outcome.factoryId}'s events address.`
          : `Answered Slack's check of factory ${outcome.factoryId}'s events address, unchecked: its app has no signing secret yet.`,
      };
    case 'not-set-up':
      return {
        level: 'warn',
        line: `Refused a Slack event for factory ${outcome.factoryId}: its app has no signing secret yet.`,
      };
    case 'bad-signature':
      return {
        level: 'warn',
        line:
          outcome.why === 'stale'
            ? `Refused a Slack event for factory ${outcome.factoryId}: its timestamp is missing or more than five minutes away.`
            : `Refused a Slack event for factory ${outcome.factoryId}: it is not signed with its app's signing secret.`,
      };
    case 'invalid':
      return {
        level: 'warn',
        line: `Refused a signed Slack event for factory ${outcome.factoryId}: ${outcome.reason}.`,
      };
    case 'ignored':
      return {
        level: 'info',
        line: `Ignored Slack's ${outcome.type} for factory ${outcome.factoryId}.`,
      };
    case 'not-installed':
      return {
        level: 'warn',
        line: `Refused a Slack event for factory ${outcome.factoryId}: its app is not added to a Slack workspace yet.`,
      };
    case 'wrong-app':
      return {
        level: 'warn',
        line: `Refused Slack event ${outcome.eventId} for factory ${outcome.factoryId}: it names another app or Slack workspace.`,
      };
    case 'duplicate':
      return {
        level: 'info',
        line: `Slack sent event ${outcome.eventId} (${outcome.eventType}) for factory ${outcome.factoryId} again: nothing changed.`,
      };
    case 'accepted':
      return {
        level: 'info',
        line: `Accepted Slack event ${outcome.eventId} (${outcome.eventType}) for factory ${outcome.factoryId}.`,
      };
    case 'unavailable':
      return {
        level: 'warn',
        line: `Could not take a Slack event${outcome.factoryId === null ? '' : ` for factory ${outcome.factoryId}`}: ${outcome.reason}.`,
      };
  }
}

/** What Slack's events route needs. */
export type SlackEventRouteDeps = {
  /** Null when Slack is off (no `CONNECTION_SECRETS_KEY`): every event is refused. */
  slack: SlackEventPorts | null;
  log: SlackEventLog;
};

/**
 * `POST /api/slack/events/{factoryId}` (`postSlackEvent` in the contract): each factory's Events
 * API request URL. Slack calls it, with no session and no Origin header, so the composition
 * exempts it from the origin check: the factory's signing secret is what says the request is
 * Slack's. The body is read as bytes, after a size check that refuses anything over
 * `SLACK_EVENT_MAX_BYTES` without reading it (413), and `receiveSlackEvent` checks the signature
 * over those bytes before anything else. Each outcome is logged in one line, and answered with its
 * status at once: what an event asks for is handled after the answer.
 */
export function registerSlackEventRoutes(app: OpenAPIHono, deps: SlackEventRouteDeps): void {
  const { slack, log } = deps;

  const size = bodyLimit({
    maxSize: SLACK_EVENT_MAX_BYTES,
    onError: (c) => {
      log.warn(`Refused a Slack event: its body is over ${SLACK_EVENT_MAX_BYTES} bytes.`);
      return c.json({ error: 'too_large' } as const, 413);
    },
  });

  app.openapi({ ...postSlackEvent, middleware: [size] as const }, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (slack === null) {
      log.warn('Refused a Slack event: Slack is off on this server (no CONNECTION_SECRETS_KEY).');
      return c.json({ error: 'slack_not_configured' } as const, 503);
    }
    const outcome = await receiveSlackEvent(slack, {
      factoryId: c.req.valid('param').factoryId,
      body,
      timestamp: c.req.header('x-slack-request-timestamp'),
      signature: c.req.header('x-slack-signature'),
    });
    const { level, line } = slackEventLine(outcome);
    log[level](line);

    switch (outcome.kind) {
      case 'challenge':
        return c.json({ challenge: outcome.challenge }, 200);
      case 'accepted':
        return c.json({ result: 'accepted' } as const, 200);
      case 'duplicate':
        return c.json({ result: 'duplicate' } as const, 200);
      case 'ignored':
        return c.json({ result: 'ignored' } as const, 200);
      case 'invalid':
        return c.json({ error: 'invalid_event' } as const, 400);
      case 'bad-signature':
        return c.json({ error: 'bad_signature' } as const, 401);
      case 'wrong-app':
        return c.json({ error: 'wrong_app' } as const, 403);
      case 'unknown-factory':
        return c.json({ error: 'factory_not_found' } as const, 404);
      case 'not-set-up':
        return c.json({ error: 'slack_not_set_up' } as const, 409);
      case 'not-installed':
        return c.json({ error: 'slack_not_installed' } as const, 409);
      case 'unavailable':
        return c.json({ error: 'unavailable' } as const, 503);
    }
  });
}

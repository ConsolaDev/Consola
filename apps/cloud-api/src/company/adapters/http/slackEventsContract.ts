import { createRoute, z } from '@hono/zod-openapi';
import { SLACK_EVENTS_PATH_PREFIX } from '../../domain/slack.js';
import { SLACK_EVENT_MAX_BYTES } from '../../domain/slackEvents.js';

/**
 * Slack's events, the one route of the contract Slack itself calls: a factory's Events API
 * request URL (CON-144). `slackEvents.ts` implements it. Like GitHub's webhooks, it has no caller
 * and sits outside the origin check: the factory's signing secret is what says the request is
 * Slack's. The request is declared only in words, since a body or header schema would make the
 * library read them before the signature is checked. Answers are strict objects.
 */

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const FactoryId = z.string().openapi({ param: { name: 'factoryId', in: 'path' } });

export const SlackChallenge = z
  .strictObject({
    challenge: z.string().openapi({ description: 'The `challenge` Slack sent, as it sent it.' }),
  })
  .openapi('SlackChallenge', {
    description:
      'Slack’s check of the request URL (`url_verification`), answered with its challenge.',
  });

export const SlackEventReceived = z
  .strictObject({
    result: z.enum(['accepted', 'duplicate', 'ignored']).openapi({
      description:
        '`accepted`: the event is recorded now, and handled after this answer. `duplicate`: ' +
        'the factory had this event already (Slack sent it again): nothing changed. `ignored`: ' +
        'a kind of request Consola does not take.',
    }),
  })
  .openapi('SlackEventReceived', { description: 'What became of one of Slack’s events.' });

export const postSlackEvent = createRoute({
  method: 'post',
  path: `${SLACK_EVENTS_PATH_PREFIX}{factoryId}`,
  summary: 'Receive one of Slack’s events for a factory’s app',
  description:
    'A factory’s Events API request URL. Slack calls it, with no session and no Origin, so it is ' +
    'outside the origin check. The body is Slack’s JSON, read as raw bytes and checked against ' +
    '`X-Slack-Signature` (`v0=` and the HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<body>` ' +
    'under the factory’s signing secret, compared in constant time), with a timestamp within ' +
    'five minutes, before anything else is read. Before the factory has a signing secret, only ' +
    'Slack’s check of the URL (`url_verification`) is answered, unchecked, and it changes ' +
    'nothing. An event (`event_callback`) must name the factory’s app and Slack workspace, is ' +
    'recorded once by its `event_id`, and is answered at once; a mention of the bot or a direct ' +
    'message to it then starts a request for the factory’s orchestrator.',
  request: { params: z.object({ factoryId: FactoryId }) },
  responses: {
    200: json(
      z.union([SlackChallenge, SlackEventReceived]),
      'Slack’s check of the URL, answered; or an event, received.',
    ),
    400: json(failure('invalid_event'), 'Signed, but the body is not what Slack sends.'),
    401: json(
      failure('bad_signature'),
      'No signature, a timestamp more than five minutes away, or not Slack’s signature over ' +
        'this body under the factory’s signing secret.',
    ),
    403: json(
      failure('wrong_app'),
      'Signed, but the event names another Slack app or Slack workspace than the factory’s.',
    ),
    404: json(failure('factory_not_found'), 'No factory has that id.'),
    409: json(
      z.union([failure('slack_not_set_up'), failure('slack_not_installed')]),
      'The factory’s app has no signing secret in Consola yet, so only Slack’s check of the URL ' +
        'is answered (`slack_not_set_up`); or it is not added to a Slack workspace yet, so no ' +
        'event is taken (`slack_not_installed`).',
    ),
    413: json(failure('too_large'), `Over the ${SLACK_EVENT_MAX_BYTES} bytes Consola reads.`),
    503: json(
      z.union([failure('slack_not_configured'), failure('unavailable')]),
      'Slack is off on this server: it has no `CONNECTION_SECRETS_KEY` (`slack_not_configured`). ' +
        'Or the database did not answer, or the factory’s secret does not open with this ' +
        'server’s key (`unavailable`): Slack sends the event again.',
    ),
  },
});

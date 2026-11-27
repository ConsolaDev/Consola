import { z } from 'zod';
import type {
  SlackAnswer,
  SlackApi,
  SlackBlock,
  SlackError,
} from '../../application/slackPorts.js';

/** Slack's Web API. */
export const SLACK_API_URL = 'https://slack.com/api';

/** How long a call may take before it is given up as unavailable. */
const TIMEOUT_MS = 10_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** An error code as Slack writes one (`invalid_auth`, `channel_not_found`). */
const ERROR_CODE = /^[a-z0-9_.]{1,100}$/;

const Refusal = z.object({ ok: z.literal(false), error: z.string() });

const OAuthAccess = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().default(''),
  bot_user_id: z.string().min(1),
  app_id: z.string().min(1),
  team: z.object({ id: z.string().min(1), name: z.string() }),
  is_enterprise_install: z.boolean().default(false),
});

const AuthRevoke = z.object({ ok: z.literal(true), revoked: z.boolean() });

const AuthTest = z.object({
  ok: z.literal(true),
  team_id: z.string(),
  team: z.string(),
  user_id: z.string(),
  user: z.string(),
  bot_id: z.string().optional(),
});

const PostMessage = z.object({ ok: z.literal(true), channel: z.string(), ts: z.string() });
const PostEphemeral = z.object({ ok: z.literal(true), message_ts: z.string() });
const Done = z.object({ ok: z.literal(true) });
const Permalink = z.object({ ok: z.literal(true), permalink: z.string() });

const unavailable = (reason: string): { ok: false; error: SlackError } => ({
  ok: false,
  error: { kind: 'unavailable', reason },
});

/** Slack's `ok: false`, as a refusal with its code; a code of no shape Slack writes is `unknown`. */
const refused = (code: string): { ok: false; error: SlackError } => ({
  ok: false,
  error: { kind: 'refused', code: ERROR_CODE.test(code) ? code : 'unknown' },
});

/** A body Slack reads as a form, leaving out what is not given. */
function form(fields: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(name, value);
  }
  return body;
}

/**
 * Slack's Web API over `fetch`: each method the app calls, with the token it is handed in the
 * `Authorization` header, never in an address. Every answer is read with the shape Slack gives
 * it: `ok: false` is a refusal with Slack's error code (`invalid_auth`, `channel_not_found`…), a
 * 429 is `ratelimited`, and a call that cannot be made, times out, or answers anything else is
 * `unavailable`, with a reason that names the method and the status, never a token, a secret or
 * a code. Nothing here logs, and nothing throws.
 */
export function createSlackApi(deps: { fetch?: Fetch; baseUrl?: string } = {}): SlackApi {
  const call: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const base = deps.baseUrl ?? SLACK_API_URL;

  async function ask<Schema extends z.ZodType, T>(
    method: string,
    request: { authorization: string; body: URLSearchParams | Record<string, unknown> },
    schema: Schema,
    read: (answer: z.infer<Schema>) => T,
  ): Promise<SlackAnswer<T>> {
    const isForm = request.body instanceof URLSearchParams;
    let response: Response;
    try {
      response = await call(`${base}/${method}`, {
        method: 'POST',
        headers: {
          authorization: request.authorization,
          'content-type': isForm
            ? 'application/x-www-form-urlencoded'
            : 'application/json; charset=utf-8',
        },
        body: isForm ? request.body.toString() : JSON.stringify(request.body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return unavailable(`${method}: ${timedOut ? 'no answer in time' : 'could not reach Slack'}`);
    }
    if (response.status === 429) return refused('ratelimited');
    if (!response.ok) return unavailable(`${method}: HTTP ${response.status}`);

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return unavailable(`${method}: the answer is not JSON`);
    }
    const refusal = Refusal.safeParse(parsed);
    if (refusal.success) return refused(refusal.data.error);
    const answer = schema.safeParse(parsed);
    if (!answer.success) return unavailable(`${method}: an answer of a shape Slack does not give`);
    return { ok: true, value: read(answer.data) };
  }

  const bearer = (token: string) => `Bearer ${token}`;
  const blocksOf = (blocks: SlackBlock[] | undefined) => (blocks ? { blocks } : {});

  return {
    oauthAccess: ({ clientId, clientSecret, code, redirectUri }) =>
      ask(
        'oauth.v2.access',
        {
          // Slack prefers the app's credentials as HTTP Basic auth.
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          body: form({ code, redirect_uri: redirectUri }),
        },
        OAuthAccess,
        (answer) => ({
          botToken: answer.access_token,
          tokenType: answer.token_type,
          scopes: answer.scope.split(',').filter((scope) => scope !== ''),
          appId: answer.app_id,
          botUserId: answer.bot_user_id,
          team: { id: answer.team.id, name: answer.team.name },
          enterpriseInstall: answer.is_enterprise_install,
        }),
      ),

    authRevoke: (token) =>
      ask(
        'auth.revoke',
        { authorization: bearer(token), body: form({}) },
        AuthRevoke,
        (answer) => ({ revoked: answer.revoked }),
      ),

    authTest: (token) =>
      ask('auth.test', { authorization: bearer(token), body: form({}) }, AuthTest, (answer) => ({
        teamId: answer.team_id,
        team: answer.team,
        userId: answer.user_id,
        user: answer.user,
        botId: answer.bot_id ?? null,
      })),

    postMessage: (token, message) =>
      ask(
        'chat.postMessage',
        {
          authorization: bearer(token),
          body: {
            channel: message.channel,
            text: message.text,
            ...blocksOf(message.blocks),
            ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
          },
        },
        PostMessage,
        (answer) => ({ channel: answer.channel, ts: answer.ts }),
      ),

    postEphemeral: (token, message) =>
      ask(
        'chat.postEphemeral',
        {
          authorization: bearer(token),
          body: {
            channel: message.channel,
            user: message.user,
            text: message.text,
            ...blocksOf(message.blocks),
            ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
          },
        },
        PostEphemeral,
        (answer) => ({ messageTs: answer.message_ts }),
      ),

    addReaction: (token, reaction) =>
      ask(
        'reactions.add',
        {
          authorization: bearer(token),
          body: { channel: reaction.channel, timestamp: reaction.timestamp, name: reaction.name },
        },
        Done,
        () => null,
      ),

    getPermalink: (token, message) =>
      ask(
        'chat.getPermalink',
        {
          authorization: bearer(token),
          body: form({ channel: message.channel, message_ts: message.messageTs }),
        },
        Permalink,
        (answer) => ({ permalink: answer.permalink }),
      ),
  };
}

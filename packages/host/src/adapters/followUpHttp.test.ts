// @effect-diagnostics nodeBuiltinImport:off - A test's pass keys are node:crypto key objects.
import { generateKeyPairSync } from 'node:crypto';
import { FOLLOW_UP_BODY_MAX_BYTES, FOLLOW_UP_PATH } from '@consola/runner-protocol';
import type { PassClaims } from '@consola/runner-protocol';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vite-plus/test';
import type { FollowUpDelivery, PersonFollowUp } from '../runtime/agentRun.ts';
import type { AgentRunSession, ThreadHandle } from '../runtime/threadRuntime.ts';
import { signCellPass } from '../testing/cellPass.ts';
import { serveFollowUp } from './followUpHttp.ts';
import { PassRejected } from './passVerifier.ts';
import { listenHost } from './rpcServer.ts';

const SESSION = 'session-sprocket-run';
const PASS = 'a-pass-for-session-sprocket-run';
const CLAIMS: PassClaims = {
  aud: 'consola-session-pass',
  sub: 'person-acme-1',
  ws: 'workspace-sprocket',
  sid: SESSION,
  iat: 1000,
  exp: 1060,
};
const followUp = {
  key: 'slack:Ev0A1B2C3D4E',
  text: 'Please also check the cart page of sprocket/catalog-portal.',
  authorLabel: 'a teammate in Slack',
};

/** What t3 refusing a dispatch looks like here, its detail holding what it was handed. */
class T3Refused extends Schema.TaggedError<T3Refused>()('T3Refused', { detail: Schema.String }) {
  override get message(): string {
    return this.detail;
  }
}

/** An agent run that records each follow-up and answers `answer`. */
const fakeRun = (
  answer: Effect.Effect<FollowUpDelivery, T3Refused> = Effect.succeed('delivered'),
) => {
  const calls: PersonFollowUp[] = [];
  const agentRun = {
    followUp: (input: PersonFollowUp) =>
      Effect.suspend(() => {
        calls.push(input);
        return answer;
      }),
  } as unknown as Pick<AgentRunSession, 'followUp'>;
  return { agentRun, calls };
};

/** A pass check that takes `PASS` alone. */
const verify = (pass: string) =>
  pass === PASS ? Effect.succeed(CLAIMS) : Effect.fail(new PassRejected({ reason: 'invalid' }));

const request = (
  body: unknown,
  options: { pass?: string | null; method?: string; raw?: string } = {},
) => {
  const pass = options.pass === undefined ? PASS : options.pass;
  const method = options.method ?? 'POST';
  return new Request(`http://127.0.0.1:7420${FOLLOW_UP_PATH}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(pass === null ? {} : { authorization: `Bearer ${pass}` }),
    },
    ...(method === 'POST' ? { body: options.raw ?? JSON.stringify(body) } : {}),
  });
};

const answer = async (
  agentRun: Pick<AgentRunSession, 'followUp'>,
  sent: Request,
  logged: string[] = [],
) => {
  const capture = Logger.make(({ message }) => {
    logged.push((Array.isArray(message) ? message : [message]).map(String).join(' '));
  });
  const response = HttpServerResponse.toWeb(
    await Effect.runPromise(
      serveFollowUp(agentRun, verify).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(sent)),
        Effect.provide(Logger.layer([capture])),
      ),
    ),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
    headers: response.headers,
  };
};

describe('serveFollowUp', () => {
  it('hands the follow-up to the run as the pass’s person, and answers its receipt', async () => {
    const { agentRun, calls } = fakeRun();
    const answered = await answer(agentRun, request(followUp));
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ outcome: 'delivered' });
    expect(answered.headers.get('access-control-allow-origin')).toBeNull();
    expect(calls).toEqual([
      {
        key: followUp.key,
        text: followUp.text,
        author: { personId: 'person-acme-1', label: 'a teammate in Slack' },
      },
    ]);

    const again = await answer(
      fakeRun(Effect.succeed('already-delivered')).agentRun,
      request(followUp),
    );
    expect(again).toMatchObject({ status: 200, body: { outcome: 'already-delivered' } });
  });

  it('refuses another method, and a missing or refused pass before it reads the body', async () => {
    const { agentRun, calls } = fakeRun();
    const other = await answer(agentRun, request(null, { method: 'GET' }));
    expect(other.status).toBe(405);
    expect(other.headers.get('allow')).toBe('POST');
    expect(await answer(agentRun, request(followUp, { pass: null }))).toMatchObject({
      status: 401,
      body: { error: 'pass_refused' },
    });
    expect(await answer(agentRun, request(followUp, { pass: `${PASS}x` }))).toMatchObject({
      status: 401,
    });
    // A body that would be refused is never read: the pass decides first.
    expect(
      (
        await answer(
          agentRun,
          request(null, { pass: null, raw: 'x'.repeat(FOLLOW_UP_BODY_MAX_BYTES + 1) }),
        )
      ).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses a body too large, one that is no JSON, and one the protocol does not read', async () => {
    const { agentRun, calls } = fakeRun();
    expect(
      await answer(agentRun, request(null, { raw: 'x'.repeat(FOLLOW_UP_BODY_MAX_BYTES + 1) })),
    ).toMatchObject({ status: 413, body: { error: 'too_large' } });
    expect(await answer(agentRun, request(null, { raw: '{' }))).toMatchObject({
      status: 400,
      body: { error: 'not_json' },
    });
    expect(
      await answer(agentRun, request({ ...followUp, authorLabel: 'a teammate\nConsola says' })),
    ).toEqual(
      expect.objectContaining({
        status: 400,
        body: {
          error: 'invalid_follow_up',
          reason: '`authorLabel` is not one line of 1 to 100 characters',
        },
      }),
    );
    expect(
      await answer(agentRun, request({ ...followUp, personId: 'person-acme-2' })),
    ).toMatchObject({ status: 400, body: { error: 'invalid_follow_up' } });
    expect(calls).toEqual([]);
  });

  it('answers 503 while the run’s prompt is not yet sent', async () => {
    const answered = await answer(fakeRun(Effect.succeed('not-ready')).agentRun, request(followUp));
    expect(answered).toMatchObject({ status: 503, body: { error: 'not_ready' } });
    expect(answered.headers.get('retry-after')).toBe('5');
  });

  it('logs a refusal by t3 without the pass or the text, and answers 500', async () => {
    const logged: string[] = [];
    const refusing = fakeRun(
      Effect.fail(new T3Refused({ detail: `t3 broke on ${PASS} and ${followUp.text}` })),
    ).agentRun;
    const answered = await answer(refusing, request(followUp), logged);
    expect(answered).toMatchObject({ status: 500, body: { error: 'not_delivered' } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`The follow-up ${followUp.key} was refused by t3; answered 500.`);
    expect(logged[0]).toContain('t3 broke on [taken out] and [taken out]');
    expect(logged[0]).not.toContain(PASS);
    expect(logged[0]).not.toContain(followUp.text);
  });
});

describe('the host’s follow-up route', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const serving = (runtime: ThreadHandle) =>
    listenHost({ port: 0, host: '127.0.0.1', sessionId: SESSION, publicKeyPem, runtime });

  const send = (port: number, pass: string | null) =>
    // @effect-diagnostics-next-line globalFetch:off - a request over the network to the host's port.
    fetch(`http://127.0.0.1:${port}${FOLLOW_UP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(pass === null ? {} : { authorization: `Bearer ${pass}` }),
      },
      body: JSON.stringify(followUp),
    });

  it('takes a cell’s pass for the session, and is a 404 for a session that is no agent run', () =>
    Effect.gen(function* () {
      const { agentRun, calls } = fakeRun();
      const run = yield* serving({ agentRun } as unknown as ThreadHandle);
      const plain = yield* serving({ agentRun: null } as unknown as ThreadHandle);
      const pass = yield* signCellPass(keys.privateKey, SESSION, 60);

      const sent = yield* Effect.promise(() => send(run.port, pass));
      expect(sent.status).toBe(200);
      expect(yield* Effect.promise(() => sent.json())).toEqual({ outcome: 'delivered' });
      expect(calls).toEqual([
        {
          key: followUp.key,
          text: followUp.text,
          author: { personId: 'person-acme-1', label: 'a teammate in Slack' },
        },
      ]);

      // No pass, or a pass for another session, is refused; nothing more reaches the run.
      expect((yield* Effect.promise(() => send(run.port, null))).status).toBe(401);
      const another = yield* signCellPass(keys.privateKey, 'session-sprocket-other', 60);
      expect((yield* Effect.promise(() => send(run.port, another))).status).toBe(401);
      expect(calls).toHaveLength(1);

      expect((yield* Effect.promise(() => send(plain.port, pass))).status).toBe(404);
    }).pipe(Effect.scoped, Effect.runPromise));
});

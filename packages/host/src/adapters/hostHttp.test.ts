import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Logger from 'effect/Logger';
import { describe, expect, it } from 'vite-plus/test';
import { type HostHttp, RPC_TICKET_PATH, serveHostHttp } from './hostHttp.ts';

const PASS = 'a-pass-for-session-sprocket';

/** A host whose pass check itself breaks, quoting the pass it was handed. */
const brokenHost: HostHttp = {
  environment: {} as HostHttp['environment'],
  auth: {} as HostHttp['auth'],
  verify: (pass) => Effect.die(new Error(`the verifier broke on ${pass}`)),
  issueTicket: () => Effect.die(new Error('never reached')),
};

describe('serveHostHttp', () => {
  it('logs a failure of its own, without the pass, and answers 500', async () => {
    const logged: string[] = [];
    const capture = Logger.make(({ message }) => {
      logged.push((Array.isArray(message) ? message : [message]).map(String).join(' '));
    });
    const request = HttpServerRequest.fromWeb(
      new Request(`http://127.0.0.1:7420${RPC_TICKET_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PASS}` },
      }),
    );

    const response = await Effect.runPromise(
      serveHostHttp(brokenHost, RPC_TICKET_PATH).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(Logger.layer([capture])),
      ),
    );

    expect(HttpServerResponse.toWeb(response).status).toBe(500);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`Host HTTP POST ${RPC_TICKET_PATH} failed; answered 500.`);
    expect(logged[0]).toContain('the verifier broke on [pass]');
    expect(logged[0]).not.toContain(PASS);
  });
});

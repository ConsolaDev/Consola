import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Logger from 'effect/Logger';
import { describe, expect, it } from 'vite-plus/test';
import { RPC_TICKET_PATH, serveHostHttp } from './hostHttp.ts';
import type { HostHttp } from './hostHttp.ts';
import { PassRejected } from './passVerifier.ts';

const PASS = 'a-pass-for-session-sprocket';

/** A host whose pass check itself breaks, quoting the pass it was handed. */
const brokenHost: HostHttp = {
  environment: {} as HostHttp['environment'],
  auth: {} as HostHttp['auth'],
  verify: (pass) => Effect.die(new Error(`the verifier broke on ${pass}`)),
  issueTicket: () => Effect.die(new Error('never reached')),
  runtime: {} as HostHttp['runtime'],
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
      serveHostHttp(brokenHost, new URL(`http://127.0.0.1:7420${RPC_TICKET_PATH}`)).pipe(
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

  it.each([['/api/orchestration/shell'], ['/api/orchestration/threads/session-sprocket/bounded']])(
    'reads nothing of the thread for %s until the pass is let in: a refused one is 401',
    async (path) => {
      let reads = 0;
      const read = () => {
        reads += 1;
        throw new Error('the thread was read before the pass');
      };
      const refusing: HostHttp = {
        ...brokenHost,
        verify: () => Effect.fail(new PassRejected({ reason: 'invalid' })),
        runtime: {
          snapshot: read,
          snapshotSequence: read,
          shell: { snapshot: Effect.sync(read), thread: Effect.sync(read) },
        } as unknown as HostHttp['runtime'],
      };
      const url = new URL(`http://127.0.0.1:7420${path}`);
      const request = HttpServerRequest.fromWeb(
        new Request(url, {
          headers: { authorization: `Bearer ${PASS}`, 'x-t3-orchestration-protocol': '2' },
        }),
      );

      const response = await Effect.runPromise(
        serveHostHttp(refusing, url).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        ),
      );

      expect(HttpServerResponse.toWeb(response).status).toBe(401);
      expect(reads).toBe(0);
    },
  );
});

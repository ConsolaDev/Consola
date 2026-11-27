import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FOLLOW_UP_PATH } from '@consola/runner-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostChannel } from './hostChannel.js';

const PASS = 'a-pass-for-person-1-in-session-run-1';
const SESSION = 'session-run-1';

/** Every stand-in host here is on loopback, as a local sandbox's is. */
const LOCAL = { suffixes: ['e2b.app'], local: true };
let reported: string[] = [];

/** The channel, as compose builds it, for sandboxes on this machine (or `addresses`). */
const channel = (options: { timeoutMs?: number; addresses?: typeof LOCAL } = {}) =>
  createHostChannel({
    addresses: options.addresses ?? LOCAL,
    report: (line) => reported.push(line),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

const session = (hostUrl: string) => ({ id: SESSION, hostUrl });
const followUp = {
  key: 'slack:Ev0A1B2C3D4E',
  text: 'Please also check the cart page of sprocket/catalog-portal.',
  authorLabel: 'a teammate in Slack',
};

type Heard = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

let servers: Server[] = [];
afterEach(async () => {
  reported = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  servers = [];
});

/** A stand-in for a session's host on loopback, answering each request with `answer`. */
async function host(answer: (response: ServerResponse, heard: Heard) => void) {
  const heard: Heard[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const each = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      heard.push(each);
      answer(response, each);
    });
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return { hostUrl: `http://127.0.0.1:${port}`, heard };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };

describe('createHostChannel', () => {
  it('posts the follow-up to the host’s path with the pass as bearer, and reads its receipt', async () => {
    const { hostUrl, heard } = await host(json(200, { outcome: 'delivered' }));
    expect(await channel().sendFollowUp(session(hostUrl), PASS, followUp)).toBe('delivered');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ method: 'POST', url: FOLLOW_UP_PATH });
    expect(heard[0]?.headers.authorization).toBe(`Bearer ${PASS}`);
    expect(heard[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(heard[0]?.body ?? '')).toEqual(followUp);
  });

  it('reads already-delivered', async () => {
    const { hostUrl } = await host(json(200, { outcome: 'already-delivered' }));
    expect(await channel().sendFollowUp(session(hostUrl), PASS, followUp)).toBe(
      'already-delivered',
    );
  });

  it.each([
    ['503', json(503, { error: 'not_ready' }, { 'retry-after': '5' }), 'not-ready'],
    ['401', json(401, { error: 'pass_refused' }), 'not-here'],
    ['404', (response: ServerResponse) => response.writeHead(404).end(), 'not-here'],
    ['500', json(500, { error: 'not_delivered' }), 'failed'],
    ['400', json(400, { error: 'invalid_follow_up' }), 'failed'],
    ['200 with no receipt', json(200, { outcome: 'queued' }), 'failed'],
    [
      '200 that is no JSON',
      (response: ServerResponse) => response.writeHead(200).end('delivered'),
      'failed',
    ],
    [
      '200 too long to read',
      (response: ServerResponse) => response.writeHead(200).end('x'.repeat(64 * 1024)),
      'failed',
    ],
  ] as const)('reads a host’s %s as %s', async (_, answer, expected) => {
    const { hostUrl } = await host(answer);
    expect(await channel().sendFollowUp(session(hostUrl), PASS, followUp)).toBe(expected);
  });

  it('never follows a redirect, so the pass goes to the host alone', async () => {
    const elsewhere = await host(json(200, { outcome: 'delivered' }));
    const { hostUrl } = await host((response) =>
      response.writeHead(307, { location: `${elsewhere.hostUrl}${FOLLOW_UP_PATH}` }).end(),
    );
    expect(await channel().sendFollowUp(session(hostUrl), PASS, followUp)).toBe('failed');
    expect(elsewhere.heard).toEqual([]);
  });

  it('gives up on a host that does not answer in time, and on one nobody listens at', async () => {
    const { hostUrl } = await host(() => {
      // Never answers.
    });
    expect(await channel({ timeoutMs: 200 }).sendFollowUp(session(hostUrl), PASS, followUp)).toBe(
      'failed',
    );

    const closed = await host(json(200, { outcome: 'delivered' }));
    await new Promise<void>((done) => {
      const server = servers.pop();
      server?.closeAllConnections();
      server?.close(() => done());
    });
    expect(await channel().sendFollowUp(session(closed.hostUrl), PASS, followUp)).toBe('failed');
  });

  it('sends nothing to an address the deployment does not call, and reports the session alone', async () => {
    const { hostUrl, heard } = await host(json(200, { outcome: 'delivered' }));
    // Loopback is a session's host only while the runner's sandboxes run on this machine.
    const remote = { suffixes: ['e2b.app'], local: false };
    expect(
      await channel({ addresses: remote }).sendFollowUp(session(hostUrl), PASS, followUp),
    ).toBe('not-allowed');
    for (const elsewhere of [
      'https://metadata.internal.example',
      'https://10.0.0.7',
      'https://7420-sbx-acme-1.e2b.app.example.com',
    ]) {
      expect(await channel().sendFollowUp(session(elsewhere), PASS, followUp)).toBe('not-allowed');
    }
    expect(heard).toEqual([]);
    expect(reported).toHaveLength(4);
    for (const line of reported) {
      expect(line).toBe(
        `Session ${SESSION}: its host's address is not one this deployment calls (SANDBOX_HOST_SUFFIXES, LOCAL_SANDBOXES), so no follow-up was sent.`,
      );
    }
  });
});

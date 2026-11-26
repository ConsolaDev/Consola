import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { OUTBOX_DELIVERY_MEDIA_TYPE, OUTBOX_DELIVERY_PATH } from '@consola/cloud-contract';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createCellDelivery } from './cellDelivery.js';

const ACME_CELL = 'http://127.0.0.1:3101';
const SIGNED = 'eyJhbGciOiJFZERTQSJ9.eyJ3b3Jrc3BhY2VJZCI6ImFjbWUifQ.c2lnbmF0dXJl';

type Sent = { url: string; method: string; headers: Headers; body: string; redirect: string };

/** A `fetch` that answers every request with `answer`, keeping what was sent. */
function answering(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      redirect: request.redirect,
    });
    return answer();
  };
  return { fetch, sent };
}

describe('delivering to a cell', () => {
  it('posts the signed message alone to the cell’s outbox path, as application/jose', async () => {
    const { fetch, sent } = answering(() => Response.json({ applied: 1 }));
    const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch });

    expect(await cells.deliver('eu', SIGNED)).toEqual({ kind: 'confirmed', status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `${ACME_CELL}${OUTBOX_DELIVERY_PATH}`,
      method: 'POST',
      body: SIGNED,
      redirect: 'manual',
    });
    expect(OUTBOX_DELIVERY_PATH).toBe('/api/outbox');
    expect(sent[0]?.headers.get('content-type')).toBe(OUTBOX_DELIVERY_MEDIA_TYPE);
    expect(OUTBOX_DELIVERY_MEDIA_TYPE).toBe('application/jose');
    // No cell token, no cookie: the signature is what says it is cloud-global's.
    expect(sent[0]?.headers.get('authorization')).toBeNull();
  });

  it('takes any 2xx as confirmation', async () => {
    for (const status of [200, 201, 202, 204]) {
      const { fetch } = answering(() => new Response(null, { status }));
      const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch });
      expect(await cells.deliver('eu', SIGNED)).toEqual({ kind: 'confirmed', status });
    }
  });

  it.each([
    [400, 'status 400 (unreadable)'],
    [401, 'status 401 (unsigned)'],
    [421, 'status 421 (otherRegion)'],
    [500, 'status 500'],
    [503, 'status 503 (unavailable)'],
    [302, 'status 302'],
  ])(
    'fails on %s, naming the status and the contract’s answer, never the body',
    async (status, error) => {
      const { fetch } = answering(() =>
        Response.json({ error: 'the cell said something secret-ish' }, { status }),
      );
      const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch });
      expect(await cells.deliver('eu', SIGNED)).toEqual({ kind: 'failed', error });
    },
  );

  it.each([
    [{ nextSequence: 3 }, 'status 409 (outOfOrder): the cell applies sequence 3 next'],
    [{ nextSequence: 0 }, 'status 409 (outOfOrder): `nextSequence` is not a whole number from 1'],
    [
      { nextSequence: 3, why: 'x' },
      'status 409 (outOfOrder): the answer has `why`, which the contract does not name',
    ],
    ['not json', 'status 409 (outOfOrder): the answer is not an object'],
  ])('reads a 409 with the contract’s reader: %j', async (body, error) => {
    const { fetch } = answering(
      () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 409 }),
    );
    const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch });
    expect(await cells.deliver('eu', SIGNED)).toEqual({ kind: 'failed', error });
  });

  it('fails on a connection that cannot be made, naming its code alone', async () => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:3101 ${SIGNED}`), {
      code: 'ECONNREFUSED',
    });
    const cells = createCellDelivery({
      cellUrls: { eu: ACME_CELL },
      fetch: async () => {
        throw new TypeError('fetch failed', { cause });
      },
    });
    expect(await cells.deliver('eu', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no connection (ECONNREFUSED)',
    });
  });

  it('fails on a connection error with no code by its name', async () => {
    const cells = createCellDelivery({
      cellUrls: { eu: ACME_CELL },
      fetch: async () => {
        throw new TypeError(`fetch failed for ${SIGNED}`);
      },
    });
    expect(await cells.deliver('eu', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no connection (TypeError)',
    });
  });

  /** A `fetch` that never answers, until its request is abandoned. */
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('fails when the cell does not answer in time', async () => {
    const cells = createCellDelivery({
      cellUrls: { eu: ACME_CELL },
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(await cells.deliver('eu', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no answer within 20 ms',
    });
  });

  it('abandons a delivery when told to stop, and says it was stopped', async () => {
    const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch: hanging });
    const stopping = new AbortController();
    const delivering = cells.deliver('eu', SIGNED, stopping.signal);
    stopping.abort();
    expect(await delivering).toEqual({ kind: 'stopped' });
  });

  it('reaches only the regions it has a cell for', async () => {
    const { fetch, sent } = answering(() => new Response(null));
    const cells = createCellDelivery({ cellUrls: { eu: ACME_CELL }, fetch });
    expect(cells.reaches('eu')).toBe(true);
    expect(cells.reaches('us')).toBe(false);
    expect(await cells.deliver('us', SIGNED)).toEqual({ kind: 'failed', error: 'no cell for us' });
    expect(sent).toEqual([]);
  });
});

describe('delivering to a cell over a socket', () => {
  let close: () => Promise<void> = async () => {};

  afterEach(async () => {
    await close();
  });

  it('reaches a real server with the global fetch', async () => {
    const received: Array<{ type: string | null; body: string }> = [];
    const cell = new Hono().post(OUTBOX_DELIVERY_PATH, async (c) => {
      received.push({ type: c.req.header('content-type') ?? null, body: await c.req.text() });
      return c.json({ applied: 1 });
    });
    const server = serve({ fetch: cell.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;

    const cells = createCellDelivery({ cellUrls: { us: `http://127.0.0.1:${port}` } });

    expect(await cells.deliver('us', SIGNED)).toEqual({ kind: 'confirmed', status: 200 });
    expect(received).toEqual([{ type: OUTBOX_DELIVERY_MEDIA_TYPE, body: SIGNED }]);
  });

  it('fails with the code Node gives when nothing listens', async () => {
    // A port just closed, so nothing listens on it.
    const server = serve({ fetch: () => new Response(null), hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(() => resolve(null)));

    const cells = createCellDelivery({ cellUrls: { eu: `http://127.0.0.1:${port}` } });
    expect(await cells.deliver('eu', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no connection (ECONNREFUSED)',
    });
  });
});

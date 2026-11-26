import {
  GITHUB_EVENT_ANSWER,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
} from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { createCellEventDelivery } from './eventDelivery.js';

const SPROCKET_CELL = 'http://127.0.0.1:3102';
const SIGNED = 'eyJhbGciOiJFZERTQSJ9.eyJldmVudCI6InB1bGxfcmVxdWVzdCJ9.c2lnbmF0dXJl';

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

describe('passing an event on to a cell', () => {
  it("posts the signed event alone to the cell's events path, as application/jose", async () => {
    const { fetch, sent } = answering(() => Response.json({ recorded: true }, { status: 201 }));
    const cells = createCellEventDelivery({ cellUrls: { us: SPROCKET_CELL }, fetch });

    expect(await cells.pass('us', SIGNED)).toEqual({ kind: 'recorded' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `${SPROCKET_CELL}${GITHUB_EVENT_DELIVERY_PATH}`,
      method: 'POST',
      body: SIGNED,
      redirect: 'manual',
    });
    expect(sent[0]?.headers.get('content-type')).toBe(GITHUB_EVENT_DELIVERY_MEDIA_TYPE);
    expect(sent[0]?.headers.get('authorization')).toBeNull();
  });

  it('tells an event the cell had already from one it recorded now', async () => {
    const { fetch } = answering(() => Response.json({ recorded: true }, { status: 200 }));
    const cells = createCellEventDelivery({ cellUrls: { us: SPROCKET_CELL }, fetch });
    expect(await cells.pass('us', SIGNED)).toEqual({ kind: 'recorded-before' });
  });

  it.each([
    [GITHUB_EVENT_ANSWER.unreadable, 'status 400 (unreadable)'],
    [GITHUB_EVENT_ANSWER.unsigned, 'status 401 (unsigned)'],
    [GITHUB_EVENT_ANSWER.workspacePending, 'status 409 (workspacePending)'],
    [GITHUB_EVENT_ANSWER.otherRegion, 'status 421 (otherRegion)'],
    [GITHUB_EVENT_ANSWER.unavailable, 'status 503 (unavailable)'],
    [500, 'status 500'],
    [302, 'status 302'],
  ])(
    'fails on %s, naming the status and the contract’s answer, never the body',
    async (status, error) => {
      const { fetch } = answering(() =>
        Response.json({ error: 'Customers in Lyon asked.' }, { status }),
      );
      const cells = createCellEventDelivery({ cellUrls: { us: SPROCKET_CELL }, fetch });
      expect(await cells.pass('us', SIGNED)).toEqual({ kind: 'failed', error });
    },
  );

  it('fails on a connection that cannot be made, naming its code alone', async () => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:3102 ${SIGNED}`), {
      code: 'ECONNREFUSED',
    });
    const cells = createCellEventDelivery({
      cellUrls: { us: SPROCKET_CELL },
      fetch: async () => {
        throw new TypeError('fetch failed', { cause });
      },
    });
    expect(await cells.pass('us', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no connection (ECONNREFUSED)',
    });
  });

  it('fails when the cell does not answer in time, inside the ten seconds GitHub waits', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const cells = createCellEventDelivery({
      cellUrls: { us: SPROCKET_CELL },
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(await cells.pass('us', SIGNED)).toEqual({
      kind: 'failed',
      error: 'no answer within 20 ms',
    });
  });

  it('reaches only the regions it has a cell for', async () => {
    const { fetch, sent } = answering(() => new Response(null, { status: 201 }));
    const cells = createCellEventDelivery({ cellUrls: { us: SPROCKET_CELL }, fetch });
    expect(cells.reaches('us')).toBe(true);
    expect(cells.reaches('eu')).toBe(false);
    expect(await cells.pass('eu', SIGNED)).toEqual({ kind: 'failed', error: 'no cell for eu' });
    expect(sent).toEqual([]);
  });
});

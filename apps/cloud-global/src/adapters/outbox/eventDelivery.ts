import {
  GITHUB_EVENT_ANSWER,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
} from '@consola/cloud-contract';
import type { Region } from '@consola/cloud-contract';
import type { CellEventAnswer, CellEvents } from '../../application/ports.js';
import { connectionFailure } from './cellDelivery.js';

/**
 * How long a cell has to answer an event. GitHub waits ten seconds for the webhook's answer, and
 * this one waits on the cell's, so the cell gets less, and GitHub still hears why it failed.
 */
export const EVENT_DELIVERY_TIMEOUT_MS = 8_000;

/** Each answer the contract names, by its status, for the words a failure is told in. */
const ANSWER_NAMES = new Map<number, string>(
  Object.entries(GITHUB_EVENT_ANSWER).map(([name, status]) => [status, name]),
);

const statusWords = (status: number) => {
  const name = ANSWER_NAMES.get(status);
  return name ? `status ${status} (${name})` : `status ${status}`;
};

/**
 * Passes GitHub's events, signed, on to each region's cell (`cellUrls`, origins), one event a
 * request: `POST <origin>GITHUB_EVENT_DELIVERY_PATH`, its body the compact JWS, sent as
 * `GITHUB_EVENT_DELIVERY_MEDIA_TYPE`. `recordedBefore` (200) says the cell had the delivery
 * already; any other 2xx that it recorded it now. Every other status, a redirect included (never
 * followed), no connection and no answer within `timeoutMs` fail, in words that name a status and
 * the contract's answer: never the body sent, nor any other body. Nothing is tried again here:
 * the webhook's answer says it failed, and GitHub's Redeliver sends it again.
 *
 * It sits beside the outbox's delivery because it is the same kind of request to the same cells,
 * and shares how a failed connection is named (`connectionFailure`).
 */
export function createCellEventDelivery(deps: {
  cellUrls: Partial<Record<Region, string>>;
  timeoutMs?: number;
  /** Stands in for the global `fetch`, which is looked up on each delivery when this is unset. */
  fetch?: typeof fetch;
}): CellEvents {
  const { cellUrls, timeoutMs = EVENT_DELIVERY_TIMEOUT_MS } = deps;
  const send: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    reaches: (region) => cellUrls[region] !== undefined,

    async pass(region, signedEvent): Promise<CellEventAnswer> {
      const origin = cellUrls[region];
      if (origin === undefined) return { kind: 'failed', error: `no cell for ${region}` };
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await send(`${origin}${GITHUB_EVENT_DELIVERY_PATH}`, {
          method: 'POST',
          headers: { 'content-type': GITHUB_EVENT_DELIVERY_MEDIA_TYPE },
          body: signedEvent,
          redirect: 'manual',
          signal: timeout,
        });
        await response.body?.cancel();
        if (response.status === GITHUB_EVENT_ANSWER.recordedBefore) {
          return { kind: 'recorded-before' };
        }
        if (response.ok) return { kind: 'recorded' };
        return { kind: 'failed', error: statusWords(response.status) };
      } catch (error) {
        if (timeout.aborted) return { kind: 'failed', error: `no answer within ${timeoutMs} ms` };
        return { kind: 'failed', error: `no connection (${connectionFailure(error)})` };
      }
    },
  };
}

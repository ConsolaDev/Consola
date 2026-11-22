import {
  OUTBOX_ANSWER,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  readOutOfOrderAnswer,
  type Region,
} from '@consola/cloud-contract';
import type { CellDelivery, DeliveryAnswer } from '../../application/ports.js';

/** How long a cell has to answer a delivery before it counts as failed. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Each answer the contract names, by its status, for the words a failure is recorded in. */
const ANSWER_NAMES = new Map<number, string>(
  Object.entries(OUTBOX_ANSWER).map(([name, status]) => [status, name]),
);

const statusWords = (status: number) => {
  const name = ANSWER_NAMES.get(status);
  return name ? `status ${status} (${name})` : `status ${status}`;
};

/**
 * What a failed connection was, as the code Node gives it (`ECONNREFUSED`), never its message:
 * it is recorded and logged, and only ids and statuses are.
 */
function connectionFailure(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
    current = current.cause;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/** What a 409 says: the sequence the cell applies next, or why its answer does not read. */
async function outOfOrder(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  const read = readOutOfOrderAnswer(body);
  return read.ok
    ? `${statusWords(response.status)}: the cell applies sequence ${read.value.nextSequence} next`
    : `${statusWords(response.status)}: ${read.reason}`;
}

/**
 * Delivers signed outbox messages to each region's cell (`cellUrls`, origins), one message a
 * request: `POST <origin>OUTBOX_DELIVERY_PATH`, its body the compact JWS, sent as
 * `OUTBOX_DELIVERY_MEDIA_TYPE`. Only a 2xx confirms. Every other status, a redirect included
 * (it is never followed, so a message goes to its cell alone), no connection, and no answer
 * within `timeoutMs` fail, in words that name a status, the contract's answer and, for a 409,
 * the sequence the cell asks for: never the body sent, nor any other body.
 */
export function createCellDelivery(deps: {
  cellUrls: Partial<Record<Region, string>>;
  timeoutMs?: number;
  /** Stands in for the global `fetch`, which is looked up on each delivery when this is unset. */
  fetch?: typeof fetch;
}): CellDelivery {
  const { cellUrls, timeoutMs = DELIVERY_TIMEOUT_MS } = deps;
  const send: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    reaches: (region) => cellUrls[region] !== undefined,

    async deliver(region, signedMessage, signal): Promise<DeliveryAnswer> {
      const origin = cellUrls[region];
      if (origin === undefined) return { kind: 'failed', error: `no cell for ${region}` };
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await send(`${origin}${OUTBOX_DELIVERY_PATH}`, {
          method: 'POST',
          headers: { 'content-type': OUTBOX_DELIVERY_MEDIA_TYPE },
          body: signedMessage,
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.ok) {
          await response.body?.cancel();
          return { kind: 'confirmed', status: response.status };
        }
        if (response.status === OUTBOX_ANSWER.outOfOrder) {
          return { kind: 'failed', error: await outOfOrder(response) };
        }
        await response.body?.cancel();
        return { kind: 'failed', error: statusWords(response.status) };
      } catch (error) {
        if (signal?.aborted) return { kind: 'stopped' };
        if (timeout.aborted) return { kind: 'failed', error: `no answer within ${timeoutMs} ms` };
        return { kind: 'failed', error: `no connection (${connectionFailure(error)})` };
      }
    },
  };
}

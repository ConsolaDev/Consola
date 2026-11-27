import { FOLLOW_UP_PATH, readFollowUpReceipt } from '@consola/runner-protocol';
import type { HostChannel, HostFollowUpAnswer } from '../../application/ports.js';

/**
 * How long the app waits for a session's host to answer a follow-up, in milliseconds: past the
 * host's own wait for its run's first message (5 s), so its `503` arrives.
 */
export const HOST_CALL_TIMEOUT_MS = 15_000;

/** The most of a host's answer the app reads, in bytes: a receipt is a few dozen. */
const ANSWER_MAX_BYTES = 4096;

/** The answer's text, or null when it is longer than `max` bytes or cannot be read. */
async function boundedText(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}

/** What a `200` says: the host's receipt, or `failed` for anything else. */
async function receiptOf(response: Response): Promise<HostFollowUpAnswer> {
  const text = await boundedText(response, ANSWER_MAX_BYTES);
  if (text === null) return 'failed';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'failed';
  }
  const receipt = readFollowUpReceipt(value);
  return receipt.ok ? receipt.value.outcome : 'failed';
}

/**
 * The sessions' hosts over HTTP (`fetch`): a follow-up is `POST <hostUrl>` + `FOLLOW_UP_PATH`,
 * with the pass as bearer and the protocol's body as JSON, and its answer read by the protocol's
 * reader (`@consola/runner-protocol`, "Follow-ups").
 *
 * The address is the one the session's runner reported, an origin the protocol checked
 * (`isHostUrl`), so the app reaches it as the person's browser does. A redirect is never followed,
 * so the pass goes to that address alone. The call gives up after `timeoutMs`, and reads at most
 * a few kilobytes of the answer. Nothing is logged: not the pass, not the text.
 */
export function createHostChannel(options: { timeoutMs?: number } = {}): HostChannel {
  const timeoutMs = options.timeoutMs ?? HOST_CALL_TIMEOUT_MS;
  return {
    async sendFollowUp(hostUrl, pass, followUp) {
      let response: Response;
      try {
        response = await fetch(new URL(FOLLOW_UP_PATH, hostUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${pass}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(followUp),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return 'failed';
      }
      if (response.status === 200) return receiptOf(response);
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 503) return 'not-ready';
      // The pass was refused (the address serves another session now), or no agent run is there.
      if (response.status === 401 || response.status === 404) return 'not-here';
      return 'failed';
    },
  };
}

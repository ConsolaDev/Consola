import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SlackSignatures } from '../../application/slackEventPorts.js';
import { SLACK_SIGNATURE_MAX_AGE_SECONDS } from '../../domain/slackEvents.js';

/** How Slack writes `X-Slack-Signature`: the version, then the HMAC in hex. */
const SIGNATURE = /^v0=([0-9a-f]{64})$/;
/** How Slack writes `X-Slack-Request-Timestamp`: whole seconds since the epoch. */
const TIMESTAMP = /^[0-9]{1,12}$/;

/**
 * Checks Slack's request signatures with `node:crypto`, as Slack says to: the timestamp must be
 * within five minutes of now, either way, and `X-Slack-Signature` must be `v0=` and the
 * HMAC-SHA256 of `v0:<timestamp>:<body>` under the factory's signing secret, over the body's bytes
 * as they arrived. The comparison takes the same time wherever the two differ (`timingSafeEqual`),
 * so a forger learns nothing from how long a refusal takes. Nothing here logs.
 */
export const slackSignatures: SlackSignatures = {
  verify(signingSecret, request, nowSeconds) {
    const { timestamp, signature, body } = request;
    if (timestamp === undefined || !TIMESTAMP.test(timestamp)) return 'stale';
    if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
      return 'stale';
    }
    const hex = signature === undefined ? undefined : SIGNATURE.exec(signature)?.[1];
    if (hex === undefined) return 'mismatch';
    const expected = createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:`, 'utf8')
      .update(body)
      .digest();
    return timingSafeEqual(Buffer.from(hex, 'hex'), expected) ? 'valid' : 'mismatch';
  },
};

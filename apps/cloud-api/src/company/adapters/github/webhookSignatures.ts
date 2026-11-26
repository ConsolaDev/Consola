import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSignatures } from '../../application/ports.js';

/** How GitHub writes `X-Hub-Signature-256`: the algorithm, then the HMAC in hex. */
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Checks GitHub's webhook signatures with `node:crypto`: `X-Hub-Signature-256` must be the
 * HMAC-SHA256 of the body, byte for byte as it arrived, under the app's webhook secret. The
 * comparison takes the same time wherever the two differ (`timingSafeEqual`), so a forger learns
 * nothing from how long a refusal takes. Only the SHA-256 header counts: GitHub's older SHA-1
 * `X-Hub-Signature` is never read. The secret stays inside, and nothing here logs.
 */
export function createWebhookSignatures(secret: string): WebhookSignatures {
  return {
    verify(body, signature) {
      const hex = signature === undefined ? undefined : SIGNATURE.exec(signature)?.[1];
      if (hex === undefined) return false;
      const expected = createHmac('sha256', secret).update(body).digest();
      return timingSafeEqual(Buffer.from(hex, 'hex'), expected);
    },
  };
}

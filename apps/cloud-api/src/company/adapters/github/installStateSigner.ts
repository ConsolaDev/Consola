import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { InstallStateSigner } from '../../application/gitHubPorts.js';

/** What the state's key is derived for, so it is never the same key as anything else's. */
const KEY_PURPOSE = 'consola cloud: the state of a GitHub Connect';

/** Longer than any state this signs, so a long string is refused before it is read. */
const MAX_LENGTH = 1024;

const STATE = z.strictObject({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  expiresAt: z.number().int(),
});

/**
 * Signs a Connect's state with HMAC-SHA256: the state as JSON in base64url, a dot, and its MAC.
 * The key is derived from `secret` (the service's own, `BETTER_AUTH_SECRET`) with HKDF, for this
 * purpose only. Reading checks the MAC before anything else, in constant time, and then the
 * state's exact shape. Whether it is still in time is the domain's to say
 * (`checkInstallState`).
 */
export function createInstallStateSigner(secret: string): InstallStateSigner {
  const key = Buffer.from(hkdfSync('sha256', secret, '', KEY_PURPOSE, 32));
  const macOf = (body: string) => createHmac('sha256', key).update(body).digest();

  return {
    sign(state) {
      const body = Buffer.from(JSON.stringify(state)).toString('base64url');
      return `${body}.${macOf(body).toString('base64url')}`;
    },

    read(token) {
      if (token.length > MAX_LENGTH) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [body = '', mac = ''] = parts;
      const given = Buffer.from(mac, 'base64url');
      const expected = macOf(body);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      const state = STATE.safeParse(parsed);
      return state.success ? state.data : null;
    },
  };
}

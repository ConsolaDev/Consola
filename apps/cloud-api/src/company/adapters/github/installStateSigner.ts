import { z } from 'zod';
import type { InstallStateSigner } from '../../application/gitHubPorts.js';
import { createSignedTokens } from './signedTokens.js';

/** What the state's key is derived for, so it is never the same key as anything else's. */
const KEY_PURPOSE = 'consola cloud: the state of a GitHub Connect';

/** Longer than any state this signs, so a long string is refused before it is read. */
const MAX_LENGTH = 1024;

const STATE = z.strictObject({
  workspaceId: z.string().min(1),
  personId: z.string().min(1),
  sessionId: z.string().min(1),
  expiresAt: z.number().int(),
});

/**
 * Signs a Connect's state with HMAC-SHA256 (`createSignedTokens`), under a key derived from
 * `secret` (the service's own, `BETTER_AUTH_SECRET`) for this purpose only. Reading checks the
 * MAC before anything else, in constant time, and then the state's exact shape. Whether it is
 * still in time is the domain's to say (`checkInstallState`).
 */
export function createInstallStateSigner(secret: string): InstallStateSigner {
  return createSignedTokens({
    secret,
    purpose: KEY_PURPOSE,
    shape: STATE,
    maxLength: MAX_LENGTH,
  });
}

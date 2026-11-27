import { z } from 'zod';
import type { InstallChoiceSigner } from '../../application/gitHubPorts.js';
import { MAX_INSTALL_CANDIDATES } from '../../domain/connections.js';
import { createSignedTokens } from './signedTokens.js';

/**
 * What the choice's key is derived for: a purpose of its own, so a Connect's state is never read
 * as a choice, nor a choice as a state.
 */
const KEY_PURPOSE = 'consola cloud: the choice of a GitHub installation to connect';

/**
 * Longer than any choice this signs (`MAX_INSTALL_CANDIDATES` candidates with GitHub's longest
 * logins), and short enough for the address the callback sends the person to.
 */
const MAX_LENGTH = 8192;

const GITHUB_ID = z.number().int().positive();

const CHOICE = z.strictObject({
  workspaceId: z.string().min(1),
  personId: z.string().min(1),
  sessionId: z.string().min(1),
  expiresAt: z.number().int(),
  candidates: z
    .array(
      z.strictObject({
        id: GITHUB_ID,
        account: z.strictObject({
          id: GITHUB_ID,
          login: z.string().min(1).max(100),
          type: z.enum(['Organization', 'User']),
        }),
        heldElsewhere: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_INSTALL_CANDIDATES),
});

/**
 * Signs the choice of installations a person who signed in to GitHub may connect, with
 * HMAC-SHA256 (`createSignedTokens`), under a key derived from `secret` (`BETTER_AUTH_SECRET`)
 * for this purpose only, never the state's. Reading checks the MAC before anything else, in
 * constant time, and then the choice's exact shape. Whether it is this session's, in time and for
 * the workspace it has active is the domain's to say (`checkInstallChoice`).
 */
export function createInstallChoiceSigner(secret: string): InstallChoiceSigner {
  return createSignedTokens({
    secret,
    purpose: KEY_PURPOSE,
    shape: CHOICE,
    maxLength: MAX_LENGTH,
  });
}

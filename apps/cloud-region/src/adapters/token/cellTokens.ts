import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_KEYS_PATH,
  CLOCK_SKEW_SECONDS,
} from '@consola/cloud-contract';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { SignatureCheck, TokenVerifier } from '../../application/ports.js';

/**
 * Where the cell finds the public keys its tokens are signed with: `cloud-global`'s key set
 * (`cloudGlobalKeys`), or one a test hands it (`createLocalJWKSet`). Either picks the key by the
 * `kid` a token names.
 */
export type CellTokenKeys = JWTVerifyGetKey;

/**
 * `cloud-global`'s key set, at `CELL_TOKEN_KEYS_PATH` on its origin. jose keeps a copy for ten
 * minutes, fetches it again for a `kid` it has not seen (at most once every 30 seconds), and
 * never follows a redirect.
 */
export function cloudGlobalKeys(cloudGlobalUrl: string): CellTokenKeys {
  return createRemoteJWKSet(new URL(CELL_TOKEN_KEYS_PATH, cloudGlobalUrl));
}

/** The key set failed, not the token: it could not be fetched, or was not a key set. */
class KeysUnavailable extends Error {}

/** A token that names no key. Every cell token names its key's `kid` in its header. */
class NoKeyNamed extends Error {}

/** An error's message and its causes', one line each, joined: what went wrong, for the log. */
function describe(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const line = current.message.split('\n')[0]?.trim();
    if (line) messages.push(line);
    current = current.cause;
  }
  return messages.join(': ') || 'an unexpected error';
}

/**
 * Checks cell tokens with jose against `keys`, as the contract has it: `CELL_TOKEN_ALGORITHM`
 * alone, `CELL_TOKEN_AUDIENCE`, and `CLOCK_SKEW_SECONDS` between the clocks, at the moment it is
 * given, so jose and the contract's reader judge the times at the same instant. A token that
 * names no `kid` is refused before any key is looked for.
 *
 * When the keys cannot be had, the token is refused as `keys-unavailable`, never let through,
 * and `report` hears why (never the token). Only a key set that answered but holds no key the
 * token names counts against the token.
 */
export function createJoseTokenVerifier(
  keys: CellTokenKeys,
  report: (line: string) => void = console.error,
): TokenVerifier {
  const keyFor: JWTVerifyGetKey = async (header, token) => {
    if (typeof header.kid !== 'string' || header.kid === '') throw new NoKeyNamed();
    try {
      return await keys(header, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) throw error;
      throw new KeysUnavailable(describe(error), { cause: error });
    }
  };

  return {
    async verify(token, nowSeconds): Promise<SignatureCheck> {
      try {
        const { payload } = await jwtVerify(token, keyFor, {
          algorithms: [CELL_TOKEN_ALGORITHM],
          audience: CELL_TOKEN_AUDIENCE,
          clockTolerance: CLOCK_SKEW_SECONDS,
          currentDate: new Date(nowSeconds * 1000),
        });
        return { kind: 'verified', payload };
      } catch (error) {
        if (!(error instanceof KeysUnavailable)) return { kind: 'invalid' };
        report(`The cell could not get cloud-global's cell token keys: ${error.message}`);
        return { kind: 'keys-unavailable' };
      }
    },
  };
}

import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_KEYS_PATH,
  CLOCK_SKEW_SECONDS,
  OUTBOX_MESSAGE_TYPE,
} from '@consola/cloud-contract';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { SignatureCheck, TokenVerifier } from '../../application/ports.js';

/**
 * Where the cell finds the public keys its tokens and outbox deliveries are signed with (one key
 * signs both): `cloud-global`'s key set (`cloudGlobalKeys`), or one a test hands it
 * (`createLocalJWKSet`). Either picks the key by the `kid` a header names.
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
export class KeysUnavailable extends Error {}

/**
 * A token or a delivery that names no key. Everything `cloud-global` signs names its key's `kid`
 * in its header.
 */
export class NoKeyNamed extends Error {}

/** An outbox delivery presented as a token. */
class NotAToken extends Error {}

/** What the cell logs when `cloud-global`'s keys cannot be had: why, never what it was checking. */
export const keysUnavailableLine = (error: KeysUnavailable): string =>
  `The cell could not get cloud-global's cell token keys: ${error.message}`;

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
 * The key from `keys` that a header names by its `kid`. A header that names none is refused
 * (`NoKeyNamed`) before any key is looked for. When the key set itself fails, the failure is
 * `KeysUnavailable`; only a set that answered but holds no key the header names
 * (`JWKSNoMatchingKey`) counts against what is being checked.
 */
export function keyNamedBy(keys: CellTokenKeys): CellTokenKeys {
  return async (header, token) => {
    if (typeof header.kid !== 'string' || header.kid === '') throw new NoKeyNamed();
    try {
      return await keys(header, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) throw error;
      throw new KeysUnavailable(describe(error), { cause: error });
    }
  };
}

/**
 * Checks cell tokens with jose against `keys`, as the contract has it: `CELL_TOKEN_ALGORITHM`
 * alone, `CELL_TOKEN_AUDIENCE`, and `CLOCK_SKEW_SECONDS` between the clocks, at the moment it is
 * given, so jose and the contract's reader judge the times at the same instant. A token that
 * names no `kid` is refused before any key is looked for, and so is an outbox delivery
 * (`typ` `OUTBOX_MESSAGE_TYPE`): the same key signs both, and whatever its payload holds, a
 * delivery is never a token.
 *
 * When the keys cannot be had, the token is refused as `keys-unavailable`, never let through,
 * and `report` hears why (never the token). Only a key set that answered but holds no key the
 * token names counts against the token.
 */
export function createJoseTokenVerifier(
  keys: CellTokenKeys,
  report: (line: string) => void = console.error,
): TokenVerifier {
  const keyNamed = keyNamedBy(keys);
  const keyFor: JWTVerifyGetKey = (header, token) => {
    if (header.typ === OUTBOX_MESSAGE_TYPE) throw new NotAToken();
    return keyNamed(header, token);
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
        report(keysUnavailableLine(error));
        return { kind: 'keys-unavailable' };
      }
    },
  };
}

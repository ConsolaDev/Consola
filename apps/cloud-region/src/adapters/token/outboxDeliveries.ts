import { CELL_TOKEN_ALGORITHM, OUTBOX_MESSAGE_TYPE } from '@consola/cloud-contract';
import { compactVerify, errors } from 'jose';
import type { CompactVerifyGetKey } from 'jose';
import type { DeliveryCheck, DeliveryVerifier } from '../../application/ports.js';
import { KeysUnavailable, keyNamedBy, keysUnavailableLine, NoKeyNamed } from './cellTokens.js';
import type { CellTokenKeys } from './cellTokens.js';

/** A JWS whose `typ` is not the one the verifier takes: a cell token, say. */
class NotAMessage extends Error {}

/** Why a delivery is not one `cloud-global` signed, in words that hold nothing it carried. */
function whyUnsigned(error: unknown, typ: string): string {
  if (error instanceof NotAMessage) return `its typ is not ${typ}`;
  if (error instanceof NoKeyNamed) return 'it names no kid';
  if (error instanceof errors.JOSEAlgNotAllowed) return `its alg is not ${CELL_TOKEN_ALGORITHM}`;
  if (error instanceof errors.JWKSNoMatchingKey) return "no key in cloud-global's set has its kid";
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'its signature does not check';
  if (error instanceof errors.JOSEError) return `it is not a compact JWS (${error.code})`;
  return 'it is not a compact JWS';
}

/**
 * Checks deliveries from `cloud-global` with jose against `keys`, the key set cell tokens are
 * checked with, as the contract has it: a compact JWS, `CELL_TOKEN_ALGORITHM` alone, the key its
 * header names by `kid`, and `typ` `typ`: `OUTBOX_MESSAGE_TYPE` for the outbox's deliveries
 * (the default), `GITHUB_EVENT_TYPE` for the GitHub events it passes on. A header with another
 * `typ` or no `kid` is refused before any key is looked for, so a cell token, or a delivery of
 * the other kind, never reaches the key set.
 *
 * When the keys cannot be had, the delivery is refused as `keys-unavailable`, never let through,
 * and `report` hears why, as it does for tokens (never the delivery). Only a key set that
 * answered but holds no key the delivery names counts against the delivery.
 */
export function createJoseDeliveryVerifier(
  keys: CellTokenKeys,
  report: (line: string) => void = console.error,
  typ: string = OUTBOX_MESSAGE_TYPE,
): DeliveryVerifier {
  const keyFor = keyNamedBy(keys);
  const messageKey: CompactVerifyGetKey = (header, jws) => {
    if (header.typ !== typ) throw new NotAMessage();
    return keyFor(header, jws);
  };

  return {
    async verify(delivery): Promise<DeliveryCheck> {
      try {
        const { payload } = await compactVerify(delivery, messageKey, {
          algorithms: [CELL_TOKEN_ALGORITHM],
        });
        return { kind: 'verified', payload };
      } catch (error) {
        if (!(error instanceof KeysUnavailable)) {
          return { kind: 'unsigned', reason: whyUnsigned(error, typ) };
        }
        report(keysUnavailableLine(error));
        return { kind: 'keys-unavailable' };
      }
    },
  };
}

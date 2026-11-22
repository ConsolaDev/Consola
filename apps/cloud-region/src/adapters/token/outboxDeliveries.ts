import { CELL_TOKEN_ALGORITHM, OUTBOX_MESSAGE_TYPE } from '@consola/cloud-contract';
import { type CompactVerifyGetKey, compactVerify, errors } from 'jose';
import type { DeliveryCheck, DeliveryVerifier } from '../../application/ports.js';
import {
  type CellTokenKeys,
  KeysUnavailable,
  keyNamedBy,
  keysUnavailableLine,
  NoKeyNamed,
} from './cellTokens.js';

/** A JWS whose `typ` is not an outbox message's: a cell token, say. */
class NotAMessage extends Error {}

/** Why a delivery is not one `cloud-global` signed, in words that hold nothing it carried. */
function whyUnsigned(error: unknown): string {
  if (error instanceof NotAMessage) return `its typ is not ${OUTBOX_MESSAGE_TYPE}`;
  if (error instanceof NoKeyNamed) return 'it names no kid';
  if (error instanceof errors.JOSEAlgNotAllowed) return `its alg is not ${CELL_TOKEN_ALGORITHM}`;
  if (error instanceof errors.JWKSNoMatchingKey) return "no key in cloud-global's set has its kid";
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'its signature does not check';
  if (error instanceof errors.JOSEError) return `it is not a compact JWS (${error.code})`;
  return 'it is not a compact JWS';
}

/**
 * Checks outbox deliveries with jose against `keys`, the key set cell tokens are checked with,
 * as the contract has it: a compact JWS, `CELL_TOKEN_ALGORITHM` alone, the key its header names
 * by `kid`, and `typ` `OUTBOX_MESSAGE_TYPE`. A header with another `typ` or no `kid` is refused
 * before any key is looked for, so a cell token sent as a delivery never reaches the key set.
 *
 * When the keys cannot be had, the delivery is refused as `keys-unavailable`, never let through,
 * and `report` hears why, as it does for tokens (never the delivery). Only a key set that
 * answered but holds no key the delivery names counts against the delivery.
 */
export function createJoseDeliveryVerifier(
  keys: CellTokenKeys,
  report: (line: string) => void = console.error,
): DeliveryVerifier {
  const keyFor = keyNamedBy(keys);
  const messageKey: CompactVerifyGetKey = (header, jws) => {
    if (header.typ !== OUTBOX_MESSAGE_TYPE) throw new NotAMessage();
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
          return { kind: 'unsigned', reason: whyUnsigned(error) };
        }
        report(keysUnavailableLine(error));
        return { kind: 'keys-unavailable' };
      }
    },
  };
}

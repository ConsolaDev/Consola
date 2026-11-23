import { FIRST_SEQUENCE } from './outbox.js';
import { fieldProblem, isRecord, isWholeNumber, type ReadResult, read, refused } from './read.js';

/**
 * How `cloud-global` delivers an outbox message to a workspace's cell, and what the cell answers.
 *
 * A delivery is one `POST` to `OUTBOX_DELIVERY_PATH` on the cell's origin, carrying one message.
 * Its body is the message as JSON, signed: a JWS in compact serialization (RFC 7515), sent as
 * `OUTBOX_DELIVERY_MEDIA_TYPE`. It is signed with the key that signs cell tokens: the algorithm is
 * `CELL_TOKEN_ALGORITHM`, the protected header names the key's `kid`, and the cell checks it
 * against the key set it already fetches from `CELL_TOKEN_KEYS_PATH`. The header's `typ` is
 * `OUTBOX_MESSAGE_TYPE`, which no cell token carries, and the cell refuses any other.
 *
 * Neither can pass for the other: a cell token's claims are no message the reader takes, and a
 * message names no `aud`, so no cell takes it for a token.
 */
export const OUTBOX_DELIVERY_PATH = '/api/outbox';

/** The media type of a delivery's body: a JWS in compact serialization (RFC 7515). */
export const OUTBOX_DELIVERY_MEDIA_TYPE = 'application/jose';

/** The `typ` in a delivery's protected header. */
export const OUTBOX_MESSAGE_TYPE = 'consola-outbox-message';

/**
 * What a cell answers a delivery, by status. `cloud-global` takes any 2xx as the cell's
 * confirmation and retries everything else, a refusal included: it never skips a message, and a
 * workspace's next message waits until this one is confirmed, so its order is kept.
 */
export const OUTBOX_ANSWER = {
  /** The cell has the message: it applied it now, or had applied it before. */
  applied: 200,
  /** The body is no message the contract reads, or is not sent as `OUTBOX_DELIVERY_MEDIA_TYPE`. */
  unreadable: 400,
  /**
   * The signature is not `cloud-global`'s: not a compact JWS, another algorithm or `typ`, no
   * `kid`, a key the set does not hold, or a signature that does not check.
   */
  unsigned: 401,
  /**
   * The cell has not applied the workspace's messages before this one. The body says which one it
   * applies next (`OutOfOrderAnswer`).
   */
  outOfOrder: 409,
  /** The message is about a workspace in another region. */
  otherRegion: 421,
  /** The cell could not get `cloud-global`'s keys, or could not reach its own database. */
  unavailable: 503,
} as const;

/** The body of an `OUTBOX_ANSWER.outOfOrder` answer. */
export type OutOfOrderAnswer = {
  /**
   * The sequence of the workspace's message the cell applies next: `FIRST_SEQUENCE` when it holds
   * nothing of the workspace yet.
   */
  nextSequence: number;
};

const OUT_OF_ORDER = ['nextSequence'] as const;

/** Reads an `OUTBOX_ANSWER.outOfOrder` answer's body as `cloud-global` gets it (JSON, parsed). */
export function readOutOfOrderAnswer(value: unknown): ReadResult<OutOfOrderAnswer> {
  if (!isRecord(value)) return refused('the answer is not an object');
  const fields = fieldProblem(value, OUT_OF_ORDER, 'the answer');
  if (fields !== null) return refused(fields);
  const { nextSequence } = value;
  if (!isWholeNumber(nextSequence) || nextSequence < FIRST_SEQUENCE) {
    return refused(`\`nextSequence\` is not a whole number from ${FIRST_SEQUENCE}`);
  }
  return read({ nextSequence });
}

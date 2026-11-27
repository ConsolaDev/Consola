import { fieldProblem, isRecord, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/**
 * A follow-up: a person's message the cell hands a running agent run, for its orchestrator's
 * conversation. The cell sends it straight to the session's host, at the address the runner
 * reported (`hostUrl`), with a pass for the person who wrote it (`sub`); the host fences it, says
 * who wrote it, and queues it after the orchestrator's turn, once per `key`.
 */

/** Where a session's host takes a follow-up: `POST <hostUrl><FOLLOW_UP_PATH>`, the pass as bearer. */
export const FOLLOW_UP_PATH = '/agent-run/follow-ups';

/** The most characters a follow-up's `text` may hold: room for a long chat message. */
export const FOLLOW_UP_TEXT_MAX = 40_000;

/** The most characters a follow-up's `authorLabel` may hold. */
export const FOLLOW_UP_AUTHOR_LABEL_MAX = 100;

/**
 * The largest follow-up body the host reads, in bytes: any follow-up the reader takes fits, even
 * with every character of its text sent as a six-byte JSON escape.
 */
export const FOLLOW_UP_BODY_MAX_BYTES = 256 * 1024;

/** A follow-up's key: what the sender chose to deliver it once by, such as an event's id. */
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** What the cell sends a session's host. The person is the pass's `sub`, never a field here. */
export type FollowUp = {
  /** The sender's key: a second follow-up with the same key is the first, delivered once. */
  key: string;
  /** What the person wrote, whole. */
  text: string;
  /** Who wrote it, in the sender's words, such as `a teammate in Slack`. Never a name. */
  authorLabel: string;
};

const FIELDS = ['key', 'text', 'authorLabel'] as const;

/** Whether `text` holds a control character or a line or paragraph separator. */
const breaksTheLine = (text: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text);

/**
 * Reads a follow-up: a `key` of letters, digits, `.`, `_`, `:` and `-` (128 at most); a `text`
 * that is not blank, of at most `FOLLOW_UP_TEXT_MAX` characters; and an `authorLabel` on one
 * line, not blank, of at most `FOLLOW_UP_AUTHOR_LABEL_MAX`, with no control character.
 */
export function readFollowUp(value: unknown): ReadResult<FollowUp> {
  if (!isRecord(value)) return refused('the follow-up is not an object');
  const fields = fieldProblem(value, FIELDS, 'the follow-up');
  if (fields !== null) return refused(fields);
  const { key, text, authorLabel } = value;
  if (typeof key !== 'string' || !KEY.test(key)) return refused("`key` is not a follow-up's key");
  if (typeof text !== 'string' || text.trim() === '' || text.length > FOLLOW_UP_TEXT_MAX) {
    return refused(`\`text\` is not text of 1 to ${FOLLOW_UP_TEXT_MAX} characters`);
  }
  if (
    typeof authorLabel !== 'string' ||
    authorLabel.trim() === '' ||
    authorLabel.length > FOLLOW_UP_AUTHOR_LABEL_MAX ||
    breaksTheLine(authorLabel)
  ) {
    return refused(
      `\`authorLabel\` is not one line of 1 to ${FOLLOW_UP_AUTHOR_LABEL_MAX} characters`,
    );
  }
  return read({ key, text, authorLabel });
}

/**
 * What the host did with a follow-up: `delivered`, queued after the orchestrator's turn now, or
 * `already-delivered`, since a follow-up with its key was queued before.
 */
export const FOLLOW_UP_OUTCOMES = ['delivered', 'already-delivered'] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

/** The host's answer to a follow-up it took (`200`). */
export type FollowUpReceipt = { outcome: FollowUpOutcome };

/** Reads the host's answer to a follow-up it took. */
export function readFollowUpReceipt(value: unknown): ReadResult<FollowUpReceipt> {
  if (!isRecord(value)) return refused('the receipt is not an object');
  const fields = fieldProblem(value, ['outcome'], 'the receipt');
  if (fields !== null) return refused(fields);
  const { outcome } = value;
  if (typeof outcome !== 'string' || !(FOLLOW_UP_OUTCOMES as readonly string[]).includes(outcome)) {
    return refused("`outcome` is not a follow-up's outcome");
  }
  return read({ outcome: outcome as FollowUpOutcome });
}

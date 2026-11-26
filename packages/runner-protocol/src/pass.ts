import { fieldProblem, isId, isRecord, isWholeNumber, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/**
 * The session pass: a short-lived JWT the cell signs for one person in one session, and the
 * session's host checks (with the public key the cell sent in `session.start`) before it serves
 * anything. Signing is the cell's work and checking the signature and the time is the host's; this
 * package holds what both agree on.
 */

/**
 * The audience every pass names. It differs from the cell token's (`consola-cell`), which the
 * cloud app no longer mints, so such a token is never a pass.
 */
export const PASS_AUDIENCE = 'consola-session-pass';

/** The JWS `typ` header of a pass, so no other signed value is taken for one. */
export const PASS_TYPE = 'consola-session-pass+jwt';

/** The longest a pass may live. A cell issues a new one when the page needs one. */
export const PASS_MAX_LIFETIME_SECONDS = 5 * 60;

/** The claims of a pass, by their JWT names. Times are whole seconds since the epoch. */
export type PassClaims = {
  /** Always `PASS_AUDIENCE`. */
  aud: typeof PASS_AUDIENCE;
  /** The person's global id. */
  sub: string;
  /** The workspace the session is in. */
  ws: string;
  /** The one session the pass is for; the host checks it against its own. */
  sid: string;
  iat: number;
  /** At most `PASS_MAX_LIFETIME_SECONDS` after `iat`. */
  exp: number;
};

const CLAIMS = ['aud', 'sub', 'ws', 'sid', 'iat', 'exp'] as const;

/** What the cell mints a pass for, in its own words. */
export type PassGrant = {
  personId: string;
  workspaceId: string;
  sessionId: string;
  /** Whole seconds since the epoch. */
  issuedAt: number;
  lifetimeSeconds: number;
};

/** The claims to sign for a grant. It throws on a grant `readPassClaims` would refuse. */
export function passClaims(grant: PassGrant): PassClaims {
  const claims = {
    aud: PASS_AUDIENCE,
    sub: grant.personId,
    ws: grant.workspaceId,
    sid: grant.sessionId,
    iat: grant.issuedAt,
    exp: grant.issuedAt + grant.lifetimeSeconds,
  };
  const checked = readPassClaims(claims);
  if (!checked.ok) throw new TypeError(`No pass can be minted for this: ${checked.reason}.`);
  return checked.value;
}

/**
 * Reads the claims of a pass whose signature the host has checked: the shape, the audience, whole
 * second times, `exp` after `iat`, and a lifetime within `PASS_MAX_LIFETIME_SECONDS`. The time
 * against now and the session id are the host's to check (`exp <= now` is expired; the clock skew
 * applies to `iat` only).
 */
export function readPassClaims(payload: unknown): ReadResult<PassClaims> {
  if (!isRecord(payload)) return refused("the pass's claims are not an object");
  const fields = fieldProblem(payload, CLAIMS, 'the pass');
  if (fields !== null) return refused(fields);
  const { aud, sub, ws, sid, iat, exp } = payload;
  if (aud !== PASS_AUDIENCE) return refused('the pass is not meant for a session (`aud`)');
  if (!isId(sub)) return refused("`sub` is not a person's id");
  if (!isId(ws)) return refused("`ws` is not a workspace's id");
  if (!isId(sid)) return refused("`sid` is not a session's id");
  if (!isWholeNumber(iat) || iat < 0) return refused('`iat` is not a time in whole seconds');
  if (!isWholeNumber(exp) || exp < 0) return refused('`exp` is not a time in whole seconds');
  if (exp <= iat) return refused('the pass expires before it was minted');
  if (exp - iat > PASS_MAX_LIFETIME_SECONDS) {
    return refused('the pass lives longer than a pass may');
  }
  return read({ aud, sub, ws, sid, iat, exp });
}

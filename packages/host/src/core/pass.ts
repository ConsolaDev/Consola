import { PASS_MAX_LIFETIME_SECONDS, PASS_TYPE, readPassClaims } from '@consola/runner-protocol';
import type { PassClaims } from '@consola/runner-protocol';

/**
 * What a session pass says, once an adapter has verified its signature: the protocol's claims
 * (`@consola/runner-protocol`), which the cell signs.
 */
export type { PassClaims } from '@consola/runner-protocol';

/** How long a `--dev` host's own pass lives: twelve hours, a working day with the dev page open. */
export const DEV_PASS_SECONDS = 43_200;

/**
 * Which passes a host takes. `cell`: a cell's, read by the protocol's `readPassClaims`, so one
 * that lives over `PASS_MAX_LIFETIME_SECONDS` is refused. `dev`: a `--dev` host's own, which the
 * same rules read but for that cap, since it lives `DEV_PASS_SECONDS`. Only a host on loopback
 * takes `dev` passes (`listenHost`), and its key pair is its own, made in memory.
 */
export type PassLifetime = 'cell' | 'dev';

/**
 * A dev pass's claims: the protocol's rules, read with `exp` brought within its cap, and its own
 * `exp` given back once its lifetime is checked against `DEV_PASS_SECONDS`.
 */
const readDevClaims = (payload: unknown): PassClaims | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const { iat, exp } = payload as { iat?: unknown; exp?: unknown };
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  const issued = iat as number;
  const expires = exp as number;
  if (expires - issued > DEV_PASS_SECONDS) return null;
  const read = readPassClaims({
    ...payload,
    exp: Math.min(expires, issued + PASS_MAX_LIFETIME_SECONDS),
  });
  return read.ok ? { ...read.value, exp: expires } : null;
};

/**
 * Reads a pass whose signature an adapter has verified: its JWS header's `typ` must be
 * `PASS_TYPE`, and its payload the protocol's claims (`readPassClaims`: `aud` `PASS_AUDIENCE`, the
 * fields it names and no other, a lifetime within its cap, or `DEV_PASS_SECONDS` for a `dev`
 * host). Answers the claims, or null for anything that is no pass. The time against now and the
 * session are `checkPassClaims`'s.
 */
export function readPass(
  typ: unknown,
  payload: unknown,
  lifetime: PassLifetime,
): PassClaims | null {
  if (typ !== PASS_TYPE) return null;
  if (lifetime === 'dev') return readDevClaims(payload);
  const read = readPassClaims(payload);
  return read.ok ? read.value : null;
}

export type PassVerdict =
  | { ok: true }
  | { ok: false; reason: 'wrong-session' | 'expired' | 'not-yet-valid' };

/** A pass issued up to this many seconds ahead of the host's clock still counts. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Judges a pass's claims for one session. It never checks a signature: that is an adapter's
 * job, done before the claims are trusted. `exp <= now` is expired; the skew allowed applies
 * to `iat` only.
 */
export function checkPassClaims(
  claims: PassClaims,
  sessionId: string,
  nowSeconds: number,
): PassVerdict {
  if (claims.sid !== sessionId) return { ok: false, reason: 'wrong-session' };
  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true };
}

/**
 * Why a connection's pass was refused: `missing`, `invalid` (a bad signature, an algorithm other
 * than EdDSA, claims that are not a pass's), or a verdict of `checkPassClaims`.
 */
export type PassRefusal = 'missing' | 'invalid' | Extract<PassVerdict, { ok: false }>['reason'];

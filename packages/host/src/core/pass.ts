/** What a session pass says, once an adapter has verified its signature. */
export type PassClaims = {
  /** Who the pass was issued to. */
  sub: string;
  /** The workspace. */
  ws: string;
  /** The one session the pass opens. */
  sid: string;
  /** Issued at, in seconds. */
  iat: number;
  /** Expires at, in seconds. */
  exp: number;
};

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

/**
 * The WebSocket close code for a refused pass: `4403` when the pass is valid but opens another
 * session, `4401` for every other refusal (the client needs a new pass).
 */
export function passCloseCode(refusal: PassRefusal): 4401 | 4403 {
  return refusal === 'wrong-session' ? 4403 : 4401;
}

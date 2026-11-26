import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { compactVerify, importSPKI } from 'jose';
import { checkPassClaims, readPass } from '../core/pass.ts';
import type { PassClaims, PassLifetime, PassRefusal } from '../core/pass.ts';

/** The one signature a pass may carry: EdDSA over Ed25519. jose refuses every other, `none` too. */
const PASS_ALGORITHM = 'EdDSA';

/** A pass's payload as JSON, nothing assumed: `readPass` reads it. */
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * A pass the host would not take. It carries the reason only: never the pass, its claims or the
 * person they name, so logging it reveals nothing.
 */
export class PassRejected extends Schema.TaggedError<PassRejected>()('PassRejected', {
  reason: Schema.Literals(['missing', 'invalid', 'wrong-session', 'expired', 'not-yet-valid']),
}) {
  override get message(): string {
    return `The session pass was refused (${this.reason}).`;
  }
}

/**
 * The key passes are checked against is not an Ed25519 public key in SPKI PEM form. It names the
 * problem only: never the key material, nor jose's own error.
 */
export class PassKeyInvalid extends Schema.TaggedError<PassKeyInvalid>()('PassKeyInvalid', {}) {
  override get message(): string {
    return 'The pass public key is not an Ed25519 public key in SPKI PEM form.';
  }
}

/** The cell's public key, parsed once; every pass is verified against it. */
export type PassKey = {
  readonly _tag: 'PassKey';
  readonly key: Awaited<ReturnType<typeof importSPKI>>;
};

/**
 * Parses the key passes are signed by: an Ed25519 public key as an SPKI PEM. jose accepts no other
 * kind for EdDSA (an Ed448 or RSA key is refused), so a key that parses can verify only EdDSA
 * over Ed25519.
 */
export const parsePassKey = (publicKeyPem: string): Effect.Effect<PassKey, PassKeyInvalid> =>
  Effect.tryPromise({
    try: async (): Promise<PassKey> => ({
      _tag: 'PassKey',
      key: await importSPKI(publicKeyPem, PASS_ALGORITHM),
    }),
    catch: () => new PassKeyInvalid(),
  });

const refuse = (reason: PassRefusal) => new PassRejected({ reason });

/**
 * Verifies a session pass against a parsed key: a compact JWS signed with EdDSA, whose header and
 * payload `readPass` takes for a pass (`typ` `PASS_TYPE`, the protocol's claims, a lifetime within
 * the cap, or a dev pass's for a `dev` host); then judges its claims with `checkPassClaims`. jose
 * checks only the signature and the algorithm, so the claims have one reader and one judge.
 */
export const verifyPassWith = (
  token: string,
  key: PassKey,
  sessionId: string,
  nowSeconds: number,
  lifetime: PassLifetime = 'cell',
): Effect.Effect<PassClaims, PassRejected> =>
  Effect.gen(function* () {
    if (token === '') return yield* refuse('missing');
    const verified = yield* Effect.tryPromise({
      try: () => compactVerify(token, key.key, { algorithms: [PASS_ALGORITHM] }),
      catch: () => refuse('invalid'),
    });
    const payload = yield* decodePayload(new TextDecoder().decode(verified.payload)).pipe(
      Effect.mapError(() => refuse('invalid')),
    );
    const claims = readPass(verified.protectedHeader.typ, payload, lifetime);
    if (claims === null) return yield* refuse('invalid');
    const verdict = checkPassClaims(claims, sessionId, nowSeconds);
    if (!verdict.ok) return yield* refuse(verdict.reason);
    return claims;
  });

/**
 * `verifyPassWith`, parsing `publicKeyPem` first: a key that does not parse refuses the pass as
 * `invalid`. The server parses its key once, at start (`listenHost`), and fails there instead.
 */
export const verifyPass = (
  token: string,
  publicKeyPem: string,
  sessionId: string,
  nowSeconds: number,
  lifetime: PassLifetime = 'cell',
): Effect.Effect<PassClaims, PassRejected> =>
  parsePassKey(publicKeyPem).pipe(
    Effect.mapError(() => refuse('invalid')),
    Effect.flatMap((key) => verifyPassWith(token, key, sessionId, nowSeconds, lifetime)),
  );

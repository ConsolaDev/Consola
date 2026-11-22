import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { compactVerify, importSPKI } from 'jose';
import { checkPassClaims, type PassClaims, type PassRefusal } from '../core/pass.ts';

/** The one signature a pass may carry: EdDSA over Ed25519. jose refuses every other, `none` too. */
const PASS_ALGORITHM = 'EdDSA';

/** A session pass's claims as signed: the shape `checkPassClaims` judges, nothing assumed. */
const PassClaimsSchema = Schema.Struct({
  sub: Schema.String,
  ws: Schema.String,
  sid: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(PassClaimsSchema));

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

const refuse = (reason: PassRefusal) => new PassRejected({ reason });

/**
 * Verifies a session pass: a compact JWS signed with EdDSA by the key whose SPKI PEM is
 * `publicKeyPem` (an Ed25519 key; jose refuses any other kind for EdDSA), whose payload is a
 * pass's claims; then judges those claims with `checkPassClaims`. jose checks only the
 * signature and the algorithm, so the claims have one judge.
 */
export const verifyPass = (
  token: string,
  publicKeyPem: string,
  sessionId: string,
  nowSeconds: number,
): Effect.Effect<PassClaims, PassRejected> =>
  Effect.gen(function* () {
    if (token === '') return yield* refuse('missing');
    const verified = yield* Effect.tryPromise({
      try: async () => {
        const key = await importSPKI(publicKeyPem, PASS_ALGORITHM);
        return compactVerify(token, key, { algorithms: [PASS_ALGORITHM] });
      },
      catch: () => refuse('invalid'),
    });
    const claims = yield* decodeClaims(new TextDecoder().decode(verified.payload)).pipe(
      Effect.mapError(() => refuse('invalid')),
    );
    const verdict = checkPassClaims(claims, sessionId, nowSeconds);
    if (!verdict.ok) return yield* refuse(verdict.reason);
    return claims;
  });

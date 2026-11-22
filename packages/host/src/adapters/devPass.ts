// @effect-diagnostics nodeBuiltinImport:off - The dev key pair is made with node:crypto, in memory.
import { generateKeyPairSync } from 'node:crypto';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { SignJWT } from 'jose';
import type { PassClaims } from '../core/pass.ts';

/** How long a dev pass lasts: twelve hours, a working day with the dev page open. */
export const DEV_PASS_SECONDS = 43_200;

/**
 * Who a dev pass is issued to and for which workspace: names no person or workspace could have,
 * so a dev pass is never mistaken for a cell's.
 */
export const DEV_PASS_SUBJECT = 'dev';
export const DEV_PASS_WORKSPACE = 'local';

/** A dev host's access: the public key its passes are checked against, and one such pass. */
export type DevAccess = {
  readonly publicKeyPem: string;
  readonly pass: string;
  readonly expiresInSeconds: number;
};

/**
 * Stands in for the cell on a developer's machine: makes an Ed25519 key pair in memory and signs
 * one pass for `sessionId` with it, as the cell signs one (EdDSA, `sub`, `ws`, `sid`, `iat` now,
 * `exp` `DEV_PASS_SECONDS` later). The private key never leaves this function: it is not
 * returned, printed or written anywhere, so no other pass can ever be signed for this host.
 */
export const makeDevAccess = (sessionId: string): Effect.Effect<DevAccess> =>
  Effect.gen(function* () {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const claims: PassClaims = {
      sub: DEV_PASS_SUBJECT,
      ws: DEV_PASS_WORKSPACE,
      sid: sessionId,
      iat,
      exp: iat + DEV_PASS_SECONDS,
    };
    const pass = yield* Effect.promise(() =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).sign(privateKey),
    );
    const access: DevAccess = {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      pass,
      expiresInSeconds: DEV_PASS_SECONDS,
    };
    return access;
  });

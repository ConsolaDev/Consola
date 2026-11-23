// @effect-diagnostics nodeBuiltinImport:off - A test's pass keys are node:crypto key objects.
import type { KeyObject } from 'node:crypto';
import { PASS_MAX_LIFETIME_SECONDS, PASS_TYPE, passClaims } from '@consola/runner-protocol';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { SignJWT } from 'jose';

/**
 * A pass for `sessionId` signed with `privateKey` as the cell's `passSigner` signs one
 * (`apps/cloud-region`, `adapters/token/passSigner.ts`): the protocol's claims (`passClaims`, for
 * Acme's person in Sprocket's workspace), EdDSA, `typ` `PASS_TYPE`, issued now and living
 * `lifetimeSeconds` (the protocol's cap unless given; `passClaims` throws over it).
 */
export const signCellPass = Effect.fn('signCellPass')(function* (
  privateKey: KeyObject,
  sessionId: string,
  lifetimeSeconds: number = PASS_MAX_LIFETIME_SECONDS,
) {
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const claims = passClaims({
    personId: 'person-acme-1',
    workspaceId: 'workspace-sprocket',
    sessionId,
    issuedAt,
    lifetimeSeconds,
  });
  return yield* Effect.promise(() =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'EdDSA', typ: PASS_TYPE })
      .sign(privateKey),
  );
});

/**
 * The protocol's pass contract, for a stand-in for the cell outside this package (`@consola/agent-ui`'s
 * browser tests sign their passes with it, `src/testing/passKeys.ts`).
 */
export {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
} from '@consola/runner-protocol';

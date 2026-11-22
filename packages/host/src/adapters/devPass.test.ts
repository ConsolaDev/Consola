import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vite-plus/test';
import { DEV_PASS_SECONDS, makeDevAccess } from './devPass.ts';
import { verifyPass } from './passVerifier.ts';

const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

describe('makeDevAccess', () => {
  it('signs a pass for the session that its own public key verifies, for twelve hours', () =>
    Effect.gen(function* () {
      const access = yield* makeDevAccess('session-sprocket-dev');
      const now = yield* nowSeconds;

      expect(DEV_PASS_SECONDS).toBe(43_200);
      expect(access.expiresInSeconds).toBe(DEV_PASS_SECONDS);
      expect(decodeProtectedHeader(access.pass)).toEqual({ alg: 'EdDSA', typ: 'JWT' });
      const claims = yield* verifyPass(
        access.pass,
        access.publicKeyPem,
        'session-sprocket-dev',
        now,
      );
      expect(claims).toMatchObject({ sub: 'dev', ws: 'local', sid: 'session-sprocket-dev' });
      expect(claims.exp - claims.iat).toBe(DEV_PASS_SECONDS);
      expect(Math.abs(claims.iat - now)).toBeLessThanOrEqual(5);
      expect(decodeJwt(access.pass)).toEqual(claims);
    }).pipe(Effect.runPromise));

  it('hands out the public key and the pass only, and a new key pair each time', () =>
    Effect.gen(function* () {
      const first = yield* makeDevAccess('session-sprocket-dev');
      const second = yield* makeDevAccess('session-sprocket-dev');

      expect(Object.keys(first).sort()).toEqual(['expiresInSeconds', 'pass', 'publicKeyPem']);
      expect(first.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
      expect(Object.values(first).join('\n')).not.toContain('PRIVATE KEY');
      expect(second.publicKeyPem).not.toBe(first.publicKeyPem);
      // One host's pass opens no other host.
      const refused = yield* Effect.flip(
        verifyPass(first.pass, second.publicKeyPem, 'session-sprocket-dev', yield* nowSeconds),
      );
      expect(refused.reason).toBe('invalid');
    }).pipe(Effect.runPromise));
});

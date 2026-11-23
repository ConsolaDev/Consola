// @effect-diagnostics nodeBuiltinImport:off - Each test makes its own keys with node:crypto.
import { generateKeyPairSync } from 'node:crypto';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
} from '@consola/runner-protocol';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vite-plus/test';
import { DEV_PASS_SECONDS, type PassClaims } from '../core/pass.ts';
import { PassRejected, verifyPass } from './passVerifier.ts';

/** An Ed25519 key pair made for the test; no key is ever committed. */
const makeKeys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};

const SESSION = 'session-sprocket-pass';
const NOW = 1_800_000_000;
const claims = (overrides: Partial<PassClaims> = {}): PassClaims => ({
  aud: PASS_AUDIENCE,
  sub: 'person-acme-1',
  ws: 'workspace-sprocket',
  sid: SESSION,
  iat: NOW - 10,
  exp: NOW + 290,
  ...overrides,
});

/** Signed as the cell's `passSigner` signs a pass: EdDSA, `typ` `PASS_TYPE` (`typ`, or none). */
const sign = (
  keys: ReturnType<typeof makeKeys>,
  payload: Record<string, unknown>,
  typ: string | null = PASS_TYPE,
) =>
  new SignJWT(payload)
    .setProtectedHeader(typ === null ? { alg: 'EdDSA' } : { alg: 'EdDSA', typ })
    .sign(keys.privateKey);

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const refusal = async (token: string, publicKeyPem: string) => {
  const exit = await Effect.runPromiseExit(verifyPass(token, publicKeyPem, SESSION, NOW));
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
  const found = Option.getOrUndefined(error);
  expect(found).toBeInstanceOf(PassRejected);
  return found?.reason;
};

describe('verifyPass', () => {
  const keys = makeKeys();

  it('accepts an EdDSA pass signed by the host key for this session, and returns its claims', async () => {
    const token = await sign(keys, claims());
    const verified = await Effect.runPromise(verifyPass(token, keys.publicKeyPem, SESSION, NOW));
    expect(verified).toEqual(claims());
  });

  it("accepts a pass as the cell's passSigner signs one: the protocol's claims, its type, its longest lifetime", async () => {
    const cells = passClaims({
      personId: 'person-acme-1',
      workspaceId: 'workspace-sprocket',
      sessionId: SESSION,
      issuedAt: NOW - 10,
      lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
    });
    const token = await sign(keys, { ...cells });
    expect(await Effect.runPromise(verifyPass(token, keys.publicKeyPem, SESSION, NOW))).toEqual(
      cells,
    );
  });

  it('refuses another audience, a missing or other type, and a lifetime over the cap', async () => {
    expect(
      await refusal(await sign(keys, { ...claims(), aud: 'consola-cell' }), keys.publicKeyPem),
    ).toBe('invalid');
    const { aud: _aud, ...withoutAudience } = claims();
    expect(await refusal(await sign(keys, withoutAudience), keys.publicKeyPem)).toBe('invalid');
    expect(await refusal(await sign(keys, claims(), null), keys.publicKeyPem)).toBe('invalid');
    expect(await refusal(await sign(keys, claims(), 'JWT'), keys.publicKeyPem)).toBe('invalid');
    const long = claims({ exp: NOW - 10 + PASS_MAX_LIFETIME_SECONDS + 1 });
    expect(await refusal(await sign(keys, long), keys.publicKeyPem)).toBe('invalid');
  });

  it("takes a dev host's own long pass only when told it is a dev host's", async () => {
    const dev = claims({ iat: NOW - 10, exp: NOW - 10 + DEV_PASS_SECONDS });
    const token = await sign(keys, dev);
    expect(await refusal(token, keys.publicKeyPem)).toBe('invalid');
    expect(
      await Effect.runPromise(verifyPass(token, keys.publicKeyPem, SESSION, NOW, 'dev')),
    ).toEqual(dev);
  });

  it('refuses a missing pass', async () => {
    expect(await refusal('', keys.publicKeyPem)).toBe('missing');
  });

  it('refuses a pass signed by another key', async () => {
    expect(await refusal(await sign(makeKeys(), claims()), keys.publicKeyPem)).toBe('invalid');
  });

  it('refuses alg none, whatever its claims say', async () => {
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims())}.`;
    expect(await refusal(token, keys.publicKeyPem)).toBe('invalid');
  });

  it('refuses an HMAC pass keyed with the public key, as an algorithm-confusion attack signs it', async () => {
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(keys.publicKeyPem));
    expect(await refusal(token, keys.publicKeyPem)).toBe('invalid');
  });

  it('refuses every pass when the host key is not Ed25519', async () => {
    const ed448 = generateKeyPairSync('ed448')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(await refusal(await sign(keys, claims()), ed448)).toBe('invalid');
  });

  it('refuses a pass whose claims are not a pass', async () => {
    const { sid: _sid, ...withoutSession } = claims();
    expect(await refusal(await sign(keys, withoutSession), keys.publicKeyPem)).toBe('invalid');
    expect(await refusal('not.a.pass', keys.publicKeyPem)).toBe('invalid');
  });

  it('judges the claims with checkPassClaims: another session, expired, not yet valid', async () => {
    const other = await sign(keys, claims({ sid: 'session-sprocket-other' }));
    expect(await refusal(other, keys.publicKeyPem)).toBe('wrong-session');
    const expired = await sign(keys, claims({ exp: NOW }));
    expect(await refusal(expired, keys.publicKeyPem)).toBe('expired');
    const early = await sign(keys, claims({ iat: NOW + 3600, exp: NOW + 3600 + 290 }));
    expect(await refusal(early, keys.publicKeyPem)).toBe('not-yet-valid');
  });

  it('never carries the pass or its claims in the refusal', async () => {
    const token = await sign(keys, claims({ sid: 'session-sprocket-other' }));
    const exit = await Effect.runPromiseExit(verifyPass(token, keys.publicKeyPem, SESSION, NOW));
    const shown = JSON.stringify(exit);
    expect(shown).not.toContain(token);
    expect(shown).not.toContain('person-acme-1');
  });
});

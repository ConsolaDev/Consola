import { generateKeyPairSync } from 'node:crypto';
import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
  readPassClaims,
} from '@consola/runner-protocol';
import { compactVerify, decodeProtectedHeader, importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../config.js';
import { createPassSigner } from './passSigner.js';

/** A new Ed25519 private key, as the JWK `PASS_PRIVATE_KEY` holds. */
const newPrivateJwk = (): Record<string, unknown> =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

const claims = () =>
  passClaims({
    personId: 'person-1',
    workspaceId: 'acme',
    sessionId: 'session-1',
    issuedAt: 1_800_000_000,
    lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
  });

async function refusalOf(jwk: Record<string, unknown>): Promise<ConfigError> {
  try {
    await createPassSigner(jwk);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected createPassSigner to refuse the key');
}

describe('createPassSigner', () => {
  it("derives the public key the session's host checks passes with, as an SPKI PEM", async () => {
    const jwk = newPrivateJwk();
    const { publicKeyPem } = await createPassSigner(jwk);
    expect(publicKeyPem).toMatch(
      /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/,
    );
    // What the host does with it (`parsePassKey`): an Ed25519 public key for EdDSA.
    await expect(importSPKI(publicKeyPem, 'EdDSA')).resolves.toBeDefined();
    expect(publicKeyPem).not.toContain(String(jwk.d));
  });

  it('signs a pass that verifies with that key alone, EdDSA only, typ PASS_TYPE', async () => {
    const { signer, publicKeyPem } = await createPassSigner(newPrivateJwk());
    const pass = await signer.sign(claims());

    expect(pass.split('.')).toHaveLength(3);
    expect(decodeProtectedHeader(pass)).toEqual({ alg: 'EdDSA', typ: PASS_TYPE });
    const verified = await compactVerify(pass, await importSPKI(publicKeyPem, 'EdDSA'), {
      algorithms: ['EdDSA'],
    });
    const payload: unknown = JSON.parse(new TextDecoder().decode(verified.payload));
    expect(readPassClaims(payload)).toEqual({ ok: true, value: claims() });
    expect(payload).toMatchObject({ aud: PASS_AUDIENCE });

    const other = await createPassSigner(newPrivateJwk());
    await expect(
      compactVerify(pass, await importSPKI(other.publicKeyPem, 'EdDSA'), {
        algorithms: ['EdDSA'],
      }),
    ).rejects.toThrow();
  });

  it('takes a key that also names a kid, alg or use', async () => {
    const jwk = { ...newPrivateJwk(), kid: 'pass-1', alg: 'EdDSA', use: 'sig' };
    await expect(createPassSigner(jwk)).resolves.toMatchObject({
      publicKeyPem: expect.any(String),
    });
  });

  it.each([
    ['an X25519 key', () => generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' })],
    [
      'an RSA key',
      () =>
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
    ],
    ['a public key alone', () => ({ ...newPrivateJwk(), d: undefined })],
    [
      'an x that is not the public key of its d',
      () => ({ ...newPrivateJwk(), x: newPrivateJwk().x }),
    ],
    ['an x and a d that are not 32 bytes', () => ({ ...newPrivateJwk(), x: 'abc', d: 'def' })],
    ['no kty', () => ({ ...newPrivateJwk(), kty: undefined })],
  ])('refuses %s as configuration, never quoting it', async (_what, make) => {
    const jwk = JSON.parse(JSON.stringify(make())) as Record<string, unknown>;
    const refusal = await refusalOf(jwk);
    expect(refusal.problems).toEqual([expect.stringMatching(/^PASS_PRIVATE_KEY: /)]);
    for (const value of Object.values(jwk)) {
      if (typeof value === 'string' && value.length > 8) {
        expect(refusal.message).not.toContain(value);
      }
    }
  });
});

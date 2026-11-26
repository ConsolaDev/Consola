import { generateKeyPairSync } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  GITHUB_TOKEN_REQUEST_TYPE,
  gitHubTokenRequest,
  readGitHubTokenRequest,
} from '@consola/cloud-contract';
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../config.js';
import { createGitHubTokenRequestSigner } from './gitHubTokenRequests.js';

/** A new Ed25519 private key, as the JWK `CELL_PRIVATE_KEY` holds. */
const newPrivateJwk = (): Record<string, unknown> =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

const SIGNED_AT = 1_800_000_000;

const request = gitHubTokenRequest({
  workspaceId: 'sprocket',
  installationId: 41,
  purpose: 'review-run',
  repositoryIds: [410],
  issuedAt: SIGNED_AT,
});

async function refusalOf(jwk: Record<string, unknown>): Promise<ConfigError> {
  try {
    await createGitHubTokenRequestSigner(jwk);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected the signer to refuse the key');
}

describe('createGitHubTokenRequestSigner', () => {
  it("signs a request cloud-global checks with the cell's public key, picked by its kid", async () => {
    const jwk = newPrivateJwk();
    const signer = await createGitHubTokenRequestSigner(jwk);
    const signed = await signer.sign(request);

    const { kty, crv, x } = jwk as { kty: string; crv: string; x: string };
    expect(decodeProtectedHeader(signed)).toEqual({
      alg: CELL_TOKEN_ALGORITHM,
      kid: await calculateJwkThumbprint({ kty, crv, x }),
      typ: GITHUB_TOKEN_REQUEST_TYPE,
    });
    // What cloud-global does with it (`cellRequestVerifier.ts`): the public half, EdDSA alone.
    const verified = await compactVerify(signed, await importJWK({ kty, crv, x }, 'EdDSA'), {
      algorithms: [CELL_TOKEN_ALGORITHM],
    });
    const payload: unknown = JSON.parse(new TextDecoder().decode(verified.payload));
    expect(readGitHubTokenRequest(payload, SIGNED_AT)).toEqual({ ok: true, value: request });
    expect(signed).not.toContain(String(jwk.d));
  });

  it('does not verify with another key', async () => {
    const signed = await (await createGitHubTokenRequestSigner(newPrivateJwk())).sign(request);
    const { kty, crv, x } = newPrivateJwk() as { kty: string; crv: string; x: string };
    await expect(
      compactVerify(signed, await importJWK({ kty, crv, x }, 'EdDSA'), {
        algorithms: [CELL_TOKEN_ALGORITHM],
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['an X25519 key', () => generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' })],
    ['a public key alone', () => ({ ...newPrivateJwk(), d: undefined })],
    [
      'an x that is not the public key of its d',
      () => ({ ...newPrivateJwk(), x: newPrivateJwk().x }),
    ],
    ['an x and a d that are not 32 bytes', () => ({ ...newPrivateJwk(), x: 'abc', d: 'def' })],
  ])('refuses %s as configuration, never quoting it', async (_what, make) => {
    const jwk = JSON.parse(JSON.stringify(make())) as Record<string, unknown>;
    const refusal = await refusalOf(jwk);
    expect(refusal.problems).toEqual([expect.stringMatching(/^CELL_PRIVATE_KEY: /)]);
    for (const value of Object.values(jwk)) {
      if (typeof value === 'string' && value.length > 8) {
        expect(refusal.message).not.toContain(value);
      }
    }
  });
});

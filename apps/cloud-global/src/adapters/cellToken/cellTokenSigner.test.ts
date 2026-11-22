import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CLOCK_SKEW_SECONDS,
  cellTokenClaims,
  readCellTokenClaims,
} from '@consola/cloud-contract';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError, type Ed25519PrivateJwk } from '../../config.js';
import { createCellTokenSigner } from './cellTokenSigner.js';

/** A key made for this run only, never one written down. */
function newKey(): Ed25519PrivateJwk {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Ed25519PrivateJwk;
}

/** The RFC 7638 thumbprint of an Ed25519 public key, worked out by hand. */
function thumbprintOf(x: string): string {
  const canonical = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x });
  return createHash('sha256').update(canonical).digest('base64url');
}

const issuedAt = 1_795_000_000;
const claims = cellTokenClaims({
  personId: 'dana',
  workspaceId: 'acme',
  role: 'admin',
  region: 'us',
  issuedAt,
});

/** Checks a token the way a cell does: the published keys, EdDSA alone, the cell's audience. */
async function verify(token: string, keys: Parameters<typeof createLocalJWKSet>[0]) {
  return jwtVerify(token, createLocalJWKSet(keys), {
    algorithms: [CELL_TOKEN_ALGORITHM],
    audience: CELL_TOKEN_AUDIENCE,
    clockTolerance: CLOCK_SKEW_SECONDS,
    currentDate: new Date(issuedAt * 1000),
  });
}

describe('createCellTokenSigner', () => {
  it('signs the claims, and nothing else, as a token its published key checks', async () => {
    const signer = await createCellTokenSigner(newKey());
    const token = await signer.sign(claims);
    const [published] = signer.publicKeys().keys;

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'EdDSA', kid: published?.kid });
    const { payload } = await verify(token, signer.publicKeys());
    expect(payload).toEqual(claims);
    expect(readCellTokenClaims(payload, issuedAt)).toEqual({ ok: true, value: claims });
  });

  it('publishes the public key, named by its thumbprint, and never its private part', async () => {
    const key = newKey();
    const keys = (await createCellTokenSigner(key)).publicKeys();

    expect(keys).toEqual({
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          x: key.x,
          kid: thumbprintOf(key.x),
          alg: 'EdDSA',
          use: 'sig',
        },
      ],
    });
    expect(keys.keys[0]).not.toHaveProperty('d');
    expect(JSON.stringify(keys)).not.toContain(key.d);
  });

  it('publishes a copy, so changing one changes nothing published', async () => {
    const signer = await createCellTokenSigner(newKey());
    const before = signer.publicKeys();
    const changed = signer.publicKeys();
    changed.keys.push({ ...before.keys[0], kid: 'sprocket' } as (typeof before.keys)[number]);
    if (changed.keys[0]) changed.keys[0].x = 'sprocket';

    expect(signer.publicKeys()).toEqual(before);
  });

  it("does not check another key's tokens", async () => {
    const ours = await createCellTokenSigner(newKey());
    const theirs = await createCellTokenSigner(newKey());
    await expect(verify(await theirs.sign(claims), ours.publicKeys())).rejects.toThrow();
  });

  it('refuses a key whose `x` is not the public key of its `d`, without quoting it', async () => {
    const key = { ...newKey(), x: newKey().x };
    const failure = await createCellTokenSigner(key).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    const { problems, message } = failure as ConfigError;
    expect(problems).toEqual([expect.stringMatching(/^CELL_TOKEN_PRIVATE_KEY: /)]);
    expect(message).not.toContain(key.d);
    expect(message).not.toContain(key.x);
  });
});

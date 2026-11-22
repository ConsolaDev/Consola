import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { CELL_TOKEN_ALGORITHM } from '@consola/cloud-contract';
import { calculateJwkThumbprint, SignJWT } from 'jose';
import type { CellTokenPublicKey, CellTokenSigner } from '../../application/ports.js';
import { ConfigError, type Ed25519PrivateJwk } from '../../config.js';

/**
 * Node's key for the configured JWK. One whose `x` is not the public key of its `d` is refused
 * here, as configuration, in words of its own: Node's do not quote a key, but nothing promises
 * they never will.
 */
function privateKeyOf(jwk: Ed25519PrivateJwk): KeyObject {
  const { kty, crv, x, d } = jwk;
  try {
    return createPrivateKey({ key: { kty, crv, x, d }, format: 'jwk' });
  } catch {
    throw new ConfigError([
      'CELL_TOKEN_PRIVATE_KEY: is not an Ed25519 key pair (its `x` must be the public key of its `d`)',
    ]);
  }
}

/**
 * Signs cell tokens with `jose`, using the configured Ed25519 private key, and publishes the
 * public key that checks them. That key is derived from the private key itself, so a cell always
 * checks with the key that signs, and its `kid` is its JWK thumbprint (RFC 7638). The private
 * key stays inside: nothing here logs it, and `publicKeys` never carries `d`.
 */
export async function createCellTokenSigner(jwk: Ed25519PrivateJwk): Promise<CellTokenSigner> {
  const privateKey = privateKeyOf(jwk);
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('Node gave an Ed25519 public key no `x`.');
  const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x });
  const published: CellTokenPublicKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x,
    kid,
    alg: CELL_TOKEN_ALGORITHM,
    use: 'sig',
  };

  return {
    sign: (claims) =>
      new SignJWT({ ...claims })
        .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid })
        .sign(privateKey),
    // A copy each time, so nothing a caller does to it changes what is published.
    publicKeys: () => ({ keys: [{ ...published }] }),
  };
}

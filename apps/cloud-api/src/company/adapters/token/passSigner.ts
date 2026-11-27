import { PASS_TYPE } from '@consola/runner-protocol';
import { exportSPKI, importJWK, SignJWT } from 'jose';
import type { PassSigner } from '../../application/ports.js';
import { ConfigError } from '../../../config.js';

/** The one algorithm a pass is signed with, and the one its host checks: EdDSA over Ed25519. */
const PASS_ALGORITHM = 'EdDSA';

/** An Ed25519 key's `x` or `d`: 32 bytes in base64url. */
const KEY_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** The app's pass key: what signs passes, and the public half each session's host is handed. */
export type PassKey = {
  signer: PassSigner;
  /** The public key as an SPKI PEM, sent in every `session.start`. Never a secret. */
  publicKeyPem: string;
};

/** A refusal of `PASS_PRIVATE_KEY`, in words of its own: it never quotes the key, nor jose. */
const refused = (problem: string) => new ConfigError([`PASS_PRIVATE_KEY: ${problem}`]);

/**
 * The pass key from `PASS_PRIVATE_KEY`, the JWK `config` read: an Ed25519 private key, its `x`
 * the public key of its `d`, or a `ConfigError`. The public key is derived from the private one,
 * so a host always checks with the key that signs. Other members (`kid`, `alg`, `use`) are left
 * out: a pass names no key, since each session's host is handed exactly one.
 *
 * A pass is a compact JWS, EdDSA, with `typ` `PASS_TYPE` and the claims it is given (the use case
 * builds them with the protocol's `passClaims`). The private key stays inside: nothing here logs
 * it, and the PEM is the public half alone.
 */
export async function createPassSigner(jwk: Record<string, unknown>): Promise<PassKey> {
  const { kty, crv, x, d } = jwk;
  if (kty !== 'OKP' || crv !== 'Ed25519') {
    throw refused('must be an Ed25519 key (`kty` OKP, `crv` Ed25519)');
  }
  if (d === undefined) throw refused('must be a private key, and this one has no `d`');
  if (typeof x !== 'string' || !KEY_BYTES.test(x) || typeof d !== 'string' || !KEY_BYTES.test(d)) {
    throw refused('`x` and `d` must each be 32 bytes in base64url');
  }

  let privateKey: Awaited<ReturnType<typeof importJWK>>;
  let publicKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    privateKey = await importJWK({ kty, crv, x, d }, PASS_ALGORITHM);
    publicKey = await importJWK({ kty, crv, x }, PASS_ALGORITHM);
  } catch {
    throw refused('is not an Ed25519 key pair (its `x` must be the public key of its `d`)');
  }
  if (privateKey instanceof Uint8Array || publicKey instanceof Uint8Array) {
    throw refused('must be an Ed25519 key pair');
  }
  const publicKeyPem = await exportSPKI(publicKey);

  return {
    publicKeyPem,
    signer: {
      sign: (claims) =>
        new SignJWT({ ...claims })
          .setProtectedHeader({ alg: PASS_ALGORITHM, typ: PASS_TYPE })
          .sign(privateKey),
    },
  };
}

import { CELL_TOKEN_ALGORITHM, GITHUB_TOKEN_REQUEST_TYPE } from '@consola/cloud-contract';
import { CompactSign, calculateJwkThumbprint, importJWK } from 'jose';
import type { GitHubTokenRequestSigner } from '../../application/ports.js';
import { ConfigError } from '../../config.js';

/** An Ed25519 key's `x` or `d`: 32 bytes in base64url. */
const KEY_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** A refusal of `CELL_PRIVATE_KEY`, in words of its own: it never quotes the key, nor jose. */
const refused = (problem: string) => new ConfigError([`CELL_PRIVATE_KEY: ${problem}`]);

/**
 * The signer of the cell's requests for GitHub tokens, from `CELL_PRIVATE_KEY`, the JWK `config`
 * read: an Ed25519 private key, its `x` the public key of its `d`, or a `ConfigError`. Its public
 * half is what `cloud-global` holds for the cell's region (`CELL_PUBLIC_KEY_<REGION>`), and
 * `cloud-global` picks it by `kid`, the public key's JWK thumbprint (RFC 7638).
 *
 * A request is its JSON as the payload of a compact JWS, with `CELL_TOKEN_ALGORITHM` (EdDSA), the
 * `kid` and `typ` `GITHUB_TOKEN_REQUEST_TYPE` in the protected header, as `cloud-contract` has it.
 * The private key stays inside: nothing here logs it.
 */
export async function createGitHubTokenRequestSigner(
  jwk: Record<string, unknown>,
): Promise<GitHubTokenRequestSigner> {
  const { kty, crv, x, d } = jwk;
  if (kty !== 'OKP' || crv !== 'Ed25519') {
    throw refused('must be an Ed25519 key (`kty` OKP, `crv` Ed25519)');
  }
  if (d === undefined) throw refused('must be a private key, and this one has no `d`');
  if (typeof x !== 'string' || !KEY_BYTES.test(x) || typeof d !== 'string' || !KEY_BYTES.test(d)) {
    throw refused('`x` and `d` must each be 32 bytes in base64url');
  }

  let privateKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    // Node refuses a private key whose `x` is not its `d`'s public key.
    privateKey = await importJWK({ kty, crv, x, d }, CELL_TOKEN_ALGORITHM);
  } catch {
    throw refused('is not an Ed25519 key pair (its `x` must be the public key of its `d`)');
  }
  if (privateKey instanceof Uint8Array) throw refused('must be an Ed25519 key pair');
  const kid = await calculateJwkThumbprint({ kty, crv, x });
  const encoder = new TextEncoder();

  return {
    sign: (request) =>
      new CompactSign(encoder.encode(JSON.stringify(request)))
        .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid, typ: GITHUB_TOKEN_REQUEST_TYPE })
        .sign(privateKey),
  };
}

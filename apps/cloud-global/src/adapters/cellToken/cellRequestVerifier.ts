import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  GITHUB_TOKEN_REQUEST_TYPE,
  type Region,
} from '@consola/cloud-contract';
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader } from 'jose';
import type { CellRequestVerifier } from '../../application/ports.js';
import type { Ed25519PublicJwk } from '../../config.js';

/**
 * Checks what a cell signed, with `jose` and the public key configured for each region's cell
 * (`CELL_PUBLIC_KEY_<REGION>`), each known by its JWK thumbprint (RFC 7638), which a cell names
 * as its `kid`. The key that checks a request says which region's cell sent it. Only
 * `CELL_TOKEN_ALGORITHM` is allowed, and only a request whose `typ` is the one asked for: a cell
 * token or an outbox message, which `cloud-global` signs with its own key, names no cell's key
 * and carries another `typ`, so neither is ever taken for a cell's request.
 */
export async function createCellRequestVerifier(
  keys: Partial<Record<Region, Ed25519PublicJwk>>,
): Promise<CellRequestVerifier> {
  const byKid = new Map<string, { region: Region; key: KeyObject }>();
  for (const [region, jwk] of Object.entries(keys) as [Region, Ed25519PublicJwk][]) {
    const { kty, crv, x } = jwk;
    const kid = await calculateJwkThumbprint({ kty, crv, x });
    byKid.set(kid, { region, key: createPublicKey({ key: { kty, crv, x }, format: 'jwk' }) });
  }
  const decoder = new TextDecoder();

  async function verify(signed: string, typ: string) {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(signed);
    } catch {
      return { kind: 'unsigned' as const };
    }
    if (header.typ !== typ || header.alg !== CELL_TOKEN_ALGORITHM) {
      return { kind: 'unsigned' as const };
    }
    const cell = typeof header.kid === 'string' ? byKid.get(header.kid) : undefined;
    if (!cell) return { kind: 'unsigned' as const };
    let bytes: Uint8Array;
    try {
      ({ payload: bytes } = await compactVerify(signed, cell.key, {
        algorithms: [CELL_TOKEN_ALGORITHM],
      }));
    } catch {
      return { kind: 'unsigned' as const };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(bytes));
    } catch {
      // Signed, but no JSON: the contract's reader refuses it as no request.
      payload = undefined;
    }
    return { kind: 'signed' as const, region: cell.region, payload };
  }

  return { verifyTokenRequest: (signed) => verify(signed, GITHUB_TOKEN_REQUEST_TYPE) };
}

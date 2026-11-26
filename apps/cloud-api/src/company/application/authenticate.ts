import { admitClaims } from '../domain/caller.js';
import type { Admission } from '../domain/caller.js';
import type { Region } from '../domain/region.js';
import type { Clock, TokenVerifier } from './ports.js';

/** Who a request comes from, or why the cell will not say. */
export type Authentication =
  | Admission
  /** The request carried no cell token. */
  | { kind: 'missing' }
  /** `cloud-global`'s keys could not be had, so the token could not be checked. */
  | { kind: 'keys-unavailable' };

/**
 * Who sent `token`, the cell token a request carried (null when it carried none), to the cell for
 * `cellRegion`. A token is accepted only if its signature checks with `cloud-global`'s keys and
 * the contract reads its claims, both at one moment, and then only if it is for a workspace in
 * this cell's region. Anything else is refused, and a token that cannot be checked is refused
 * too.
 */
export async function authenticate(
  ports: { tokens: TokenVerifier; clock: Clock },
  cellRegion: Region,
  token: string | null,
): Promise<Authentication> {
  if (token === null) return { kind: 'missing' };
  const nowSeconds = ports.clock.nowSeconds();
  const signature = await ports.tokens.verify(token, nowSeconds);
  if (signature.kind !== 'verified') return signature;
  return admitClaims(signature.payload, nowSeconds, cellRegion);
}

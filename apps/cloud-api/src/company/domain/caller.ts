import { readCellTokenClaims } from '@consola/cloud-contract';
import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import type { Region } from './region.js';

declare const fromCheckedToken: unique symbol;

/**
 * Who is asking, as the cell sees them: what a cell token `cloud-global` signed says, once its
 * signature, its claims and its region have been checked, and nothing else. The cell holds no
 * accounts, so a person is their global id and no more.
 *
 * Only `admitClaims` makes one (the brand below exists only for the type checker), so a use case
 * that takes a `Caller` gets the person and the workspace from the token, never from the request.
 */
export type Caller = {
  /** The person's global id, the one `cloud-global` gives them. */
  readonly personId: string;
  /** The workspace the token was minted for: its id in `cloud-global`. */
  readonly workspaceId: string;
  /** The person's role in that workspace when the token was minted. */
  readonly role: WorkspaceRole;
  /** The workspace's region, always the region of the cell that admitted it. */
  readonly region: Region;
  readonly [fromCheckedToken]: true;
};

/** What the claims of a token whose signature checked say about letting it in. */
export type Admission =
  | { kind: 'accepted'; caller: Caller }
  /** Claims the contract's reader refuses: a claim missing or extra, expired, too long-lived. */
  | { kind: 'invalid' }
  /** A good token for a workspace in another region, which this cell does not serve. */
  | { kind: 'other-region' };

/**
 * The rule for a token whose signature has been checked: it is accepted only if the contract
 * reads its claims at `nowSeconds`, and only then if its region is `cellRegion`. The region is
 * judged only on claims that read, so only a good token is told it reached the wrong cell.
 */
export function admitClaims(payload: unknown, nowSeconds: number, cellRegion: Region): Admission {
  const claims = readCellTokenClaims(payload, nowSeconds);
  if (!claims.ok) return { kind: 'invalid' };
  const { sub, ws, role, region } = claims.value;
  if (region !== cellRegion) return { kind: 'other-region' };
  const caller = { personId: sub, workspaceId: ws, role, region } as Caller;
  return { kind: 'accepted', caller };
}

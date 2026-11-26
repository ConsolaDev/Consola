import { cellTokenClaims } from '@consola/cloud-contract';
import type { Region } from '@consola/cloud-contract';
import type { SignedIn } from '../domain/person.js';
import type { CellTokenKeySet, CellTokenSigner, MembershipStore } from './ports.js';

/**
 * Mints the token a cell trusts, for the session's active workspace: who is asking, in which
 * workspace, with which role, in which region, until `CELL_TOKEN_LIFETIME_SECONDS` after
 * `issuedAt` (the time it is minted, in whole seconds since the epoch). The membership, the role
 * and the region are read from the store as they are now, never from the request, so a person no
 * longer in the workspace gets no token, and one whose role changed gets the new one. A session
 * that names no workspace is `no-workspace`; one that names a workspace the person is not in, or
 * one that is not there, is `not-a-member`.
 */
export async function mintCellToken(
  ports: { memberships: MembershipStore; signer: CellTokenSigner },
  session: SignedIn,
  issuedAt: number,
): Promise<
  | { kind: 'minted'; token: string; expiresAt: number; workspaceId: string; region: Region }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
> {
  const { person, activeWorkspaceId } = session;
  if (activeWorkspaceId === null) return { kind: 'no-workspace' };

  const workspace = await ports.memberships.workspaceFor({
    workspaceId: activeWorkspaceId,
    userId: person.id,
  });
  if (!workspace) return { kind: 'not-a-member' };

  const claims = cellTokenClaims({
    personId: person.id,
    workspaceId: workspace.id,
    role: workspace.role,
    region: workspace.region,
    issuedAt,
  });
  const token = await ports.signer.sign(claims);
  return {
    kind: 'minted',
    token,
    expiresAt: claims.exp,
    workspaceId: workspace.id,
    region: workspace.region,
  };
}

/** The public keys a cell checks cell tokens with. Reading them needs no sign-in. */
export function cellTokenKeys(signer: CellTokenSigner): CellTokenKeySet {
  return signer.publicKeys();
}

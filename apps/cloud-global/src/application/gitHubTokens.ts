import { readGitHubTokenRequest } from '@consola/cloud-contract';
import {
  type GrantedPermissions,
  grantedAsAsked,
  scopeFor,
  type TokenRequestProblem,
  uncoveredRepositories,
} from '../domain/gitHubTokens.js';
import type { CellRequestVerifier, GitHubApp, GitHubTokenMinter, TokenMintStore } from './ports.js';

/** How a cell's request for a GitHub token ended. */
export type TokenRequestOutcome =
  /**
   * The token, handed to the cell that asked and to nobody else: when it expires (whole seconds
   * since the epoch), and the repositories and permissions it carries, as GitHub granted them.
   */
  | {
      kind: 'minted';
      token: string;
      expiresAt: number;
      repositories: { id: number; fullName: string }[];
      permissions: GrantedPermissions;
    }
  /** No cell's key checks the request. */
  | { kind: 'unsigned' }
  /** Signed, but no request the contract reads; `reason` names the field, never its contents. */
  | { kind: 'unreadable'; reason: string }
  /** The repositories break the purpose's rules. */
  | { kind: 'invalid'; problems: TokenRequestProblem[] }
  /** The workspace holds no such installation, whether or not another workspace does. */
  | { kind: 'installation-not-found' }
  /** The workspace is in another region than the cell that signed the request. */
  | { kind: 'other-region' }
  /** This server has no GitHub App. */
  | { kind: 'not-configured' }
  /** GitHub no longer has the installation: uninstalled, or suspended. */
  | { kind: 'installation-gone' }
  /** The installation does not cover these repositories, by their GitHub ids. */
  | { kind: 'not-covered'; repositoryIds: number[] }
  /** GitHub refused the scope: a repository it no longer covers, or a permission not granted. */
  | { kind: 'refused' }
  /** GitHub minted something other than what was asked; it was revoked, and is not handed out. */
  | { kind: 'not-as-asked' }
  | { kind: 'unavailable' };

/**
 * Mints an installation token of Consola's GitHub App for a cell's signed request, narrowed to
 * the repositories it names and the permissions its purpose fixes, at `now` (whole seconds since
 * the epoch). Each check comes before anything is minted:
 *
 * 1. a region's cell signed the request, with the key configured for it;
 * 2. the contract reads it, in its time;
 * 3. its repositories keep the purpose's rules: at least one, no more than it allows, each once;
 * 4. the workspace holds the installation, and is in the signing cell's region, so a cell only
 *    ever gets a token for a workspace it serves, and a workspace only for its own installation;
 * 5. the installation covers every repository, as GitHub lists it now.
 *
 * Then GitHub mints, and what it granted is checked against what was asked: anything else is
 * revoked and never handed out. Every token handed out is recorded first; one that cannot be
 * recorded is revoked, and the error goes on.
 */
export async function mintGitHubToken(
  ports: {
    cellRequests: CellRequestVerifier;
    mints: TokenMintStore;
    github: (Pick<GitHubApp, 'repositoriesOf'> & GitHubTokenMinter) | null;
  },
  signedRequest: string,
  now: number,
): Promise<TokenRequestOutcome> {
  const verified = await ports.cellRequests.verifyTokenRequest(signedRequest);
  if (verified.kind === 'unsigned') return verified;
  const read = readGitHubTokenRequest(verified.payload, now);
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };
  const request = read.value;
  const asked = scopeFor(request);
  if (!asked.ok) return { kind: 'invalid', problems: asked.problems };
  const { scope } = asked;

  const holding = await ports.mints.holding({
    workspaceId: request.workspaceId,
    installationId: request.installationId,
  });
  if (!holding) return { kind: 'installation-not-found' };
  if (holding.region !== verified.region) return { kind: 'other-region' };

  const { github } = ports;
  if (!github) return { kind: 'not-configured' };
  const listed = await github.repositoriesOf(scope.installationId);
  if (listed.kind === 'gone') return { kind: 'installation-gone' };
  if (listed.kind === 'unavailable') return listed;
  const uncovered = uncoveredRepositories(scope, listed.repositories);
  if (uncovered.length > 0) return { kind: 'not-covered', repositoryIds: uncovered };

  const minted = await github.mintToken(scope.installationId, {
    repositoryIds: scope.repositoryIds,
    permissions: scope.permissions,
  });
  if (minted.kind === 'gone') return { kind: 'installation-gone' };
  if (minted.kind !== 'minted') return minted;

  const granted = {
    repositoryIds: minted.repositories.map((repository) => repository.id),
    permissions: minted.permissions,
  };
  if (!grantedAsAsked(scope, granted)) {
    await github.revokeToken(minted.token);
    return { kind: 'not-as-asked' };
  }
  // As asked, so exactly the purpose's permissions, and metadata read when GitHub names it.
  const permissions: GrantedPermissions = { ...scope.permissions };
  if (minted.permissions.metadata === 'read') permissions.metadata = 'read';

  try {
    await ports.mints.record({
      workspaceId: request.workspaceId,
      installationId: scope.installationId,
      purpose: request.purpose,
      repositoryIds: scope.repositoryIds,
      permissions,
      mintedAt: new Date(now * 1000),
      expiresAt: minted.expiresAt,
    });
  } catch (error) {
    await github.revokeToken(minted.token);
    throw error;
  }

  return {
    kind: 'minted',
    token: minted.token,
    expiresAt: Math.floor(minted.expiresAt.getTime() / 1000),
    repositories: minted.repositories,
    permissions,
  };
}

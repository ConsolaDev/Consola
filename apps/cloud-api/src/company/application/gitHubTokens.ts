import { grantedAsAsked, scopeFor, uncoveredRepositories } from '../domain/gitHubTokens.js';
import type {
  GitHubTokenPurpose,
  GrantedPermissions,
  TokenRequestProblem,
} from '../domain/gitHubTokens.js';
import type { GitHubApp, GitHubTokenMinter, TokenMintStore } from './gitHubPorts.js';
import type { Clock } from './ports.js';

/** What a token is asked for: the workspace's work it is for decides each of these. */
export type GitHubTokenRequest = {
  /** The workspace the token is for. */
  workspaceId: string;
  /** The installation of Consola's GitHub App the workspace holds: its id on GitHub. */
  installationId: number;
  purpose: GitHubTokenPurpose;
  /** The repositories the token is narrowed to, by their ids on GitHub, which a rename keeps. */
  repositoryIds: readonly number[];
};

/**
 * Where minting logs what went wrong that no outcome tells anyone: ids alone (the workspace, the
 * installation, the purpose), never a token or a repository's name.
 */
export type TokenMintLog = Pick<Console, 'error'>;

/** How a request for a GitHub token ended. */
export type TokenRequestOutcome =
  /**
   * The token, for the work that asked and nobody else: when it expires (whole seconds since the
   * epoch), and the repositories and permissions it carries, as GitHub granted them.
   */
  | {
      kind: 'minted';
      token: string;
      expiresAt: number;
      repositories: Array<{ id: number; fullName: string }>;
      permissions: GrantedPermissions;
    }
  /** The repositories break the purpose's rules. */
  | { kind: 'invalid'; problems: TokenRequestProblem[] }
  /** The workspace holds no such installation, whether or not another workspace does. */
  | { kind: 'installation-not-found' }
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
 * Mints an installation token of Consola's GitHub App for the workspace's own work, narrowed to
 * the repositories it names and the permissions its purpose fixes, at the clock's time. The
 * request comes from code in this app, never from a request's body: the workspace is the one
 * whose work the token is for. Each check comes before anything is minted:
 *
 * 1. its repositories keep the purpose's rules: at least one, no more than it allows, each once;
 * 2. the workspace holds the installation, so a workspace only ever gets a token for its own;
 * 3. the installation covers every repository, as GitHub lists it now.
 *
 * Then GitHub mints, and what it granted is checked against what was asked: anything else is
 * revoked, logged (`log`, by its ids) and never handed out. Every token handed out is recorded
 * first; one that cannot be recorded is revoked, and the error goes on.
 */
export async function mintGitHubToken(
  ports: {
    mints: TokenMintStore;
    github: (Pick<GitHubApp, 'repositoriesOf'> & GitHubTokenMinter) | null;
    clock: Clock;
    /** Where a mint GitHub granted other than asked is logged; left out, it is not. */
    log?: TokenMintLog;
  },
  request: GitHubTokenRequest,
): Promise<TokenRequestOutcome> {
  const asked = scopeFor(request);
  if (!asked.ok) return { kind: 'invalid', problems: asked.problems };
  const { scope } = asked;

  const holds = await ports.mints.holds({
    workspaceId: request.workspaceId,
    installationId: request.installationId,
  });
  if (!holds) return { kind: 'installation-not-found' };

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
    ports.log?.error(
      `GitHub minted a token other than the one asked for workspace ${request.workspaceId} ` +
        `(installation ${scope.installationId}, purpose ${request.purpose}); it was revoked.`,
    );
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
      mintedAt: new Date(ports.clock.nowSeconds() * 1000),
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

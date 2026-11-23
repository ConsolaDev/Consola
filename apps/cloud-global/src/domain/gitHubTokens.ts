import type { GitHubTokenPurpose } from '@consola/cloud-contract';

/** The permissions a token of Consola's may carry, by GitHub's names. */
export type GitHubPermission = 'contents' | 'pull_requests';

/** How much of a permission a token carries. */
export type GitHubAccess = 'read' | 'write';

export type GitHubPermissions = Partial<Record<GitHubPermission, GitHubAccess>>;

/**
 * What a token handed out carries: its purpose's permissions, and the metadata read GitHub gives
 * every installation token.
 */
export type GrantedPermissions = GitHubPermissions & { metadata?: 'read' };

/**
 * What each purpose a cell may ask a token for is given: its permissions, which the request
 * cannot widen, and how many repositories it may be narrowed to. Nothing else is ever minted
 * (decided 2026-11-21: one Consola GitHub App, each token narrowed to the repositories and
 * permissions it is needed for).
 *
 * - A run of the review automation reads its repositories and writes its review (epic 21).
 * - A repo-backed factory reads its one repository to pull its files (9.4) and writes it to save
 *   them (37.2). Pulling never needs write, so it gets its own, read-only purpose.
 */
export const TOKEN_PURPOSES: Record<
  GitHubTokenPurpose,
  { permissions: GitHubPermissions; maxRepositories: number }
> = {
  'review-run': { permissions: { contents: 'read', pull_requests: 'write' }, maxRepositories: 10 },
  'factory-pull': { permissions: { contents: 'read' }, maxRepositories: 1 },
  'factory-save': { permissions: { contents: 'write' }, maxRepositories: 1 },
};

/** What can be wrong with the repositories a request names, in the order they are checked. */
export const TOKEN_REQUEST_PROBLEMS = [
  'no-repositories',
  'too-many-repositories',
  'repeated-repository',
] as const;

export type TokenRequestProblem = (typeof TOKEN_REQUEST_PROBLEMS)[number];

/** Exactly what one token is narrowed to: one installation, its repositories, its permissions. */
export type TokenScope = {
  installationId: number;
  /** In ascending order, each once. */
  repositoryIds: number[];
  permissions: GitHubPermissions;
};

/**
 * The scope a request is for, or every problem with it. A request must name at least one
 * repository, so no token ever covers a whole installation, at most as many as its purpose allows,
 * and none twice.
 */
export function scopeFor(request: {
  installationId: number;
  purpose: GitHubTokenPurpose;
  repositoryIds: readonly number[];
}): { ok: true; scope: TokenScope } | { ok: false; problems: TokenRequestProblem[] } {
  const { permissions, maxRepositories } = TOKEN_PURPOSES[request.purpose];
  const { repositoryIds } = request;
  const problems: TokenRequestProblem[] = [];
  if (repositoryIds.length === 0) problems.push('no-repositories');
  if (repositoryIds.length > maxRepositories) problems.push('too-many-repositories');
  if (new Set(repositoryIds).size !== repositoryIds.length) problems.push('repeated-repository');
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    scope: {
      installationId: request.installationId,
      repositoryIds: [...repositoryIds].sort((a, b) => a - b),
      permissions: { ...permissions },
    },
  };
}

/** The repositories the scope names that the installation does not cover, as GitHub lists it. */
export function uncoveredRepositories(
  scope: TokenScope,
  covered: readonly { id: number }[],
): number[] {
  const ids = new Set(covered.map((repository) => repository.id));
  return scope.repositoryIds.filter((id) => !ids.has(id));
}

/**
 * Whether the token GitHub minted is exactly the one asked for: the same repositories, no more
 * and no fewer, and each permission at the level asked. GitHub gives every installation token
 * metadata read, so that one may be there too; anything else means the token is not narrowed as
 * asked, and it is never handed out.
 */
export function grantedAsAsked(
  scope: TokenScope,
  granted: { repositoryIds: readonly number[]; permissions: Readonly<Record<string, string>> },
): boolean {
  const asked = new Set(scope.repositoryIds);
  const got = new Set(granted.repositoryIds);
  if (got.size !== asked.size || [...got].some((id) => !asked.has(id))) return false;

  const wanted: Record<string, string> = { ...scope.permissions };
  for (const [name, level] of Object.entries(granted.permissions)) {
    if (name === 'metadata' && level === 'read' && !(name in wanted)) continue;
    if (wanted[name] !== level) return false;
  }
  return Object.keys(wanted).every((name) => granted.permissions[name] === wanted[name]);
}

/** One mint, as it is recorded: which workspace, why, what for, and when. */
export type TokenMint = {
  workspaceId: string;
  installationId: number;
  purpose: GitHubTokenPurpose;
  /** By their ids on GitHub, in ascending order: their names are the company's, and stay there. */
  repositoryIds: number[];
  /** As GitHub granted them. */
  permissions: Record<string, string>;
  mintedAt: Date;
  expiresAt: Date;
};

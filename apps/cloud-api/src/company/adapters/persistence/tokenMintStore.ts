import { and, asc, eq } from 'drizzle-orm';
import type { TokenMintStore } from '../../application/gitHubPorts.js';
import { isGitHubTokenPurpose } from '../../domain/gitHubTokens.js';
import type { TokenMint } from '../../domain/gitHubTokens.js';
import type { GitHubDatabase } from './gitHubStores.js';
import { githubInstallation, githubTokenMint as table } from './gitHubTables.js';

/**
 * The record of every GitHub token minted, in `github_token_mint`, and the one read a mint needs
 * first: whether the workspace holds the installation (`github_installation`).
 */
export function createTokenMintStore(db: GitHubDatabase): TokenMintStore {
  return {
    async holds({ workspaceId, installationId }) {
      const [row] = await db
        .select({ installationId: githubInstallation.installationId })
        .from(githubInstallation)
        .where(
          and(
            eq(githubInstallation.installationId, installationId),
            eq(githubInstallation.workspaceId, workspaceId),
          ),
        );
      return row !== undefined;
    },

    async record(mint) {
      await db.insert(table).values({
        workspaceId: mint.workspaceId,
        installationId: mint.installationId,
        purpose: mint.purpose,
        repositoryIds: mint.repositoryIds,
        permissions: mint.permissions,
        mintedAt: mint.mintedAt,
        expiresAt: mint.expiresAt,
      });
    },

    async mintsOf(workspaceId) {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.workspaceId, workspaceId))
        .orderBy(asc(table.mintedAt), asc(table.id));
      return rows.map(
        (row): TokenMint => ({
          workspaceId: row.workspaceId,
          installationId: row.installationId,
          purpose: purposeOf(row),
          repositoryIds: row.repositoryIds,
          permissions: row.permissions,
          mintedAt: row.mintedAt,
          expiresAt: row.expiresAt,
        }),
      );
    },
  };
}

/** A stored purpose, read back only when the domain names it: any other is no row of ours. */
function purposeOf(row: { id: number; purpose: string }): TokenMint['purpose'] {
  if (!isGitHubTokenPurpose(row.purpose)) {
    throw new Error(`The token mint ${row.id} has an unknown purpose, "${row.purpose}".`);
  }
  return row.purpose;
}

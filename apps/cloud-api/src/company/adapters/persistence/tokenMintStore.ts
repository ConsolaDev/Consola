import { isGitHubTokenPurpose } from '@consola/cloud-contract';
import { and, asc, eq } from 'drizzle-orm';
import type { TokenMintStore } from '../../application/ports.js';
import type { TokenMint } from '../../domain/gitHubTokens.js';
import type { Database } from './database.js';
import { regionOf } from './regionOf.js';
import { schema } from './schema.js';

const table = schema.githubTokenMint;

/**
 * The record of every GitHub token minted, in `github_token_mint`, and the one read a mint needs
 * first: whether the workspace holds the installation (`github_installation`), and its region
 * (`organization`), in one query.
 */
export function createTokenMintStore(db: Database): TokenMintStore {
  return {
    async holding({ workspaceId, installationId }) {
      const [row] = await db
        .select({ slug: schema.organization.slug, region: schema.organization.region })
        .from(schema.githubInstallation)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.githubInstallation.organizationId),
        )
        .where(
          and(
            eq(schema.githubInstallation.installationId, installationId),
            eq(schema.githubInstallation.organizationId, workspaceId),
          ),
        );
      return row ? { region: regionOf(row) } : null;
    },

    async record(mint) {
      await db.insert(table).values({
        organizationId: mint.workspaceId,
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
        .where(eq(table.organizationId, workspaceId))
        .orderBy(asc(table.mintedAt), asc(table.id));
      return rows.map(
        (row): TokenMint => ({
          workspaceId: row.organizationId,
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

/** A stored purpose, read back only when the contract names it: any other is no row of ours. */
function purposeOf(row: { id: number; purpose: string }): TokenMint['purpose'] {
  if (!isGitHubTokenPurpose(row.purpose)) {
    throw new Error(`The token mint ${row.id} has an unknown purpose, "${row.purpose}".`);
  }
  return row.purpose;
}

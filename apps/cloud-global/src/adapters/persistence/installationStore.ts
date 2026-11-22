import { and, asc, eq } from 'drizzle-orm';
import type { InstallationStore } from '../../application/ports.js';
import type { GitHubAccount } from '../../domain/connections.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

const table = schema.githubInstallation;

/**
 * A stored account type, read back only when it is one GitHub has. Any other value is a row
 * nothing here wrote, and it is an error rather than a guess.
 */
function accountTypeOf(row: {
  installationId: number;
  accountType: string;
}): GitHubAccount['type'] {
  if (row.accountType !== 'Organization' && row.accountType !== 'User') {
    throw new Error(
      `GitHub installation ${row.installationId} has an unknown account type, "${row.accountType}".`,
    );
  }
  return row.accountType;
}

/**
 * Installations in the `github_installation` table. `connect` inserts the row unless its
 * installation id is there already, so two workspaces claiming one installation at once get one
 * `connected` and one `taken`, never two owners.
 */
export function createInstallationStore(db: Database): InstallationStore {
  return {
    connect({ installation, workspaceId, connectedBy, at }) {
      const account = {
        accountId: installation.account.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
      };
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(table)
          .values({
            installationId: installation.id,
            organizationId: workspaceId,
            ...account,
            connectedBy,
            connectedAt: at,
          })
          .onConflictDoNothing({ target: table.installationId })
          .returning({ installationId: table.installationId });
        if (inserted) return 'connected';

        const updated = await tx
          .update(table)
          .set(account)
          .where(
            and(eq(table.installationId, installation.id), eq(table.organizationId, workspaceId)),
          )
          .returning({ installationId: table.installationId });
        return updated.length > 0 ? 'already-connected' : 'taken';
      });
    },

    async ofWorkspace(workspaceId) {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.organizationId, workspaceId))
        .orderBy(asc(table.connectedAt), asc(table.installationId));
      return rows.map((row) => ({
        id: row.installationId,
        account: { id: row.accountId, login: row.accountLogin, type: accountTypeOf(row) },
        connectedAt: row.connectedAt,
      }));
    },

    async disconnect({ workspaceId, installationId }) {
      const removed = await db
        .delete(table)
        .where(and(eq(table.installationId, installationId), eq(table.organizationId, workspaceId)))
        .returning({ installationId: table.installationId });
      return removed.length > 0;
    },
  };
}

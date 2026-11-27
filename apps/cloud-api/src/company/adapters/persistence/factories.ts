import { and, asc, eq, sql } from 'drizzle-orm';
import type { FactoryStore } from '../../application/ports.js';
import type { Factory, FactoryVersion } from '../../domain/factory.js';
import type { Database } from './database.js';
import { FOREIGN_KEY_VIOLATION, failedWith, UNIQUE_VIOLATION } from './sqlState.js';
import { factories, factoryFiles, factoryVersions } from './tables.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

/** The version a factory is made with, holding no files. */
const FIRST_VERSION = 1;

const inFactory = (workspaceId: string, factoryId: string) =>
  and(eq(factories.workspaceId, workspaceId), eq(factories.factoryId, factoryId));

const inVersion = (workspaceId: string, factoryId: string, version: number) =>
  and(
    eq(factoryVersions.workspaceId, workspaceId),
    eq(factoryVersions.factoryId, factoryId),
    eq(factoryVersions.version, version),
  );

/**
 * The workspace's factories, or just the one `factoryId` names, each with when its latest
 * version was saved: by name whatever its case.
 */
async function readFactories(
  db: Executor,
  workspaceId: string,
  factoryId?: string,
): Promise<Factory[]> {
  const rows = await db
    .select({
      id: factories.factoryId,
      name: factories.name,
      teamId: factories.teamId,
      source: factories.source,
      latestVersion: factories.latestVersion,
      updatedAt: factoryVersions.savedAt,
    })
    .from(factories)
    .innerJoin(
      factoryVersions,
      and(
        eq(factoryVersions.workspaceId, factories.workspaceId),
        eq(factoryVersions.factoryId, factories.factoryId),
        eq(factoryVersions.version, factories.latestVersion),
      ),
    )
    .where(
      factoryId === undefined
        ? eq(factories.workspaceId, workspaceId)
        : inFactory(workspaceId, factoryId),
    )
    .orderBy(sql`lower(${factories.name})`, asc(factories.factoryId));
  return rows.map(({ source, updatedAt, ...row }) => ({
    ...row,
    source: { kind: source },
    updatedAt: updatedAt.toISOString(),
  }));
}

/** One version of a factory, with its files by path (byte order, whatever the collation), or null. */
async function readVersion(
  db: Executor,
  workspaceId: string,
  factoryId: string,
  version: number,
): Promise<FactoryVersion | null> {
  const [saved] = await db
    .select({ savedAt: factoryVersions.savedAt, savedBy: factoryVersions.savedBy })
    .from(factoryVersions)
    .where(inVersion(workspaceId, factoryId, version));
  if (!saved) return null;
  const files = await db
    .select({ path: factoryFiles.path, content: factoryFiles.content })
    .from(factoryFiles)
    .where(
      and(
        eq(factoryFiles.workspaceId, workspaceId),
        eq(factoryFiles.factoryId, factoryId),
        eq(factoryFiles.version, version),
      ),
    )
    .orderBy(sql`${factoryFiles.path} collate "C"`);
  return {
    factoryId,
    version,
    savedAt: saved.savedAt.toISOString(),
    savedBy: saved.savedBy,
    files,
  };
}

/** The workspace's factories and their files' versions on the app's database. */
export function createFactoryStore(db: Database): FactoryStore {
  return {
    list(workspaceId) {
      return readFactories(db, workspaceId);
    },

    async get(workspaceId, factoryId) {
      return (await readFactories(db, workspaceId, factoryId))[0] ?? null;
    },

    async workspaceOf(factoryId) {
      const [row] = await db
        .select({ workspaceId: factories.workspaceId })
        .from(factories)
        .where(eq(factories.factoryId, factoryId))
        .limit(1);
      return row?.workspaceId ?? null;
    },

    async create(workspaceId, { name, teamId, personId }) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(factories)
            .values({ workspaceId, teamId, name, latestVersion: FIRST_VERSION })
            .returning({ id: factories.factoryId });
          if (!row) throw new Error('the new factory was not returned');
          await tx
            .insert(factoryVersions)
            .values({ workspaceId, factoryId: row.id, version: FIRST_VERSION, savedBy: personId });
          const [made] = await readFactories(tx, workspaceId, row.id);
          if (!made) throw new Error('the new factory was not read back');
          return made;
        });
      } catch (error) {
        if (failedWith(error, UNIQUE_VIOLATION)) return 'name-taken';
        // The only key a new factory points along that can be missing is its team's.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'team-not-found';
        throw error;
      }
    },

    async change(workspaceId, factoryId, { name, teamId }) {
      const set = {
        ...(name === undefined ? {} : { name }),
        ...(teamId === undefined ? {} : { teamId }),
      };
      try {
        return await db.transaction(async (tx) => {
          // One statement, so a rename and a move land together or not at all. A move is checked
          // by the factory's foreign key to its team, which holds the team's row (`for key
          // share`) until the transaction ends: a delete of that team in between waits for it,
          // then finds the team owns a factory; one made first leaves no team to move to.
          if (Object.keys(set).length > 0) {
            const changed = await tx
              .update(factories)
              .set(set)
              .where(inFactory(workspaceId, factoryId))
              .returning({ id: factories.factoryId });
            if (changed.length === 0) return 'not-found' as const;
          }
          const [factory] = await readFactories(tx, workspaceId, factoryId);
          return factory ?? ('not-found' as const);
        });
      } catch (error) {
        if (failedWith(error, UNIQUE_VIOLATION)) return 'name-taken';
        // The only key a change can break is the one to its team: the factory's own stays.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'team-not-found';
        throw error;
      }
    },

    version(workspaceId, factoryId, version) {
      return readVersion(db, workspaceId, factoryId, version);
    },

    save(workspaceId, factoryId, { baseVersion, files, personId }) {
      return db.transaction(async (tx) => {
        const version = baseVersion + 1;
        // The compare-and-set: of two saves from one version, the second finds it moved.
        const moved = await tx
          .update(factories)
          .set({ latestVersion: version })
          .where(and(inFactory(workspaceId, factoryId), eq(factories.latestVersion, baseVersion)))
          .returning({ id: factories.factoryId });
        if (moved.length === 0) {
          const [factory] = await tx
            .select({ latestVersion: factories.latestVersion })
            .from(factories)
            .where(inFactory(workspaceId, factoryId));
          return factory
            ? { kind: 'moved' as const, latestVersion: factory.latestVersion }
            : { kind: 'not-found' as const };
        }
        await tx
          .insert(factoryVersions)
          .values({ workspaceId, factoryId, version, savedBy: personId });
        if (files.length > 0) {
          await tx.insert(factoryFiles).values(
            files.map(({ path, content }) => ({
              workspaceId,
              factoryId,
              version,
              path,
              content,
            })),
          );
        }
        const saved = await readVersion(tx, workspaceId, factoryId, version);
        if (!saved) throw new Error('the saved version was not read back');
        return { kind: 'saved' as const, version: saved };
      });
    },
  };
}

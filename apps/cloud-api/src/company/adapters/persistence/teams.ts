import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { TeamStore } from '../../application/ports.js';
import type { Team } from '../../domain/team.js';
import type { Database, Transaction } from './database.js';
import { FOREIGN_KEY_VIOLATION, failedWith, UNIQUE_VIOLATION } from './sqlState.js';
import { teamMembers, teams } from './tables.js';

type Executor = Database | Transaction;

const isUniqueViolation = (error: unknown) => failedWith(error, UNIQUE_VIOLATION);

const inTeam = (workspaceId: string, teamId: string) =>
  and(eq(teams.workspaceId, workspaceId), eq(teams.teamId, teamId));

/**
 * The workspace's teams with their members, or just the one `teamId` names: the first team first,
 * then the others by name whatever its case, and each team's members in the order they joined.
 */
async function readTeams(db: Executor, workspaceId: string, teamId?: string): Promise<Team[]> {
  const rows = await db
    .select({ id: teams.teamId, name: teams.name, first: teams.isFirst })
    .from(teams)
    .where(teamId === undefined ? eq(teams.workspaceId, workspaceId) : inTeam(workspaceId, teamId))
    .orderBy(sql`${teams.isFirst} desc`, sql`lower(${teams.name})`, asc(teams.teamId));
  if (rows.length === 0) return [];

  const places = await db
    .select({ teamId: teamMembers.teamId, personId: teamMembers.personId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, workspaceId),
        inArray(
          teamMembers.teamId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(teamMembers.addedAt), asc(teamMembers.personId));

  const memberIds = new Map(rows.map((row) => [row.id, [] as string[]]));
  for (const place of places) memberIds.get(place.teamId)?.push(place.personId);
  return rows.map((row) => ({ ...row, memberIds: memberIds.get(row.id) ?? [] }));
}

/** One team with its members, or `not-found`. */
async function readTeam(
  db: Executor,
  workspaceId: string,
  teamId: string,
): Promise<Team | 'not-found'> {
  return (await readTeams(db, workspaceId, teamId))[0] ?? 'not-found';
}

/** The workspace's teams on company's database. */
export function createTeamStore(db: Database): TeamStore {
  return {
    list(workspaceId) {
      return readTeams(db, workspaceId);
    },

    async create(workspaceId, name) {
      try {
        const [row] = await db
          .insert(teams)
          .values({ workspaceId, name })
          .returning({ id: teams.teamId });
        if (!row) throw new Error('the new team was not returned');
        return { id: row.id, name, first: false, memberIds: [] };
      } catch (error) {
        if (isUniqueViolation(error)) return 'name-taken';
        throw error;
      }
    },

    async rename(workspaceId, teamId, name) {
      try {
        const renamed = await db
          .update(teams)
          .set({ name })
          .where(inTeam(workspaceId, teamId))
          .returning({ id: teams.teamId });
        if (renamed.length === 0) return 'not-found';
      } catch (error) {
        if (isUniqueViolation(error)) return 'name-taken';
        throw error;
      }
      return readTeam(db, workspaceId, teamId);
    },

    async remove(workspaceId, teamId) {
      // The first team is never deleted, whoever asks: the condition holds that, not a read
      // before the write that another request could slip between. A team that owns a factory
      // stays too, which the factory's foreign key holds.
      let deleted: Array<{ id: string }>;
      try {
        deleted = await db
          .delete(teams)
          .where(and(inTeam(workspaceId, teamId), eq(teams.isFirst, false)))
          .returning({ id: teams.teamId });
      } catch (error) {
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'owns-factories';
        throw error;
      }
      if (deleted.length === 1) return 'removed';
      const [kept] = await db
        .select({ id: teams.teamId })
        .from(teams)
        .where(inTeam(workspaceId, teamId));
      return kept ? 'first-team' : 'not-found';
    },

    async addMember(workspaceId, teamId, personId) {
      try {
        await db
          .insert(teamMembers)
          .values({ workspaceId, teamId, personId })
          .onConflictDoNothing();
      } catch (error) {
        // The place's foreign key names its team through both ids: no such team in the workspace.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'not-found';
        throw error;
      }
      return readTeam(db, workspaceId, teamId);
    },

    async removeMember(workspaceId, teamId, personId) {
      await db
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.workspaceId, workspaceId),
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.personId, personId),
          ),
        );
      return readTeam(db, workspaceId, teamId);
    },
  };
}

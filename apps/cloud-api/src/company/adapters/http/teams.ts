import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MembershipReader, TeamStore } from '../../application/ports.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam as deleteTeamUseCase,
  listTeams as listTeamsUseCase,
  removeTeamMember,
  renameTeam,
} from '../../application/teams.js';
import { behindCaller } from './caller.js';
import type { CallerCheck } from './caller.js';
import {
  deleteTeam,
  deleteTeamMember,
  listTeams,
  patchTeam,
  postTeam,
  putTeamMember,
} from './contract.js';

const NOT_ALLOWED = { error: 'not_allowed' } as const;
const TEAM_NOT_FOUND = { error: 'team_not_found' } as const;
const NAME_TAKEN = { error: 'name_taken' } as const;

/**
 * The teams routes, on `app`, each behind the caller check: each hands its use case the caller
 * the session names, and takes no workspace from the request. A team id in the path is looked up
 * in the caller's workspace alone, so another workspace's team is `team_not_found`.
 */
export function teamRoutes(
  app: OpenAPIHono,
  deps: { caller: CallerCheck; teams: TeamStore; membership: MembershipReader },
): void {
  const { caller, teams, membership } = deps;
  app.openapi(behindCaller(caller, listTeams), async (c) => {
    const answer = await listTeamsUseCase(teams, membership, c.var.caller);
    return c.json({ teams: answer.teams, canManage: answer.canManage }, 200);
  });

  app.openapi(behindCaller(caller, postTeam), async (c) => {
    const answer = await createTeam(teams, c.var.caller, c.req.valid('json'));
    switch (answer.kind) {
      case 'created':
        return c.json(answer.team, 201);
      case 'not-allowed':
        return c.json(NOT_ALLOWED, 403);
      case 'invalid':
        return c.json({ error: 'invalid_team', problems: answer.problems } as const, 400);
      case 'name-taken':
        return c.json(NAME_TAKEN, 409);
    }
  });

  app.openapi(behindCaller(caller, patchTeam), async (c) => {
    const { teamId } = c.req.valid('param');
    const answer = await renameTeam(teams, membership, c.var.caller, teamId, c.req.valid('json'));
    switch (answer.kind) {
      case 'renamed':
        return c.json(answer.team, 200);
      case 'not-allowed':
        return c.json(NOT_ALLOWED, 403);
      case 'invalid':
        return c.json({ error: 'invalid_team', problems: answer.problems } as const, 400);
      case 'not-found':
        return c.json(TEAM_NOT_FOUND, 404);
      case 'name-taken':
        return c.json(NAME_TAKEN, 409);
    }
  });

  app.openapi(behindCaller(caller, deleteTeam), async (c) => {
    const answer = await deleteTeamUseCase(teams, c.var.caller, c.req.valid('param').teamId);
    switch (answer.kind) {
      case 'deleted':
        return c.body(null, 204);
      case 'not-allowed':
        return c.json(NOT_ALLOWED, 403);
      case 'not-found':
        return c.json(TEAM_NOT_FOUND, 404);
      case 'first-team':
        return c.json({ error: 'first_team' } as const, 409);
      case 'owns-factories':
        return c.json({ error: 'owns_factories' } as const, 409);
    }
  });

  app.openapi(behindCaller(caller, putTeamMember), async (c) => {
    const { teamId, personId } = c.req.valid('param');
    const answer = await addTeamMember(teams, membership, c.var.caller, teamId, personId);
    switch (answer.kind) {
      case 'changed':
        return c.json(answer.team, 200);
      case 'not-allowed':
        return c.json(NOT_ALLOWED, 403);
      case 'not-found':
        return c.json(TEAM_NOT_FOUND, 404);
      case 'not-a-member':
        return c.json({ error: 'not_a_workspace_member' } as const, 409);
    }
  });

  app.openapi(behindCaller(caller, deleteTeamMember), async (c) => {
    const { teamId, personId } = c.req.valid('param');
    const answer = await removeTeamMember(teams, membership, c.var.caller, teamId, personId);
    switch (answer.kind) {
      case 'changed':
        return c.json(answer.team, 200);
      case 'not-allowed':
        return c.json(NOT_ALLOWED, 403);
      case 'not-found':
        return c.json(TEAM_NOT_FOUND, 404);
    }
  });
}

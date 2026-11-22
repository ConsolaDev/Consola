import {
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { createRoute, z } from '@hono/zod-openapi';
import { REGIONS } from '../../domain/region.js';
import { TEAM_NAME_MAX, TEAM_PROBLEMS } from '../../domain/team.js';

/**
 * The cell's contract: every route it serves, what each takes and every answer it gives. `app.ts`
 * implements these routes, and TypeScript checks each handler's answers against them.
 * `openapi.json` is generated from them (`openapi.test.ts`), and the web app's client for the
 * cell is generated from that.
 *
 * Answers are strict objects: the HTTP suite checks every body it gets against them, so a field
 * the contract does not name fails a test. Request bodies are checked for their shape only, never
 * for the domain's rules: `checkTeamName` names a team name's problems, whatever its schema says.
 */

const Region = z.enum(REGIONS);

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const body = <Schema extends z.ZodType>(schema: Schema) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

/**
 * What every route behind the token check can answer before it runs (`caller.ts`). Spread into
 * each such route's responses, so the contract says it once.
 */
const tokenFailures = {
  401: {
    content: {
      'application/json': {
        schema: z.union([failure('token_required'), failure('invalid_token')]),
      },
    },
    description:
      'No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): ' +
      'malformed, forged, expired, or signed by a key cloud-global does not publish. A new token ' +
      'is the fix.',
  },
  421: json(
    z.strictObject({ error: z.literal('wrong_region'), region: Region }),
    "A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix.",
  ),
  503: json(
    failure('token_check_unavailable'),
    "The cell cannot get cloud-global's keys just now, so it checks no token.",
  ),
} as const;

const unsupportedMediaType = json(
  failure('unsupported_media_type'),
  'The body is not JSON (`Content-Type: application/json`).',
);
const notAllowed = json(failure('not_allowed'), 'The caller’s role does not manage teams.');
const workspacePending = json(
  failure('workspace_pending'),
  'The cell does not hold the workspace yet: cloud-global has not delivered its creation. ' +
    'Asking again later helps.',
);
const teamNotFound = json(
  failure('team_not_found'),
  'The workspace has no team with that id, whether or not another workspace does.',
);

const TeamId = z.string().openapi({ param: { name: 'teamId', in: 'path' } });
const PersonId = z
  .string()
  .openapi({ param: { name: 'personId', in: 'path' }, description: "The person's global id." });

// The health check and the outbox: the two routes that take no token.

export const getHealth = createRoute({
  method: 'get',
  path: '/api/health',
  summary: 'Whether the cell can reach its database, and which region it serves',
  description: 'Needs no token: it says nothing a workspace holds.',
  responses: {
    200: json(z.strictObject({ ok: z.literal(true), region: Region }), 'It can.'),
    503: json(z.strictObject({ ok: z.literal(false), region: Region }), 'It cannot.'),
  },
});

export const postOutboxDelivery = createRoute({
  method: 'post',
  path: OUTBOX_DELIVERY_PATH,
  summary: "Deliver one of cloud-global's outbox messages",
  description:
    'Only cloud-global calls it. The body is the message, signed as a compact JWS with the cell ' +
    'token’s key (`packages/cloud-contract`, "Delivering a message"), so it takes no token.',
  request: {
    body: {
      content: { [OUTBOX_DELIVERY_MEDIA_TYPE]: { schema: z.string() } },
      required: true,
    },
  },
  responses: {
    200: json(
      z.strictObject({ applied: z.literal(true) }),
      'The cell has the message: applied now, or before.',
    ),
    400: json(
      failure('unreadable'),
      'Not sent as a signed message, over the size a message can be, or not a message the contract reads.',
    ),
    401: json(failure('unsigned'), 'Not signed by cloud-global.'),
    409: json(
      z.strictObject({ nextSequence: z.number().int() }),
      "Messages before this one are missing: the sequence of the workspace's message the cell applies next.",
    ),
    421: json(
      z.strictObject({ error: z.literal('otherRegion'), region: Region }),
      'A message about a workspace in another region.',
    ),
    503: json(failure('unavailable'), "The cell cannot get cloud-global's keys or its database."),
  },
});

// Behind the token check.

export const Caller = z
  .strictObject({
    personId: z.string(),
    workspaceId: z.string(),
    role: z.enum(WORKSPACE_ROLES),
    region: Region,
  })
  .openapi('Caller', { description: 'Who is asking, as their checked cell token says.' });

export const getMe = createRoute({
  method: 'get',
  path: '/api/me',
  summary: 'Who is asking, as this cell sees them',
  responses: { 200: json(Caller, 'The caller.'), ...tokenFailures },
});

export const Team = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    first: z.boolean().openapi({
      description:
        "Whether it is the workspace's first team, which every new member joins and which is never deleted.",
    }),
    memberIds: z
      .array(z.string())
      .openapi({ description: 'Its members’ global ids, in the order they joined it.' }),
  })
  .openapi('Team');

export const TeamList = z
  .strictObject({
    teams: z.array(Team),
    canManage: z.boolean().openapi({
      description:
        'Whether the caller may make, rename and delete teams, and choose their members.',
    }),
  })
  .openapi('TeamList', {
    description:
      'The teams the caller sees: every team for owners and admins, the ones they are in for a member.',
  });

export const TeamName = z.object({ name: z.string() }).openapi('TeamName', {
  description: `A name (trimmed, 1 to ${TEAM_NAME_MAX} characters, no control characters), unique in the workspace whatever its case.`,
});

const InvalidTeam = z
  .strictObject({ error: z.literal('invalid_team'), problems: z.array(z.enum(TEAM_PROBLEMS)) })
  .openapi('InvalidTeam', { description: 'Every problem with the name, at once.' });

const refusedName = {
  content: {
    'application/json': { schema: z.union([InvalidTeam, failure('invalid_request')]) },
  },
  description: 'The rules refuse the name, or the body is not what the route takes.',
};

export const listTeams = createRoute({
  method: 'get',
  path: '/api/teams',
  summary: "The caller's workspace's teams, as the caller sees them",
  responses: {
    200: json(TeamList, 'The teams.'),
    409: workspacePending,
    ...tokenFailures,
  },
});

export const postTeam = createRoute({
  method: 'post',
  path: '/api/teams',
  summary: 'Make a team, with nobody in it',
  request: body(TeamName),
  responses: {
    201: json(Team, 'The team made.'),
    400: refusedName,
    403: notAllowed,
    409: {
      content: {
        'application/json': {
          schema: z.union([failure('name_taken'), failure('workspace_pending')]),
        },
      },
      description:
        'Another team of the workspace has the name, in any case (`name_taken`), or the cell does not hold the workspace yet (`workspace_pending`).',
    },
    415: unsupportedMediaType,
    ...tokenFailures,
  },
});

const teamParams = z.object({ teamId: TeamId });
const memberParams = z.object({ teamId: TeamId, personId: PersonId });

export const patchTeam = createRoute({
  method: 'patch',
  path: '/api/teams/{teamId}',
  summary: 'Rename a team, the first one included',
  request: { params: teamParams, ...body(TeamName) },
  responses: {
    200: json(Team, 'The team, renamed.'),
    400: refusedName,
    403: notAllowed,
    404: teamNotFound,
    409: {
      content: {
        'application/json': {
          schema: z.union([failure('name_taken'), failure('workspace_pending')]),
        },
      },
      description:
        'Another team of the workspace has the name, in any case, or the cell does not hold the workspace yet.',
    },
    415: unsupportedMediaType,
    ...tokenFailures,
  },
});

export const deleteTeam = createRoute({
  method: 'delete',
  path: '/api/teams/{teamId}',
  summary: 'Delete a team, and every place in it',
  request: { params: teamParams },
  responses: {
    204: { description: 'The team is gone.' },
    403: notAllowed,
    404: teamNotFound,
    409: {
      content: {
        'application/json': {
          schema: z.union([failure('first_team'), failure('workspace_pending')]),
        },
      },
      description:
        "The workspace's first team, which is never deleted (`first_team`), or the cell does not hold the workspace yet.",
    },
    ...tokenFailures,
  },
});

export const putTeamMember = createRoute({
  method: 'put',
  path: '/api/teams/{teamId}/members/{personId}',
  summary: 'Make a member of the workspace a member of a team',
  description: 'Someone already in the team stays as they are.',
  request: { params: memberParams },
  responses: {
    200: json(Team, 'The team, with the person in it.'),
    403: notAllowed,
    404: teamNotFound,
    409: {
      content: {
        'application/json': {
          schema: z.union([failure('not_a_workspace_member'), failure('workspace_pending')]),
        },
      },
      description:
        'The person is not a member of the workspace (`not_a_workspace_member`), or the cell does not hold the workspace yet.',
    },
    ...tokenFailures,
  },
});

export const deleteTeamMember = createRoute({
  method: 'delete',
  path: '/api/teams/{teamId}/members/{personId}',
  summary: 'Take a person out of a team',
  description: 'Someone not in the team changes nothing.',
  request: { params: memberParams },
  responses: {
    200: json(Team, 'The team, without the person.'),
    403: notAllowed,
    404: teamNotFound,
    409: workspacePending,
    ...tokenFailures,
  },
});

/** Every route in the contract, in the order `app.ts` registers them. */
export const ROUTES = [
  getHealth,
  postOutboxDelivery,
  getMe,
  listTeams,
  postTeam,
  patchTeam,
  deleteTeam,
  putTeamMember,
  deleteTeamMember,
];

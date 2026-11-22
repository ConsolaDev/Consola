import {
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { createRoute, z } from '@hono/zod-openapi';
import {
  FACTORY_BYTES_MAX,
  FACTORY_FILES_MAX,
  FACTORY_NAME_MAX,
  FACTORY_NAME_PROBLEMS,
} from '../../domain/factory.js';
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

// The health check, the outbox and GitHub's events: the three routes that take no token.

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

export const postGitHubEventDelivery = createRoute({
  method: 'post',
  path: GITHUB_EVENT_DELIVERY_PATH,
  summary: 'Deliver one of GitHub’s webhook events, passed on by cloud-global',
  description:
    'Only cloud-global calls it, for a workspace whose GitHub installation the event came ' +
    'through. The body is the event, signed as a compact JWS with the cell token’s key ' +
    '(`packages/cloud-contract`, "Passing on a GitHub event"), so it takes no token. The cell ' +
    'records each delivery once, by GitHub’s id of it.',
  request: {
    body: {
      content: { [GITHUB_EVENT_DELIVERY_MEDIA_TYPE]: { schema: z.string() } },
      required: true,
    },
  },
  responses: {
    200: json(
      z.strictObject({ recorded: z.literal(true) }),
      'The cell had recorded the event before: a delivery sent again, which changed nothing.',
    ),
    201: json(z.strictObject({ recorded: z.literal(true) }), 'The cell recorded the event now.'),
    400: json(
      failure('unreadable'),
      'Not sent as a signed event, over the size an event can be, or not an event the contract reads.',
    ),
    401: json(failure('unsigned'), 'Not signed by cloud-global as an event.'),
    409: json(
      failure('workspacePending'),
      'The cell does not hold the workspace yet: cloud-global has not delivered its creation.',
    ),
    421: json(
      z.strictObject({ error: z.literal('otherRegion'), region: Region }),
      'An event for a workspace in another region.',
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
          schema: z.union([
            failure('first_team'),
            failure('owns_factories'),
            failure('workspace_pending'),
          ]),
        },
      },
      description:
        "The workspace's first team, which is never deleted (`first_team`), a team that owns a factory, which is not deleted while it does (`owns_factories`), or the cell does not hold the workspace yet.",
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

// Factories: a team's, its files stored in the cell and versioned (`domain/factory.ts`).

const factoryNotFound = json(
  failure('factory_not_found'),
  'The workspace has no factory with that id that the caller sees: none, or one of a team a member is not in.',
);

const FactoryId = z.string().openapi({ param: { name: 'factoryId', in: 'path' } });
const VersionNumber = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/)
  .openapi({
    param: { name: 'version', in: 'path' },
    description: "A version's number: 1 for the blank version a factory is made with.",
  });

export const FactorySource = z
  .strictObject({ kind: z.literal('stored') })
  .openapi('FactorySource', {
    description:
      "Where the factory's files come from: `stored`, saved in the cell. A GitHub repository comes later.",
  });

export const Factory = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    teamId: z.string().openapi({ description: 'The team that owns it.' }),
    source: FactorySource,
    latestVersion: z.number().int().openapi({
      description:
        "Its latest version's number: 1 until its files are first saved, and one more with each save.",
    }),
    updatedAt: z
      .string()
      .openapi({ description: 'When its latest version was saved, as an ISO 8601 time.' }),
  })
  .openapi('Factory');

export const FactoryList = z.strictObject({ factories: z.array(Factory) }).openapi('FactoryList', {
  description:
    'The factories the caller sees, by name: every factory for owners and admins, the factories of the teams they are in for a member.',
});

export const FactoryFile = z
  .strictObject({
    path: z.string().openapi({
      description:
        "Its path inside the factory's folder: `factory.yml`, `automations/<name>.yaml`, `agents/<name>.md`, `skills/<name>/…`.",
    }),
    content: z.string().openapi({ description: 'Its text.' }),
  })
  .openapi('FactoryFile');

export const FactoryVersion = z
  .strictObject({
    factoryId: z.string(),
    version: z.number().int(),
    savedAt: z.string().openapi({ description: 'When it was saved, as an ISO 8601 time.' }),
    savedBy: z.string().openapi({ description: 'The global id of the person who saved it.' }),
    files: z.array(FactoryFile).openapi({ description: 'Its files, by path.' }),
  })
  .openapi('FactoryVersion', { description: "One version of a factory's files, as saved." });

export const FactoryWithFiles = z
  .strictObject({ factory: Factory, version: FactoryVersion })
  .openapi('FactoryWithFiles', {
    description: 'A factory, and its latest version with its files.',
  });

const FactoryIssue = z
  .strictObject({
    message: z.string(),
    file: z.string().optional().openapi({
      description: 'The file the problem is in; absent for a problem with the set as a whole.',
    }),
    path: z.string().openapi({
      description:
        'Where in the file, as a dotted path into its document (`automations[0].mode`); empty for the whole file.',
    }),
    line: z.number().int().optional().openapi({ description: 'The line, from 1, when known.' }),
    automation: z
      .string()
      .optional()
      .openapi({ description: 'The automation the problem belongs to, when it has a name.' }),
    cause: z.string().optional().openapi({
      description:
        "The file (or skill's folder) whose own problems this one only shows through: a step's agent, an agent's skill.",
    }),
  })
  .openapi('FactoryIssue', {
    description: 'A problem with the files, as the factory schema words it.',
  });

const FactoryNotice = z
  .strictObject({
    message: z.string(),
    file: z.string().optional(),
    line: z.number().int().optional(),
  })
  .openapi('FactoryNotice', {
    description:
      'Something the factory schema says about the files that refuses nothing, such as a folder a later slice reads.',
  });

export const SavedFactoryVersion = z
  .strictObject({ version: FactoryVersion, notices: z.array(FactoryNotice) })
  .openapi('SavedFactoryVersion', { description: 'The version saved, and what to know about it.' });

const InvalidFactory = z
  .strictObject({
    error: z.literal('invalid_factory'),
    problems: z.array(z.enum(FACTORY_NAME_PROBLEMS)),
  })
  .openapi('InvalidFactory', { description: 'Every problem with the name, at once.' });

const InvalidFiles = z
  .strictObject({ error: z.literal('invalid_files'), issues: z.array(FactoryIssue) })
  .openapi('InvalidFiles', {
    description:
      'Files that fail the factory schema: every problem, each naming its file. Nothing is saved.',
  });

export const NewFactory = z.object({ name: z.string(), teamId: z.string() }).openapi('NewFactory', {
  description: `A name (trimmed, 1 to ${FACTORY_NAME_MAX} characters, no control characters), unique in the workspace whatever its case, and the id of the team that owns it.`,
});

export const NewFactoryVersion = z
  .object({
    baseVersion: z.number().int().openapi({
      description:
        'The version the files were edited from, which must still be the latest: a save never undoes one it did not see.',
    }),
    files: z.array(z.object({ path: z.string(), content: z.string() })).openapi({
      description: `Every file of the new version (at most ${FACTORY_FILES_MAX}, ${FACTORY_BYTES_MAX / (1024 * 1024)} MB in all): a file left out is not in it.`,
    }),
  })
  .openapi('NewFactoryVersion');

export const listFactories = createRoute({
  method: 'get',
  path: '/api/factories',
  summary: "The caller's workspace's factories, as the caller sees them",
  responses: {
    200: json(FactoryList, 'The factories.'),
    409: workspacePending,
    ...tokenFailures,
  },
});

export const postFactory = createRoute({
  method: 'post',
  path: '/api/factories',
  summary: 'Make a blank factory, owned by a team',
  description:
    'Its files are stored in the cell, and its first version holds none. Owners and admins may make one for any team, a member for a team they are in.',
  request: body(NewFactory),
  responses: {
    201: json(Factory, 'The factory made.'),
    400: {
      content: {
        'application/json': { schema: z.union([InvalidFactory, failure('invalid_request')]) },
      },
      description: 'The rules refuse the name, or the body is not what the route takes.',
    },
    404: json(
      failure('team_not_found'),
      'The workspace has no team with that id that the caller sees: none, or one a member is not in.',
    ),
    409: {
      content: {
        'application/json': {
          schema: z.union([failure('name_taken'), failure('workspace_pending')]),
        },
      },
      description:
        'Another factory of the workspace has the name, in any case (`name_taken`), or the cell does not hold the workspace yet (`workspace_pending`).',
    },
    415: unsupportedMediaType,
    ...tokenFailures,
  },
});

const factoryParams = z.object({ factoryId: FactoryId });

export const getFactory = createRoute({
  method: 'get',
  path: '/api/factories/{factoryId}',
  summary: 'A factory, with its latest version’s files',
  request: { params: factoryParams },
  responses: {
    200: json(FactoryWithFiles, 'The factory and its latest version.'),
    404: factoryNotFound,
    409: workspacePending,
    ...tokenFailures,
  },
});

export const getFactoryVersion = createRoute({
  method: 'get',
  path: '/api/factories/{factoryId}/versions/{version}',
  summary: "One version of a factory's files, an earlier one or the latest",
  request: { params: z.object({ factoryId: FactoryId, version: VersionNumber }) },
  responses: {
    200: json(FactoryVersion, 'The version.'),
    400: json(failure('invalid_request'), 'The version is not a number from 1.'),
    404: {
      content: {
        'application/json': {
          schema: z.union([failure('factory_not_found'), failure('version_not_found')]),
        },
      },
      description:
        'The caller sees no such factory (`factory_not_found`), or it has no version with that number (`version_not_found`).',
    },
    409: workspacePending,
    ...tokenFailures,
  },
});

export const postFactoryVersion = createRoute({
  method: 'post',
  path: '/api/factories/{factoryId}/versions',
  summary: "Save a factory's files as its next version",
  description:
    'The files must keep the factory schema (`packages/factory-spec`), and `baseVersion` must still be the latest version. Whoever sees the factory may save it.',
  request: { params: factoryParams, ...body(NewFactoryVersion) },
  responses: {
    201: json(SavedFactoryVersion, 'The version saved.'),
    400: {
      content: {
        'application/json': { schema: z.union([InvalidFiles, failure('invalid_request')]) },
      },
      description:
        'The files fail the factory schema (`invalid_files`), or the body is not what the route takes.',
    },
    404: factoryNotFound,
    409: {
      content: {
        'application/json': {
          schema: z.union([
            z
              .strictObject({ error: z.literal('version_moved'), latestVersion: z.number().int() })
              .openapi('VersionMoved', {
                description:
                  'The latest version is no longer `baseVersion`: someone saved since. Nothing is saved.',
              }),
            failure('workspace_pending'),
          ]),
        },
      },
      description:
        'The factory has a newer version than the one the files were edited from (`version_moved`), or the cell does not hold the workspace yet.',
    },
    413: json(failure('too_large'), 'The body is larger than any factory’s files can be.'),
    415: unsupportedMediaType,
    ...tokenFailures,
  },
});

/** Every route in the contract, in the order `app.ts` registers them. */
export const ROUTES = [
  getHealth,
  postOutboxDelivery,
  postGitHubEventDelivery,
  getMe,
  listTeams,
  postTeam,
  patchTeam,
  deleteTeam,
  putTeamMember,
  deleteTeamMember,
  listFactories,
  postFactory,
  getFactory,
  getFactoryVersion,
  postFactoryVersion,
];

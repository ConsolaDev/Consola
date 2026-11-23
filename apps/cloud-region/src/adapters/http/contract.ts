import {
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { AUTOMATION_MODES } from '@consola/factory-spec';
import { createRoute, z } from '@hono/zod-openapi';
import {
  FACTORY_BYTES_MAX,
  FACTORY_FILES_MAX,
  FACTORY_NAME_MAX,
  FACTORY_NAME_PROBLEMS,
} from '../../domain/factory.js';
import { REGIONS } from '../../domain/region.js';
import {
  ITEM_KINDS,
  OUTPUT_TAIL_MAX,
  PHASES,
  RUN_KINDS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  STEP_KINDS,
  STEP_STATUSES,
  TITLE_MAX,
  WAITING_ON,
} from '../../domain/run.js';
import { APPROVAL_DECISIONS } from '../../domain/runApproval.js';
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

export const FactoryChange = z
  .object({
    name: z
      .string()
      .optional()
      .openapi({
        description: `Its new name (trimmed, 1 to ${FACTORY_NAME_MAX} characters, no control characters), unique in the workspace whatever its case.`,
      }),
    teamId: z
      .string()
      .optional()
      .openapi({ description: 'The id of the team that owns it from now on.' }),
  })
  .refine((change) => change.name !== undefined || change.teamId !== undefined)
  .openapi('FactoryChange', {
    minProperties: 1,
    description:
      'What changes, at least one of the two: both at once is one change, made whole or not at all. Its files and where they come from are not changed here.',
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

export const patchFactory = createRoute({
  method: 'patch',
  path: '/api/factories/{factoryId}',
  summary: 'Rename a factory, or move it to another team',
  description:
    'Whoever sees the factory may rename it. Moving it needs the caller to see the team it moves to as well: owners and admins any team, a member a team they are in. Its versions stay as they are.',
  request: { params: factoryParams, ...body(FactoryChange) },
  responses: {
    200: json(Factory, 'The factory, changed.'),
    400: {
      content: {
        'application/json': { schema: z.union([InvalidFactory, failure('invalid_request')]) },
      },
      description:
        'The rules refuse the name, or the body is not what the route takes: neither a name nor a team is one.',
    },
    404: {
      content: {
        'application/json': {
          schema: z.union([failure('factory_not_found'), failure('team_not_found')]),
        },
      },
      description:
        'The caller sees no such factory (`factory_not_found`), or no such team to move it to (`team_not_found`): none, or one a member is not in.',
    },
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

// Runs: what each factory's runners ran, a request and the automation runs it started among them
// (`domain/run.ts`). Read only: a runner records runs through the store, never over HTTP.

const iso = (what: string) => z.string().openapi({ description: `${what}, as an ISO 8601 time.` });

export const Phase = z.enum(PHASES).openapi('Phase', {
  description:
    "The cell's grouping of a run's status, which the list filters and counts by: `active` (queued, running, waiting on a run), `needs-you` (needs approval, waiting on a person, or a request at work one of whose runs needs someone), `completed`, `failed` (failed, expired) and `stopped` (cancelled, rejected).",
});

export const RunStatus = z.enum(RUN_STATUSES).openapi('RunStatus', {
  description: "A run's status. The set only grows.",
});

export const RunTrigger = z.enum(RUN_TRIGGERS).openapi('RunTrigger', {
  description:
    'How a run was started: a schedule (`cron`), an event, a poll, or someone’s act (`manual`). A run a request started is `manual`.',
});

export const RunKind = z.enum(RUN_KINDS).openapi('RunKind', {
  description:
    'A `request`, whose one step is its factory’s orchestrator, or an `automation` run, with steps.',
});

export const StepKind = z.enum(STEP_KINDS).openapi('StepKind');

export const StepStatus = z.enum(STEP_STATUSES).openapi('StepStatus', {
  description: "A step's status. The set only grows.",
});

export const RunItem = z
  .strictObject({
    url: z.string().openapi({ description: 'Its page, an https address.' }),
    title: z.string().openapi({ description: 'Written by its author: text, never markup.' }),
    kind: z.enum(ITEM_KINDS).nullable(),
    repo: z.string().nullable().openapi({ description: '`owner/name`, when known.' }),
    number: z.number().int().nullable(),
  })
  .openapi('RunItem', { description: 'The pull request or issue a run is about.' });

export const PhaseCounts = z
  .strictObject({
    active: z.number().int(),
    'needs-you': z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    stopped: z.number().int(),
  })
  .openapi('PhaseCounts', { description: 'How many runs are in each phase.' });

export const RunSummary = z
  .strictObject({
    id: z.string(),
    kind: RunKind,
    title: z.string().openapi({
      description: `A request: its item's title, else its text's first line; an automation run: its item's title, else its automation's name. At most ${TITLE_MAX} characters, on one line.`,
    }),
    status: RunStatus,
    phase: Phase,
    waitingOn: z
      .enum(WAITING_ON)
      .nullable()
      .openapi({ description: 'What a waiting run waits on; set exactly while it is `waiting`.' }),
    factory: z
      .strictObject({ id: z.string(), name: z.string(), version: z.number().int() })
      .openapi({ description: 'Its factory, and the version of it the run executed.' }),
    teamId: z.string().openapi({ description: "The team that owns the run's factory now." }),
    automation: z
      .string()
      .nullable()
      .openapi({ description: "The automation's name; null exactly for a request." }),
    parentId: z
      .string()
      .nullable()
      .openapi({ description: 'The request that started it, on an automation run one did.' }),
    trigger: RunTrigger,
    triggerDetail: z.string().nullable().openapi({
      description:
        "What the trigger was: the event's name (`pull_request.opened`), the cron schedule, or the poll's check.",
    }),
    startedBy: z.string().nullable().openapi({
      description:
        'The global id of the person who started it, who may no longer be a member; null for a run no person started.',
    }),
    item: z.union([RunItem, z.null()]),
    runner: z.string().openapi({ description: 'Which runner ran it: `cloud` for now.' }),
    progress: z
      .strictObject({
        total: z.number().int(),
        done: z.number().int().openapi({ description: 'Steps that have ended.' }),
        current: z
          .string()
          .nullable()
          .openapi({ description: 'The id of the first step running or waiting.' }),
      })
      .nullable()
      .openapi({ description: "An automation run's steps; null for a request." }),
    children: z
      .strictObject({
        total: z.number().int(),
        active: z.number().int(),
        needsYou: z.number().int(),
        failed: z.number().int(),
      })
      .nullable()
      .openapi({ description: 'The automation runs a request started, by phase; null otherwise.' }),
    summary: z.string().nullable().openapi({ description: 'One sentence once it ends.' }),
    error: z.string().nullable(),
    costUsd: z.number().nullable().openapi({
      description:
        "The CLI's estimate, in dollars; a request's counts its runs too. Null while none was reported.",
    }),
    createdAt: iso('When it was made'),
    startedAt: iso('When it started working').nullable(),
    finishedAt: iso('When it ended').nullable(),
    updatedAt: iso('When its runner last recorded it'),
  })
  .openapi('RunSummary');

export const LineRange = z
  .strictObject({ start: z.number().int(), end: z.number().int() })
  .openapi('LineRange', { description: 'Lines of a file, from 1, both ends included.' });

export const StepDefinition = z
  .strictObject({
    kind: z.enum(['agent', 'run']),
    prompt: z
      .string()
      .nullable()
      .openapi({ description: 'The prompt as written: a template, never rendered.' }),
    action: z.string().nullable(),
    agent: z
      .string()
      .nullable()
      .openapi({ description: 'The agent it runs as (`agents/<name>.md`).' }),
    run: z.string().nullable().openapi({ description: 'The command, as written.' }),
    env: z
      .array(z.strictObject({ name: z.string(), value: z.string() }))
      .openapi({ description: "The command's environment, as written (templates)." }),
    if: z.string().nullable().openapi({ description: 'Its condition, as written.' }),
    outputs: z
      .array(z.strictObject({ name: z.string(), type: z.string() }))
      .openapi({ description: 'The outputs it declares, each type in words (`one of: a, b`).' }),
    artifacts: z.array(z.string()).openapi({ description: 'The artifacts it declares.' }),
    maxTurns: z.number().int().nullable(),
    timeoutMs: z.number().int().nullable().openapi({ description: "A command's time limit." }),
    file: z.string().openapi({ description: 'The file it is written in, in the factory.' }),
    version: z.number().int().openapi({ description: 'The factory version it was read from.' }),
    range: z.union([LineRange, z.null()]).openapi({
      description: "The step's lines in its run's `source.text`; null when they are not known.",
    }),
  })
  .openapi('StepDefinition', {
    description:
      "What a step was asked, as its automation's file says at the factory version the run executed.",
  });

export const StepSummary = z
  .strictObject({
    id: z.string().openapi({ description: "The step's id in its automation, or `orchestrator`." }),
    kind: StepKind,
    status: StepStatus,
    attempt: z.number().int().openapi({ description: 'From 1: the nth time it ran in this run.' }),
    agent: z
      .string()
      .nullable()
      .openapi({ description: 'The agent file it names (`agents/<name>.md`), if any.' }),
    model: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    costUsd: z.number().nullable(),
    error: z.string().nullable(),
    skipped: z.string().nullable().openapi({ description: 'Why it was skipped.' }),
    outputs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .nullable()
      .openapi({ description: "The latest execution's outputs, checked against their types." }),
    artifacts: z
      .array(z.strictObject({ name: z.string(), bytes: z.number().int() }))
      .openapi({ description: 'The documents it wrote; empty when none.' }),
    turn: z
      .strictObject({
        turns: z.number().int().nullable().openapi({ description: 'The turns it took.' }),
        maxTurns: z.number().int().nullable().openapi({ description: 'Its own cap, if any.' }),
        deniedTools: z
          .array(z.string())
          .openapi({ description: 'Tools a turn was refused, each once, in first-seen order.' }),
      })
      .nullable()
      .openapi({ description: "An agent step's turns, summed over its latest attempt." }),
    command: z
      .strictObject({
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        stdoutBytes: z.number().int().nullable(),
        stderrBytes: z.number().int().nullable(),
        truncated: z.boolean().openapi({ description: 'Whether its output was cut.' }),
      })
      .nullable()
      .openapi({
        description: "A command step's result; null for an agent step, or before it ran.",
      }),
    previous: z
      .array(
        z.strictObject({
          attempt: z.number().int(),
          status: StepStatus,
          error: z.string().nullable(),
          finishedAt: z.string().nullable(),
          costUsd: z.number().nullable(),
          turns: z.number().int().nullable(),
        }),
      )
      .openapi({ description: 'Its earlier attempts in this run, oldest first; empty when none.' }),
    reminded: z
      .boolean()
      .openapi({ description: 'Whether Consola reminded the agent to finish its step.' }),
    output: z
      .strictObject({
        stdout: z.string(),
        stderr: z.string(),
        truncated: z.boolean().openapi({ description: 'Whether more came before what is kept.' }),
      })
      .nullable()
      .openapi({
        description: `The end of what its latest attempt printed, as its runner last sent it: at most ${OUTPUT_TAIL_MAX / 1024} KiB of each. Untrusted: show it as plain text.`,
      }),
    definition: z.union([StepDefinition, z.null()]),
  })
  .openapi('StepSummary');

const Spend = z.strictObject({ usd: z.number(), runs: z.number().int() });

export const RunSource = z
  .strictObject({
    path: z.string().openapi({
      description:
        'The file the automation is written in: `automations/<name>.yaml`, or `factory.yml`.',
    }),
    version: z.number().int().openapi({ description: 'The factory version the run executed.' }),
    latestVersion: z.number().int().openapi({ description: "The factory's latest version now." }),
    text: z.string().openapi({ description: 'The whole file, at that version.' }),
    // The automation's own lines in it: the whole file for `automations/<name>.yaml`.
    range: LineRange,
    trigger: z.strictObject({
      kind: RunTrigger,
      detail: z.string().nullable().openapi({
        description: "The cron schedule, the event(s), or the poll's check, as written.",
      }),
    }),
    mode: z.enum(AUTOMATION_MODES),
    appliesTo: z
      .array(z.enum(ITEM_KINDS))
      .openapi({ description: 'Which items a run on demand takes; empty when none.' }),
  })
  .openapi('RunSource', {
    description:
      "The file behind an automation run, at the factory version it executed, and the automation's own lines in it (`range`: the whole file for `automations/<name>.yaml`). Null for a request (its orchestrator has no file in the cell yet), and when that version does not define the automation.",
  });

export const RunApproval = z
  .strictObject({
    version: z
      .number()
      .int()
      .openapi({ description: "The version an answer applies to: the run's factory version." }),
    reason: z.string().openapi({ description: 'Why it asks, in one plain sentence.' }),
    team: z
      .strictObject({ id: z.string(), name: z.string() })
      .openapi({ description: "Who may answer: anyone on the factory's owning team." }),
    mayAnswer: z.boolean().openapi({ description: 'Whether the caller is on that team.' }),
    will: z
      .strictObject({
        commands: z.array(z.strictObject({ step: z.string(), command: z.string() })),
        agents: z.array(
          z.strictObject({
            step: z.string(),
            agent: z.string().nullable(),
            prompt: z.string().nullable(),
          }),
        ),
      })
      .openapi({
        description:
          'What approving lets run, as the definition writes it: each command and each agent step. Empty for a request.',
      }),
    answer: z
      .strictObject({
        decision: z.enum(APPROVAL_DECISIONS),
        by: z.string().openapi({ description: 'The global id of the person who answered.' }),
        at: z.string().openapi({ description: 'When, as an ISO 8601 time.' }),
      })
      .nullable()
      .openapi({ description: 'The answer for this version: the first one given.' }),
  })
  .openapi('RunApproval', {
    description:
      "A run's request to be approved: present while the run needs approval, and once answered. The cell records the answer; the run's runner acts on it.",
  });

export const RunDetail = z
  .strictObject({
    run: RunSummary,
    parent: z
      .strictObject({ id: z.string(), title: z.string() })
      .nullable()
      .openapi({ description: 'The request that started it, which whoever sees the run sees.' }),
    steps: z.array(StepSummary).openapi({
      description: "An automation run's steps, in file order; a request's one `orchestrator` step.",
    }),
    request: z
      .strictObject({
        text: z.string().openapi({
          description:
            'The request as the person gave it. Untrusted (it may be a pasted ticket): show it as plain text only.',
        }),
        budget: Spend.nullable(),
        spent: Spend.openapi({
          description: 'Its turns and its runs, as the engine sums them; runs it started.',
        }),
        question: z.strictObject({ at: z.string(), until: z.string() }).nullable().openapi({
          description:
            "The orchestrator's open question: when it was asked, and its deadline. Its text is not in the cell.",
        }),
      })
      .nullable()
      .openapi({ description: "A request's own facts; null for an automation run." }),
    children: z.array(RunSummary).openapi({
      description: 'The automation runs a request started, in the order it started them.',
    }),
    conversation: z.strictObject({ sessionId: z.string() }).nullable().openapi({
      description:
        "The cloud session holding the orchestrator's conversation, once there is one. Always null for now.",
    }),
    source: z.union([RunSource, z.null()]),
    approval: z.union([RunApproval, z.null()]),
  })
  .openapi('RunDetail');

export const RunList = z
  .strictObject({
    runs: z.array(RunSummary),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: "The next page's `cursor`; null on the last page." }),
    // Under every filter but `phase`, `cursor` and `limit`.
    counts: PhaseCounts,
    facets: z
      .strictObject({
        factories: z.array(
          z.strictObject({
            id: z.string(),
            name: z.string(),
            teamId: z.string(),
            latestVersion: z.number().int(),
          }),
        ),
        teams: z.array(z.strictObject({ id: z.string(), name: z.string() })),
        automations: z.array(z.strictObject({ factoryId: z.string(), name: z.string() })),
      })
      .openapi({
        description:
          "What the filters offer, whatever the query's filters: the factories and teams the caller sees, by name, and the automations their runs ran, children's included.",
      }),
  })
  .openapi('RunList', {
    description:
      'Top-level runs (none a request started) the caller sees, newest first: every run for owners and admins, the runs of their teams’ factories for a member.',
  });

/** A query parameter that may be given several times; once, it is a string, which is one value. */
const several = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (typeof value === 'string' ? [value] : value), z.array(schema));

export const RUNS_Q_MAX = 200;
export const RUNS_LIMIT_MAX = 100;
export const RUNS_LIMIT_DEFAULT = 50;

const RunsQuery = z.object({
  phase: several(Phase)
    .optional()
    .openapi({ description: 'Only runs in one of these phases. Repeat it for several.' }),
  trigger: several(RunTrigger).optional().openapi({
    description:
      'Only runs started one of these ways; "background runs" are `cron`, `event` and `poll`.',
  }),
  factoryId: z.string().optional().openapi({
    description: "Only this factory's runs; one the caller does not see gives an empty page.",
  }),
  teamId: z
    .string()
    .optional()
    .openapi({ description: 'Only runs of the factories this team owns now.' }),
  automation: z.string().optional().openapi({
    description:
      'Only runs of this automation, and requests that started one, in every factory unless `factoryId` narrows it.',
  }),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: '`true`: only runs the caller started.' }),
  q: z
    .string()
    .max(RUNS_Q_MAX)
    .optional()
    .openapi({ description: "Text the title or the automation's name holds, in any case." }),
  cursor: z.string().optional().openapi({ description: "The page before's `nextCursor`." }),
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT_MAX).default(RUNS_LIMIT_DEFAULT),
});

const RunId = z.string().openapi({ param: { name: 'runId', in: 'path' } });

export const listRuns = createRoute({
  method: 'get',
  path: '/api/runs',
  summary: 'The top-level runs the caller sees, newest first',
  description:
    'A request is one run; the automation runs it started are not listed here but in its own answer. Filters combine; the values of one filter are alternatives.',
  request: { query: RunsQuery },
  responses: {
    200: json(RunList, 'A page of runs, the counts and what the filters offer.'),
    400: json(
      failure('invalid_request'),
      'A phase or trigger the cell does not know, a cursor it did not give, a `limit` out of range or a `q` too long.',
    ),
    409: workspacePending,
    ...tokenFailures,
  },
});

export const getRun = createRoute({
  method: 'get',
  path: '/api/runs/{runId}',
  summary: 'One run: its steps, and a request’s facts and the runs it started',
  request: { params: z.object({ runId: RunId }) },
  responses: {
    200: json(RunDetail, 'The run.'),
    404: json(
      failure('run_not_found'),
      'The workspace has no run with that id that the caller sees: none, or one of a factory of a team a member is not in.',
    ),
    409: workspacePending,
    ...tokenFailures,
  },
});

export const ApprovalAnswer = z
  .object({ decision: z.enum(['approve', 'dismiss']), version: z.number().int() })
  .openapi('ApprovalAnswer', {
    description:
      "Approve or dismiss a run waiting for approval, at the version the caller was shown: the run's factory version.",
  });

export const postRunApproval = createRoute({
  method: 'post',
  path: '/api/runs/{runId}/approval',
  summary: 'Approve or dismiss a run that waits for approval',
  description:
    "Anyone on the run's factory's owning team may answer, whatever their workspace role, and the first answer for a version is the one kept. The cell records it and does not change the run: its runner acts on it.",
  request: { params: z.object({ runId: RunId }), ...body(ApprovalAnswer) },
  responses: {
    201: json(RunApproval, 'The answer is recorded.'),
    400: json(failure('invalid_request'), 'The body is not what the route takes.'),
    403: json(
      failure('not_allowed'),
      "The caller sees the run, but is not on its factory's owning team.",
    ),
    404: json(
      failure('run_not_found'),
      'The workspace has no run with that id that the caller sees.',
    ),
    409: {
      content: {
        'application/json': {
          schema: z.union([
            failure('not_waiting'),
            failure('already_answered'),
            failure('version_moved'),
            failure('workspace_pending'),
          ]),
        },
      },
      description:
        "The run is not waiting for approval (`not_waiting`), this version was answered already (`already_answered`: the first answer stands), the version is not the run's (`version_moved`), or the cell does not hold the workspace yet (`workspace_pending`).",
    },
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
  patchFactory,
  getFactoryVersion,
  postFactoryVersion,
  listRuns,
  getRun,
  postRunApproval,
];

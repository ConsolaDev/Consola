import { AUTOMATION_MODES } from '@consola/factory-spec';
import { AGENT_RUN_STATES, DISPATCHED_AGENT_STATUSES, HARNESSES } from '@consola/runner-protocol';
import { createRoute, z } from '@hono/zod-openapi';
import { CELL_FAILURE_CODES, CLOUD_SESSION_STATUSES } from '../../domain/cloudSession.js';
import {
  FACTORY_BYTES_MAX,
  FACTORY_FILES_MAX,
  FACTORY_NAME_MAX,
  FACTORY_NAME_PROBLEMS,
} from '../../domain/factory.js';
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
import { callerFailures, changeFailures } from './caller.js';

/**
 * Company's contract: every route it serves, what each takes and every answer it gives. `app.ts`
 * registers these routes, and TypeScript checks each handler's answers against them. The app's
 * `openapi.json` is generated from them and the other parts' (`src/openapi.test.ts`), and the web
 * app's client is generated from that.
 *
 * Every route is behind `requireCaller`, so each spreads its answers (`callerFailures`) into its
 * own, and a route that changes something (POST, PUT, PATCH, DELETE) the front door's 403
 * `bad_origin` with them (`changeFailures`). A status a route answers itself as well is one answer
 * holding both its codes and the check's (`forbidden`, `conflict`), since a status holds one
 * answer.
 *
 * Answers are strict objects: the HTTP suite checks every body it gets against them, so a field
 * the contract does not name fails a test. Request bodies are checked for their shape only, never
 * for the domain's rules: `checkTeamName` names a team name's problems, whatever its schema says.
 */

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const body = <Schema extends z.ZodType>(schema: Schema) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

const unsupportedMediaType = json(
  failure('unsupported_media_type'),
  'The body is not JSON (`Content-Type: application/json`).',
);

/**
 * A change's 403s before it runs: the person is not a member of the workspace, or no longer
 * (`requireCaller`), or the change did not come from the web app (the front door).
 */
const CHANGE_REFUSED = changeFailures[403].content['application/json'].schema.options;
/** `requireCaller`'s 409s: no workspace active, or another than the page shows. */
const SWITCHED = callerFailures[409].content['application/json'].schema.options;

/** A route's own 400, whose `invalid_request` `requireCaller` answers too: one answer, saying both. */
const badRequest = <Schema extends z.ZodType>(schema: Schema, description: string) =>
  json(schema, `${description} Or (\`invalid_request\`): ${callerFailures[400].description}`);

/**
 * A change's own 403, as one answer with those every change can get before it runs
 * (`changeFailures`). Only changes answer a 403 of their own: a read that did would need one
 * without `bad_origin`, which the front door never answers a read.
 */
const forbidden = <Own extends z.ZodType>(own: Own, description: string) =>
  json(z.union([own, ...CHANGE_REFUSED]), `${description} Or: ${changeFailures[403].description}`);

/** A route's own 409s, as one answer with `requireCaller`'s. */
const conflict = <const Own extends readonly z.ZodType[]>(description: string, ...own: Own) =>
  json(z.union([...own, ...SWITCHED]), `${description} Or: ${callerFailures[409].description}`);

const notAllowed = forbidden(
  failure('not_allowed'),
  'The caller’s role does not manage teams (`not_allowed`).',
);
const teamNotFound = json(
  failure('team_not_found'),
  'The workspace has no team with that id, whether or not another workspace does.',
);

const TeamId = z.string().openapi({ param: { name: 'teamId', in: 'path' } });
const PersonId = z
  .string()
  .openapi({ param: { name: 'personId', in: 'path' }, description: "The person's id." });

// Teams: a workspace's, each with its members (`domain/team.ts`).

export const Team = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    first: z.boolean().openapi({
      description:
        "Whether it is the workspace's first team, which every new member joins and which is never deleted.",
    }),
    memberIds: z.array(z.string()).openapi({
      description:
        'Its members’ ids, in the order they joined it: only people who are members of the workspace now.',
    }),
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

const refusedName = badRequest(
  z.union([InvalidTeam, failure('invalid_request')]),
  'The rules refuse the name, or the body is not what the route takes.',
);

export const listTeams = createRoute({
  method: 'get',
  path: '/api/teams',
  summary: "The caller's workspace's teams, as the caller sees them",
  responses: {
    ...callerFailures,
    200: json(TeamList, 'The teams.'),
  },
});

export const postTeam = createRoute({
  method: 'post',
  path: '/api/teams',
  summary: 'Make a team, with nobody in it',
  request: body(TeamName),
  responses: {
    ...changeFailures,
    201: json(Team, 'The team made.'),
    400: refusedName,
    403: notAllowed,
    409: conflict(
      'Another team of the workspace has the name, in any case (`name_taken`).',
      failure('name_taken'),
    ),
    415: unsupportedMediaType,
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
    ...changeFailures,
    200: json(Team, 'The team, renamed.'),
    400: refusedName,
    404: teamNotFound,
    403: notAllowed,
    409: conflict(
      'Another team of the workspace has the name, in any case (`name_taken`).',
      failure('name_taken'),
    ),
    415: unsupportedMediaType,
  },
});

export const deleteTeam = createRoute({
  method: 'delete',
  path: '/api/teams/{teamId}',
  summary: 'Delete a team, and every place in it',
  request: { params: teamParams },
  responses: {
    ...changeFailures,
    204: { description: 'The team is gone.' },
    404: teamNotFound,
    403: notAllowed,
    409: conflict(
      "The workspace's first team, which is never deleted (`first_team`), or a team that owns a factory, which is not deleted while it does (`owns_factories`).",
      failure('first_team'),
      failure('owns_factories'),
    ),
  },
});

export const putTeamMember = createRoute({
  method: 'put',
  path: '/api/teams/{teamId}/members/{personId}',
  summary: 'Make a member of the workspace a member of a team',
  description: 'Someone already in the team stays as they are.',
  request: { params: memberParams },
  responses: {
    ...changeFailures,
    200: json(Team, 'The team, with the person in it.'),
    404: teamNotFound,
    403: notAllowed,
    409: conflict(
      'The person is not a member of the workspace (`not_a_workspace_member`).',
      failure('not_a_workspace_member'),
    ),
  },
});

export const deleteTeamMember = createRoute({
  method: 'delete',
  path: '/api/teams/{teamId}/members/{personId}',
  summary: 'Take a person out of a team',
  description: 'Someone not in the team changes nothing.',
  request: { params: memberParams },
  responses: {
    ...changeFailures,
    200: json(Team, 'The team, without the person.'),
    403: notAllowed,
    404: teamNotFound,
  },
});

// Factories: a team's, its files stored here and versioned (`domain/factory.ts`).

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
      "Where the factory's files come from: `stored`, saved in Consola. A GitHub repository comes later.",
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
    savedBy: z.string().openapi({ description: 'The id of the person who saved it.' }),
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
    ...callerFailures,
    200: json(FactoryList, 'The factories.'),
  },
});

export const postFactory = createRoute({
  method: 'post',
  path: '/api/factories',
  summary: 'Make a blank factory, owned by a team',
  description:
    'Its files are stored in Consola, and its first version holds none. Owners and admins may make one for any team, a member for a team they are in.',
  request: body(NewFactory),
  responses: {
    ...changeFailures,
    201: json(Factory, 'The factory made.'),
    400: badRequest(
      z.union([InvalidFactory, failure('invalid_request')]),
      'The rules refuse the name, or the body is not what the route takes.',
    ),
    404: json(
      failure('team_not_found'),
      'The workspace has no team with that id that the caller sees: none, or one a member is not in.',
    ),
    409: conflict(
      'Another factory of the workspace has the name, in any case (`name_taken`).',
      failure('name_taken'),
    ),
    415: unsupportedMediaType,
  },
});

const factoryParams = z.object({ factoryId: FactoryId });

export const getFactory = createRoute({
  method: 'get',
  path: '/api/factories/{factoryId}',
  summary: 'A factory, with its latest version’s files',
  request: { params: factoryParams },
  responses: {
    ...callerFailures,
    200: json(FactoryWithFiles, 'The factory and its latest version.'),
    404: factoryNotFound,
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
    ...changeFailures,
    200: json(Factory, 'The factory, changed.'),
    400: badRequest(
      z.union([InvalidFactory, failure('invalid_request')]),
      'The rules refuse the name, or the body is not what the route takes: neither a name nor a team is one.',
    ),
    404: {
      content: {
        'application/json': {
          schema: z.union([failure('factory_not_found'), failure('team_not_found')]),
        },
      },
      description:
        'The caller sees no such factory (`factory_not_found`), or no such team to move it to (`team_not_found`): none, or one a member is not in.',
    },
    409: conflict(
      'Another factory of the workspace has the name, in any case (`name_taken`).',
      failure('name_taken'),
    ),
    415: unsupportedMediaType,
  },
});

export const getFactoryVersion = createRoute({
  method: 'get',
  path: '/api/factories/{factoryId}/versions/{version}',
  summary: "One version of a factory's files, an earlier one or the latest",
  request: { params: z.object({ factoryId: FactoryId, version: VersionNumber }) },
  responses: {
    ...callerFailures,
    200: json(FactoryVersion, 'The version.'),
    400: badRequest(failure('invalid_request'), 'The version is not a number from 1.'),
    404: {
      content: {
        'application/json': {
          schema: z.union([failure('factory_not_found'), failure('version_not_found')]),
        },
      },
      description:
        'The caller sees no such factory (`factory_not_found`), or it has no version with that number (`version_not_found`).',
    },
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
    ...changeFailures,
    201: json(SavedFactoryVersion, 'The version saved.'),
    400: badRequest(
      z.union([InvalidFiles, failure('invalid_request')]),
      'The files fail the factory schema (`invalid_files`), or the body is not what the route takes.',
    ),
    404: factoryNotFound,
    409: conflict(
      'The factory has a newer version than the one the files were edited from (`version_moved`).',
      z
        .strictObject({ error: z.literal('version_moved'), latestVersion: z.number().int() })
        .openapi('VersionMoved', {
          description:
            'The latest version is no longer `baseVersion`: someone saved since. Nothing is saved.',
        }),
    ),
    413: json(failure('too_large'), 'The body is larger than any factory’s files can be.'),
    415: unsupportedMediaType,
  },
});

export const FactoryTemplate = z
  .strictObject({
    id: z.string().openapi({ description: 'The template’s id, such as `code-review-team`.' }),
    name: z.string(),
    description: z.string(),
    files: z.array(FactoryFile).openapi({
      description:
        "Its files, by path inside a factory's folder, to merge into a factory through the ordinary save.",
    }),
  })
  .openapi('FactoryTemplate', {
    description: 'Ready-made factory files a person can start from, such as an agent team.',
  });

export const listFactoryTemplates = createRoute({
  method: 'get',
  path: '/api/factory-templates',
  summary: 'The ready-made factory files a person can start from',
  description:
    'The same for every workspace. A template’s files reach a factory only through `POST /api/factories/{factoryId}/versions`, which checks them as any other files.',
  responses: {
    ...callerFailures,
    200: json(z.array(FactoryTemplate), 'The templates.'),
  },
});

// Runs: what each factory's runners ran, a request and the automation runs it started among them
// (`domain/run.ts`). Read only: a runner records runs through the store, never over HTTP.

const iso = (what: string) => z.string().openapi({ description: `${what}, as an ISO 8601 time.` });

export const Phase = z.enum(PHASES).openapi('Phase', {
  description:
    "Consola's grouping of a run's status, which the list filters and counts by: `active` (queued, running, waiting on a run), `needs-you` (needs approval, waiting on a person, or a request at work one of whose runs needs someone), `completed`, `failed` (failed, expired) and `stopped` (cancelled, rejected).",
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
        'The id of the person who started it, who may no longer be a member; null for a run no person started.',
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
      "The file behind an automation run, at the factory version it executed, and the automation's own lines in it (`range`: the whole file for `automations/<name>.yaml`). Null for a request (its orchestrator has no file in Consola yet), and when that version does not define the automation.",
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
        by: z.string().openapi({ description: 'The id of the person who answered.' }),
        at: z.string().openapi({ description: 'When, as an ISO 8601 time.' }),
      })
      .nullable()
      .openapi({ description: 'The answer for this version: the first one given.' }),
  })
  .openapi('RunApproval', {
    description:
      "A run's request to be approved: present while the run needs approval, and once answered. Consola records the answer; the run's runner acts on it.",
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
            "The orchestrator's open question: when it was asked, and its deadline. Its text is not in Consola.",
        }),
      })
      .nullable()
      .openapi({ description: "A request's own facts; null for an automation run." }),
    children: z.array(RunSummary).openapi({
      description: 'The automation runs a request started, in the order it started them.',
    }),
    conversation: z.strictObject({ sessionId: z.string() }).nullable().openapi({
      description:
        "The cloud session holding a request's conversation with its orchestrator, once there is one: an agent run's. Null for an automation run.",
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
    ...callerFailures,
    200: json(RunList, 'A page of runs, the counts and what the filters offer.'),
    400: badRequest(
      failure('invalid_request'),
      'A phase or trigger Consola does not know, a cursor it did not give, a `limit` out of range or a `q` too long.',
    ),
  },
});

export const getRun = createRoute({
  method: 'get',
  path: '/api/runs/{runId}',
  summary: 'One run: its steps, and a request’s facts and the runs it started',
  request: { params: z.object({ runId: RunId }) },
  responses: {
    ...callerFailures,
    200: json(RunDetail, 'The run.'),
    404: json(
      failure('run_not_found'),
      'The workspace has no run with that id that the caller sees: none, or one of a factory of a team a member is not in.',
    ),
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
    "Anyone on the run's factory's owning team may answer, whatever their workspace role, and the first answer for a version is the one kept. Consola records it and does not change the run: its runner acts on it.",
  request: { params: z.object({ runId: RunId }), ...body(ApprovalAnswer) },
  responses: {
    ...changeFailures,
    201: json(RunApproval, 'The answer is recorded.'),
    400: badRequest(failure('invalid_request'), 'The body is not what the route takes.'),
    403: forbidden(
      failure('not_allowed'),
      "The caller sees the run, but is not on its factory's owning team (`not_allowed`).",
    ),
    404: json(
      failure('run_not_found'),
      'The workspace has no run with that id that the caller sees.',
    ),
    409: conflict(
      "The run is not waiting for approval (`not_waiting`), this version was answered already (`already_answered`: the first answer stands), or the version is not the run's (`version_moved`).",
      failure('not_waiting'),
      failure('already_answered'),
      failure('version_moved'),
    ),
    415: unsupportedMediaType,
  },
});

// Cloud sessions: a person's sandboxes, and the agent runs automations start, run by the
// workspace's runner (`domain/cloudSession.ts`).

const sessionNotFound = json(
  failure('not_found'),
  "The caller sees no such session: none, another person's or another workspace's, as if it did not exist.",
);

/** A route's 503: no runner to reach. */
const noRunner = (description: string) => json(failure('no_runner'), description);

const SessionId = z.string().openapi({ param: { name: 'sessionId', in: 'path' } });
const sessionParams = z.object({ sessionId: SessionId });

const Harness = z.enum(HARNESSES).openapi({ description: 'The agent CLI the session runs.' });

export const CloudSessionOrigin = z
  .strictObject({
    kind: z.literal('automation'),
    factoryId: z.string(),
    factoryName: z.string(),
    automation: z.string().openapi({ description: 'The automation that fired, by name.' }),
    agent: z.string().openapi({
      description:
        "The agent that takes the first turn: the automation's, by default the orchestrator.",
    }),
    item: z
      .strictObject({
        kind: z.literal('pull_request'),
        repository: z.string().openapi({ description: 'As `owner/name`.' }),
        number: z.number().int(),
        url: z.string(),
        title: z.string(),
        headSha: z.string().openapi({ description: 'The commit the run checks out.' }),
      })
      .openapi({ description: 'The GitHub pull request the event was about.' }),
  })
  .openapi('CloudSessionOrigin', {
    description: "What started an agent run: an automation of a factory's agent team, on an item.",
  });

export const AgentRunReport = z
  .strictObject({
    state: z.enum(AGENT_RUN_STATES),
    summary: z
      .string()
      .optional()
      .openapi({ description: "The first agent's last message, as the runner reported it." }),
    agents: z
      .array(
        z.strictObject({
          id: z.string().openapi({ description: "The dispatched agent's conversation." }),
          agent: z.string().openapi({ description: 'Its name in the factory.' }),
          status: z.enum(DISPATCHED_AGENT_STATUSES),
          summary: z.string().optional(),
        }),
      )
      .optional()
      .openapi({ description: 'The agents the first agent dispatched.' }),
  })
  .openapi('AgentRunReport', {
    description: "The runner's last report of an agent run, as it sent it.",
  });

export const CloudSession = z
  .strictObject({
    id: z.string(),
    workspaceId: z.string(),
    personId: z.string().nullable().openapi({
      description:
        'The id of the person who started it, the only one who sees it; null for an agent run, which every member of the workspace sees.',
    }),
    repository: z.string().openapi({ description: 'The repository, as `owner/name`.' }),
    harness: Harness,
    status: z.enum(CLOUD_SESSION_STATUSES).openapi({
      description:
        '`starting` goes to `running` or `failed`, and `running` to `stopped` or `failed`; `stopped` and `failed` are ends.',
    }),
    title: z.string().nullable().openapi({
      description:
        "What the runner named it; for an agent run, Consola's own title (`<automation> · <owner/name>#<number> <title>`), which the runner never replaces.",
    }),
    hostUrl: z.string().nullable().openapi({
      description: "The origin the session's host listens on, once the runner reported it.",
    }),
    error: z.string().nullable().openapi({
      description:
        'The message the runner reported for a failure (its provider’s or its start script’s), shown as it came. A failed session has this or `errorCode`, never both.',
    }),
    errorCode: z.enum(CELL_FAILURE_CODES).nullable().openapi({
      description:
        'A failure Consola decided itself, which the web app words: the runner restarted, could not be reached, or failed without a message; for an agent run, also no runner connected (`runner_unavailable`), its repository or harness not offered, or a start Consola could not compose (`agent_run_invalid`).',
    }),
    runnerId: z.string().nullable().openapi({
      description:
        'The runner the start was handed to; null for an agent run no runner took, which ended as it was recorded.',
    }),
    createdAt: z.number().int().openapi({ description: 'When it was started, in epoch seconds.' }),
    endedAt: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'When it ended, in epoch seconds; null while it lives.' }),
    origin: z.union([CloudSessionOrigin, z.null()]).openapi({
      description: "What started an agent run; null for a person's session.",
    }),
    agentRun: z.union([AgentRunReport, z.null()]).openapi({
      description: "The runner's last report of an agent run; null until it sent one.",
    }),
  })
  .openapi('CloudSession', {
    description:
      "A cloud session: a sandbox the workspace's runner runs for a person, or an agent run an automation started, which nobody types into.",
  });

export const CloudSessionOptions = z
  .strictObject({
    repositories: z.array(z.string()).openapi({ description: 'Each as `owner/name`.' }),
    harnesses: z.array(Harness),
  })
  .openapi('CloudSessionOptions', {
    description:
      "What the workspace's connected runner offers: where a session can start, and with what.",
  });

export const NewCloudSession = z
  .strictObject({
    repository: z.string().openapi({
      description: 'One the runner offers, as `owner/name`; its name may not start with a dot.',
    }),
    harness: Harness,
  })
  .openapi('NewCloudSession', {
    description:
      'Exactly these two fields: a body naming anything else, a workspace above all, is refused.',
  });

export const CloudSessionPass = z
  .strictObject({
    pass: z.string().openapi({
      description:
        "The session pass, a compact JWS signed with Consola's own pass key, which the session's host checks.",
    }),
    hostUrl: z.string().openapi({ description: "The origin the session's host listens on." }),
    expiresAt: z
      .number()
      .int()
      .openapi({ description: 'When the pass expires, in epoch seconds: its `exp`.' }),
  })
  .openapi('CloudSessionPass');

/** A pass is a credential: no answer of its route is kept by a cache. */
const noStore = {
  'Cache-Control': {
    schema: { type: 'string' as const, enum: ['no-store'] },
    description: 'Never kept by a cache.',
  },
};

export const getCloudSessionOptions = createRoute({
  method: 'get',
  path: '/api/cloud-sessions/options',
  summary: "What the workspace's runner offers a new session",
  responses: {
    ...callerFailures,
    200: json(CloudSessionOptions, 'What the connected runner offers.'),
    503: noRunner('No runner is configured or connected for the workspace (`no_runner`).'),
  },
});

export const postCloudSession = createRoute({
  method: 'post',
  path: '/api/cloud-sessions',
  summary: 'Start a cloud session on the workspace’s runner',
  description:
    'Nothing is recorded or sent unless the connected runner offers both the repository and the harness. The session starts as `starting`; the runner moves it on.',
  request: body(NewCloudSession),
  responses: {
    ...changeFailures,
    201: json(CloudSession, 'The session, recorded and handed to the runner.'),
    400: badRequest(
      z.union([
        failure('repository_not_offered'),
        failure('harness_not_offered'),
        failure('invalid_request'),
      ]),
      'The runner does not offer the repository (`repository_not_offered`) or the harness (`harness_not_offered`), or the body is not exactly `{ repository, harness }`, each valid (`invalid_request`).',
    ),
    415: unsupportedMediaType,
    503: noRunner(
      'No runner is configured or connected for the workspace (`no_runner`): nothing was recorded.',
    ),
  },
});

export const listCloudSessions = createRoute({
  method: 'get',
  path: '/api/cloud-sessions',
  summary: "The caller's own cloud sessions, newest first (an agent run is listed with the runs)",
  description:
    "A person's session is theirs alone; an agent run, which an automation started, is seen by every member of the workspace.",
  responses: {
    ...callerFailures,
    200: json(z.array(CloudSession), 'The sessions.'),
  },
});

export const getCloudSession = createRoute({
  method: 'get',
  path: '/api/cloud-sessions/{sessionId}',
  summary: 'One of the caller’s own cloud sessions, or one of the workspace’s agent runs',
  request: { params: sessionParams },
  responses: {
    ...callerFailures,
    200: json(CloudSession, 'The session.'),
    404: sessionNotFound,
  },
});

export const postCloudSessionStop = createRoute({
  method: 'post',
  path: '/api/cloud-sessions/{sessionId}/stop',
  summary: 'Stop one of the caller’s own cloud sessions, or one of the workspace’s agent runs',
  description:
    'The session ends at once, whether or not its runner is connected; the runner is told when it is. Stopping an ended session changes nothing.',
  request: { params: sessionParams },
  responses: {
    ...changeFailures,
    202: json(CloudSession, 'The session, ended: `stopped`, or the end it had already.'),
    404: sessionNotFound,
  },
});

export const postCloudSessionPass = createRoute({
  method: 'post',
  path: '/api/cloud-sessions/{sessionId}/pass',
  summary:
    'A pass to a running session the caller sees: their own, or an agent run of the workspace',
  description:
    "The pass lasts five minutes (the runner protocol's cap); ask for another when it runs out. No answer of the route is kept by a cache (`Cache-Control: no-store`) but the refusals before it runs: `requireCaller`'s and the origin check's.",
  request: { params: sessionParams },
  responses: {
    ...changeFailures,
    200: { ...json(CloudSessionPass, 'The pass, and the host it opens.'), headers: noStore },
    404: {
      ...json(
        failure('not_found'),
        "The caller sees no such running session whose host has an address: none, one still starting or ended, another person's or another workspace's.",
      ),
      headers: noStore,
    },
    503: noRunner('Consola has no pass key here, and so no runner (`no_runner`).'),
  },
});

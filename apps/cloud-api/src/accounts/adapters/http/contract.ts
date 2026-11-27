import { createRoute, z } from '@hono/zod-openapi';
import { WORKSPACE_ROLES } from '../../../shared/workspaceRole.js';
import { REGIONS } from '../../domain/region.js';
import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_PROBLEMS,
  WORKSPACE_SLUG_MAX,
} from '../../domain/workspace.js';
import { WORKSPACE_ICONS } from '../../domain/workspaceIcon.js';

/**
 * Accounts' part of the API's contract: every route accounts serves (Better Auth's `/api/auth/*`
 * aside), what it takes and every answer it gives. `app.ts` implements these routes, and
 * TypeScript checks each handler's answers against them. The app's `openapi.json` is generated
 * from every part's routes, and the web app's client is generated from that.
 *
 * Answers are strict objects: the HTTP suite checks every body it gets against them, so a field
 * the contract does not name fails a test. Request bodies are checked for their shape only, never
 * for the domain's rules, so a schema here is never stricter than the rule behind it:
 * `checkNewWorkspace` names a new workspace's problems, whatever its schema says.
 */

export const Person = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .openapi('Person');

export const MyWorkspace = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    region: z.enum(REGIONS),
    role: z.enum(WORKSPACE_ROLES),
    icon: z.union([z.enum(WORKSPACE_ICONS), z.null()]).openapi({
      description:
        'The icon the workspace wears, by the desktop app’s ids; null for none, which shows ' +
        'its initial.',
    }),
    canManage: z.boolean().openapi({
      description: 'Whether the person may change how the workspace looks (an owner or admin).',
    }),
  })
  .openapi('MyWorkspace', { description: 'A workspace as one of its members sees it.' });

export const Me = z
  .strictObject({ user: Person, workspace: z.union([MyWorkspace, z.null()]) })
  .openapi('Me', { description: 'Who is signed in, and their session’s active workspace.' });

export const NewWorkspace = z
  .object({ name: z.string(), slug: z.string() })
  .openapi('NewWorkspace', {
    description:
      `A name (trimmed, at most ${WORKSPACE_NAME_MAX} characters) and a slug of lowercase letters ` +
      `and digits with single dashes between (at most ${WORKSPACE_SLUG_MAX}). The workspace is ` +
      'made in the deployment’s region, which no request names.',
  });

export const ActiveWorkspace = z.object({ workspaceId: z.string() }).openapi('ActiveWorkspace');

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

export const InvalidWorkspace = z
  .strictObject({
    error: z.literal('invalid_workspace'),
    problems: z.array(z.enum(WORKSPACE_PROBLEMS)),
  })
  .openapi('InvalidWorkspace', { description: 'Every problem, in the order the rules name them.' });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const signedOut = json(failure('signed_out'), 'Nobody is signed in.');
const badOrigin = json(failure('bad_origin'), 'The change did not come from the web app.');
const invalidRequest = json(failure('invalid_request'), 'The body is not what the route takes.');
const unsupportedMediaType = json(
  failure('unsupported_media_type'),
  'The body is not JSON (`Content-Type: application/json`).',
);

const body = <Schema extends z.ZodType>(schema: Schema) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

export const getMe = createRoute({
  method: 'get',
  path: '/api/me',
  summary: 'Who is signed in',
  responses: { 200: json(Me, 'The person and their active workspace.'), 401: signedOut },
});

export const putActiveWorkspace = createRoute({
  method: 'put',
  path: '/api/me/workspace',
  summary: 'Make one of my workspaces active',
  request: body(ActiveWorkspace),
  responses: {
    200: json(MyWorkspace, 'The workspace now active.'),
    400: invalidRequest,
    401: signedOut,
    403: badOrigin,
    404: json(
      failure('workspace_not_found'),
      'No workspace of the person’s has that id, whether or not one exists.',
    ),
    415: unsupportedMediaType,
  },
});

export const WorkspaceIconChange = z
  .object({ icon: z.union([z.string(), z.null()]) })
  .openapi('WorkspaceIconChange', {
    description: 'An icon from the desktop app’s set, or null to take the icon off.',
  });

export const putActiveWorkspaceIcon = createRoute({
  method: 'put',
  path: '/api/me/workspace/icon',
  summary: "Set or clear my active workspace's icon",
  description:
    'Only an owner or an admin of the workspace may. It changes the icon alone, never the ' +
    'workspace’s name, slug or region.',
  request: body(WorkspaceIconChange),
  responses: {
    200: json(MyWorkspace, 'The workspace, wearing the icon it was given.'),
    400: {
      content: {
        'application/json': {
          schema: z.union([failure('icon_unknown'), failure('invalid_request')]),
        },
      },
      description: 'The icon is not one of the set, or the body is not what the route takes.',
    },
    401: signedOut,
    403: {
      content: {
        'application/json': {
          schema: z.union([failure('not_a_member'), failure('not_allowed'), failure('bad_origin')]),
        },
      },
      description:
        'The person is not in the workspace, is a member who may not change it, or the change ' +
        'did not come from the web app.',
    },
    409: json(failure('no_active_workspace'), 'The session has no active workspace.'),
    415: unsupportedMediaType,
  },
});

export const WorkspaceMember = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.union([z.string(), z.null()]),
    role: z.enum(WORKSPACE_ROLES),
  })
  .openapi('WorkspaceMember', {
    description: 'A member of a workspace, as its other members see them.',
  });

export const getActiveWorkspaceMembers = createRoute({
  method: 'get',
  path: '/api/me/workspace/members',
  summary: "My active workspace's members, in the order they joined",
  description:
    'Every member of the workspace may list them. A person is named by the id the rest of ' +
    'the API knows them by (`id`), so the web app can put a name to the ids other answers hold.',
  responses: {
    200: json(
      z.strictObject({ members: z.array(WorkspaceMember) }),
      'The members, with their roles.',
    ),
    401: signedOut,
    403: json(
      failure('not_a_member'),
      'The person is not in the workspace their session names, any more or ever.',
    ),
    409: json(failure('no_active_workspace'), 'The session has no active workspace.'),
  },
});

export const listWorkspaces = createRoute({
  method: 'get',
  path: '/api/workspaces',
  summary: 'My workspaces, in the order I joined them',
  responses: {
    200: json(z.strictObject({ workspaces: z.array(MyWorkspace) }), 'The person’s workspaces.'),
    401: signedOut,
  },
});

export const postWorkspace = createRoute({
  method: 'post',
  path: '/api/workspaces',
  summary: 'Make a workspace, owned by me and active in my session',
  request: body(NewWorkspace),
  responses: {
    201: json(MyWorkspace, 'The workspace made, with the person as its owner.'),
    400: {
      content: {
        'application/json': { schema: z.union([InvalidWorkspace, failure('invalid_request')]) },
      },
      description: 'The rules refuse the workspace, or the body is not JSON.',
    },
    401: signedOut,
    403: badOrigin,
    409: json(failure('slug_taken'), 'A workspace has that slug.'),
    415: unsupportedMediaType,
  },
});

/**
 * Every route accounts serves, in the order `registerAccountRoutes` registers them. The app's
 * one health route is the composition's, over every part's probe, so it is not among them.
 */
export const ACCOUNT_ROUTES = [
  getMe,
  putActiveWorkspace,
  putActiveWorkspaceIcon,
  getActiveWorkspaceMembers,
  listWorkspaces,
  postWorkspace,
];

import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { createRoute, z } from '@hono/zod-openapi';
import { REGIONS } from '../../domain/region.js';
import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_PROBLEMS,
  WORKSPACE_SLUG_MAX,
} from '../../domain/workspace.js';

/**
 * The API's contract: every route Consola serves (Better Auth's `/api/auth/*` aside), what it
 * takes and every answer it gives. `app.ts` implements these routes, and TypeScript checks each
 * handler's answers against them. `openapi.json` is generated from them (`openapi.test.ts`), and
 * the web app's client is generated from that.
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
  })
  .openapi('MyWorkspace', { description: 'A workspace as one of its members sees it.' });

export const Me = z
  .strictObject({ user: Person, workspace: z.union([MyWorkspace, z.null()]) })
  .openapi('Me', { description: 'Who is signed in, and their session’s active workspace.' });

export const NewWorkspace = z
  .object({ name: z.string(), slug: z.string(), region: z.enum(REGIONS) })
  .openapi('NewWorkspace', {
    description:
      `A name (trimmed, at most ${WORKSPACE_NAME_MAX} characters), a slug of lowercase letters ` +
      `and digits with single dashes between (at most ${WORKSPACE_SLUG_MAX}) and a region.`,
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
    'Every member of the workspace may list them. A person is named by the global id a cell ' +
    'knows them by (`id`), so the web app can put a name to the ids a cell answers with.',
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
    409: json(failure('slug_taken'), 'A workspace in some region has that slug.'),
    415: unsupportedMediaType,
  },
});

export const CellToken = z
  .strictObject({
    token: z.string(),
    expiresAt: z.number().int().openapi({ description: 'In whole seconds since the epoch.' }),
    workspaceId: z.string().openapi({
      description:
        'The workspace the token is for: the one active when it was minted, which another tab ' +
        'may have switched since the page loaded.',
    }),
    region: z
      .enum(REGIONS)
      .openapi({ description: "The workspace's region, whose cell takes the token." }),
  })
  .openapi('CellToken', {
    description: "The token the session's active workspace's cell trusts, for minutes.",
  });

/** A public key, and never a private part: the key set's schema is strict, so `d` fails it. */
export const CellTokenPublicKey = z
  .strictObject({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string(),
    kid: z.string(),
    alg: z.literal(CELL_TOKEN_ALGORITHM),
    use: z.literal('sig'),
  })
  .openapi('CellTokenPublicKey');

export const postCellToken = createRoute({
  method: 'post',
  path: '/api/cell-token',
  summary: "Mint a token for my session's active workspace",
  description:
    'Nothing in the request names the workspace or the role: both are read from the database ' +
    'as the token is minted. No cache keeps the answer (`Cache-Control: no-store`).',
  responses: {
    200: json(CellToken, 'The token, and when it stops being valid.'),
    401: signedOut,
    403: {
      content: {
        'application/json': {
          schema: z.union([failure('not_a_member'), failure('bad_origin')]),
        },
      },
      description:
        'The person is not in the workspace their session names, or the request did not come ' +
        'from the web app.',
    },
    409: json(failure('no_active_workspace'), 'The session has no active workspace.'),
  },
});

export const getCellTokenKeys = createRoute({
  method: 'get',
  path: CELL_TOKEN_KEYS_PATH,
  summary: 'The public keys a cell checks cell tokens with',
  description: 'A JSON Web Key Set (RFC 7517). Reading it needs no sign-in.',
  responses: {
    200: json(
      z.strictObject({ keys: z.array(CellTokenPublicKey) }).openapi('CellTokenKeySet'),
      'The key set.',
    ),
  },
});

export const getHealth = createRoute({
  method: 'get',
  path: '/api/health',
  summary: 'Whether the service can reach its database',
  responses: {
    200: json(z.strictObject({ ok: z.literal(true) }), 'It can.'),
    503: json(z.strictObject({ ok: z.literal(false) }), 'It cannot.'),
  },
});

/** Every route in the contract, in the order `app.ts` registers them. */
export const ROUTES = [
  getMe,
  putActiveWorkspace,
  getActiveWorkspaceMembers,
  listWorkspaces,
  postWorkspace,
  postCellToken,
  getCellTokenKeys,
  getHealth,
];

import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  GITHUB_TOKEN_REQUEST_TYPE,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { createRoute, z } from '@hono/zod-openapi';
import { TOKEN_REQUEST_PROBLEMS } from '../../domain/gitHubTokens.js';
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

export const GitHubAccount = z
  .strictObject({
    id: z.number().int(),
    login: z.string(),
    type: z.enum(['Organization', 'User']),
  })
  .openapi('GitHubAccount', {
    description: 'The GitHub account, an organisation or a person, the app is installed on.',
  });

export const GitHubRepository = z
  .strictObject({
    id: z.number().int(),
    fullName: z.string(),
    private: z.boolean(),
    url: z.string(),
  })
  .openapi('GitHubRepository');

export const GitHubRepositories = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('listed'), repositories: z.array(GitHubRepository) }),
    z.strictObject({ kind: z.literal('gone') }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ])
  .openapi('GitHubRepositories', {
    description:
      'What GitHub says the installation covers now: its repositories, `gone` when GitHub no ' +
      'longer has the installation (uninstalled or suspended there), or `unavailable` when ' +
      'GitHub did not say. Asked of GitHub each time, never stored.',
  });

export const GitHubConnection = z
  .strictObject({
    id: z.number().int(),
    account: GitHubAccount,
    connectedAt: z.string().openapi({ format: 'date-time' }),
    settingsUrl: z.string().openapi({
      description: 'Where on GitHub its repositories are chosen, and it is uninstalled.',
    }),
    repositories: GitHubRepositories,
  })
  .openapi('GitHubConnection', { description: 'A GitHub App installation the workspace holds.' });

export const Connections = z
  .strictObject({
    canManage: z.boolean().openapi({
      description: 'Whether the person may connect and disconnect: an owner or admin.',
    }),
    github: z.strictObject({
      configured: z
        .boolean()
        .openapi({ description: 'Whether this server has the GitHub App’s settings.' }),
      installations: z.array(GitHubConnection),
    }),
  })
  .openapi('Connections', { description: 'What the workspace is connected to.' });

const noActiveWorkspace = json(
  failure('no_active_workspace'),
  'The session has no active workspace.',
);

export const getConnections = createRoute({
  method: 'get',
  path: '/api/connections',
  summary: "What my session's active workspace is connected to",
  description: 'Any member may read it; `canManage` says whether they may change it.',
  responses: {
    200: json(Connections, 'The workspace’s connections.'),
    401: signedOut,
    403: json(failure('not_a_member'), 'The person is not in the workspace their session names.'),
    409: noActiveWorkspace,
  },
});

export const postGitHubInstall = createRoute({
  method: 'post',
  path: '/api/connections/github/install',
  summary: 'Start connecting GitHub to my active workspace',
  description:
    'The address on GitHub that installs the app, carrying a state signed for this session. ' +
    'Only an owner or admin may. No cache keeps the answer (`Cache-Control: no-store`).',
  responses: {
    200: json(
      z.strictObject({ url: z.string() }).openapi('GitHubInstallAddress'),
      'Where to send the person.',
    ),
    401: signedOut,
    403: {
      content: {
        'application/json': {
          schema: z.union([failure('not_a_member'), failure('not_allowed'), failure('bad_origin')]),
        },
      },
      description:
        'The person is not in the workspace, is not an owner or admin of it, or the request ' +
        'did not come from the web app.',
    },
    409: noActiveWorkspace,
    503: json(failure('github_not_configured'), 'This server has no GitHub App settings.'),
  },
});

/** How a Connect ended, as the callback names it in the web app's `?github=`. */
export const GITHUB_CALLBACK_RESULTS = [
  'connected',
  'already_connected',
  'requested',
  'cancelled',
  'bad_state',
  'expired',
  'not_allowed',
  'code_refused',
  'not_installer',
  'not_account_admin',
  'taken',
  'invalid',
  'unavailable',
  'not_configured',
  'signed_out',
] as const;

/**
 * The results, as a named schema of the document (`app.ts` registers it), so a client's own list
 * of them is checked against the contract's, though no route answers one in a body.
 */
export const GitHubCallbackResult = z
  .enum(GITHUB_CALLBACK_RESULTS)
  .openapi('GitHubCallbackResult', {
    description: 'How a Connect ended, as the callback names it in the web app’s `?github=`.',
  });

export const getGitHubCallback = createRoute({
  method: 'get',
  path: '/api/github/callback',
  summary: 'Where GitHub sends a person back after installing the app',
  description:
    'The GitHub App’s callback URL, reached by a browser redirect from GitHub with `state`, ' +
    '`code`, `installation_id`, `setup_action` or `error`. It never answers JSON: it always ' +
    'redirects to the web app’s Settings, on its Connections page, with how the Connect ended ' +
    `in \`?github=\`: one of ${GITHUB_CALLBACK_RESULTS.map((result) => `\`${result}\``).join(', ')}.`,
  responses: {
    302: {
      description: 'To `<PUBLIC_URL>/?github=<result>#/settings/connections`.',
      headers: z.object({ location: z.string() }),
    },
  },
});

export const deleteGitHubInstallation = createRoute({
  method: 'delete',
  path: '/api/connections/github/installations/{installationId}',
  summary: 'Disconnect a GitHub installation from my active workspace',
  description:
    'Removes the workspace’s record. The app stays installed on GitHub until someone ' +
    'uninstalls it there (`settingsUrl`). Only an owner or admin may.',
  request: {
    params: z.object({
      installationId: z.string().openapi({
        param: { name: 'installationId', in: 'path' },
        description: 'The installation’s id on GitHub, a positive whole number.',
      }),
    }),
  },
  responses: {
    204: { description: 'Disconnected.' },
    400: json(failure('invalid_request'), 'The id is not a GitHub id.'),
    401: signedOut,
    403: {
      content: {
        'application/json': {
          schema: z.union([failure('not_a_member'), failure('not_allowed'), failure('bad_origin')]),
        },
      },
      description:
        'The person is not in the workspace, is not an owner or admin of it, or the request ' +
        'did not come from the web app.',
    },
    404: json(
      failure('installation_not_found'),
      'The workspace holds no installation with that id, whether or not another does.',
    ),
    409: noActiveWorkspace,
  },
});

// GitHub tokens for a cell (14.3): the one route a cell calls, signed by the cell, not a browser.

export const GitHubTokenRequestBody = z
  .object({
    request: z.string().openapi({
      description:
        `The request, signed by the cell: a JWS in compact serialization whose payload is the ` +
        `contract's \`GitHubTokenRequest\` as JSON, with \`alg\` \`${CELL_TOKEN_ALGORITHM}\`, the ` +
        `cell's key's \`kid\` and \`typ\` \`${GITHUB_TOKEN_REQUEST_TYPE}\` in its protected header.`,
    }),
  })
  .openapi('GitHubTokenRequestBody');

const access = z.enum(['read', 'write']);

export const GitHubToken = z
  .strictObject({
    token: z.string().openapi({ description: 'An installation token. Never log or store it.' }),
    expiresAt: z.number().int().openapi({ description: 'In whole seconds since the epoch.' }),
    repositories: z
      .array(z.strictObject({ id: z.number().int(), fullName: z.string() }))
      .openapi({ description: 'Exactly the repositories asked for, as GitHub names them now.' }),
    permissions: z
      .strictObject({
        contents: access.optional(),
        pull_requests: access.optional(),
        metadata: z.literal('read').optional(),
      })
      .openapi({
        description:
          "Exactly the purpose's permissions, and the metadata read GitHub gives every token.",
      }),
  })
  .openapi('GitHubToken', {
    description: 'A GitHub token narrowed to a workspace’s repositories, for an hour at most.',
  });

export const postGitHubToken = createRoute({
  method: 'post',
  path: '/api/github/tokens',
  summary: 'Mint a GitHub token for a cell, narrowed to repositories and a purpose',
  description:
    'Called by a regional cell, never a browser: the request is signed with the key configured ' +
    'for the cell’s region, so it sits outside the origin check and carries no session. The ' +
    'workspace must hold the installation and be in that cell’s region, and the installation ' +
    'must cover every repository. The purpose fixes the permissions. Every token minted is ' +
    'recorded; the token itself is not, and no cache keeps the answer (`Cache-Control: no-store`).',
  request: body(GitHubTokenRequestBody),
  responses: {
    201: json(GitHubToken, 'The token, narrowed as asked.'),
    400: {
      content: {
        'application/json': {
          schema: z.union([
            failure('invalid_request'),
            failure('unreadable'),
            z
              .strictObject({
                error: z.literal('invalid_token_request'),
                problems: z.array(z.enum(TOKEN_REQUEST_PROBLEMS)),
              })
              .openapi('InvalidTokenRequest', {
                description: 'Every problem with the repositories asked for, in rule order.',
              }),
          ]),
        },
      },
      description:
        'The body is not `{ request }`, the signed request is none the contract reads (expired, ' +
        'say), or its repositories break the purpose’s rules.',
    },
    401: json(failure('unsigned'), 'No cell’s key checks the request.'),
    403: {
      content: {
        'application/json': {
          schema: z.union([
            failure('other_region'),
            z
              .strictObject({
                error: z.literal('repository_not_covered'),
                repositoryIds: z.array(z.number().int()),
              })
              .openapi('RepositoryNotCovered', {
                description:
                  'The repositories, by their GitHub ids, the installation does not cover.',
              }),
            failure('scope_refused'),
          ]),
        },
      },
      description:
        'The workspace is in another region than the cell, the installation does not cover a ' +
        'repository, or GitHub refused the scope (a permission the app was not granted).',
    },
    404: json(
      failure('installation_not_found'),
      'The workspace holds no installation with that id, whether or not another does.',
    ),
    410: json(failure('installation_gone'), 'GitHub no longer has the installation.'),
    415: unsupportedMediaType,
    503: {
      content: {
        'application/json': {
          schema: z.union([failure('github_not_configured'), failure('github_unavailable')]),
        },
      },
      description: 'This server has no GitHub App, or GitHub did not answer as it should.',
    },
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
  getConnections,
  postGitHubInstall,
  getGitHubCallback,
  deleteGitHubInstallation,
  getHealth,
  // Registered before every other route, outside the origin check: a cell calls it.
  postGitHubToken,
];

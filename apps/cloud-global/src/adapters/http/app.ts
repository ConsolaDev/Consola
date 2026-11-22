import { CELL_TOKEN_KEYS_PATH } from '@consola/cloud-contract';
import { type Context, Hono } from 'hono';
import { cellTokenKeys, mintCellToken } from '../../application/cellToken.js';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import type {
  CellTokenSigner,
  HealthProbe,
  MembershipStore,
  SessionStore,
  WorkspaceStore,
} from '../../application/ports.js';
import {
  createWorkspace,
  listMyWorkspaces,
  setActiveWorkspace,
} from '../../application/workspaces.js';
import type { SignedIn } from '../../domain/person.js';

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Now, in whole seconds since the epoch: what a cell token's times are in. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A request's JSON body when it is an object, else null. */
async function objectBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The HTTP API. Every route sits under `/api`, which the web app proxies to this service. Each
 * route asks a use case and maps its answer to a status and a body; sign-in itself is handed to
 * `handleAuth` whole. A request that changes something must come from the web app's origin
 * (`webOrigin`), as Better Auth requires of its own: the session cookie is SameSite=Lax, which
 * another site on the same host (any other localhost port) would still be sent.
 */
export function createApp(deps: {
  handleAuth: (request: Request) => Promise<Response>;
  currentSession: (headers: Headers) => Promise<SignedIn | null>;
  webOrigin: string;
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  sessions: SessionStore;
  cellTokens: CellTokenSigner;
  health: HealthProbe;
}): Hono {
  const {
    handleAuth,
    currentSession,
    webOrigin,
    workspaces,
    memberships,
    sessions,
    cellTokens,
    health,
  } = deps;
  const app = new Hono();

  app.all('/api/auth/*', (c) => handleAuth(c.req.raw));

  app.use('/api/*', async (c, next) => {
    if (!CHANGES.has(c.req.method) || c.req.header('origin') === webOrigin) return next();
    return c.json({ error: 'bad_origin' }, 403);
  });

  const signedIn = (c: Context) => currentSession(c.req.raw.headers);
  const signedOut = (c: Context) => c.json({ error: 'signed_out' }, 401);

  app.get('/api/me', async (c) => {
    const answer = await describeMe(memberships, await signedIn(c));
    if (answer.kind === 'signed-out') return signedOut(c);
    return c.json(answer.me);
  });

  app.put('/api/me/workspace', async (c) => {
    const session = await signedIn(c);
    if (!session) return signedOut(c);
    const workspaceId = (await objectBody(c))?.workspaceId;
    if (typeof workspaceId !== 'string') return c.json({ error: 'invalid_request' }, 400);

    const answer = await setActiveWorkspace({ memberships, sessions }, session, workspaceId);
    if (answer.kind === 'not-found') return c.json({ error: 'workspace_not_found' }, 404);
    return c.json(answer.workspace);
  });

  app.get('/api/workspaces', async (c) => {
    const session = await signedIn(c);
    if (!session) return signedOut(c);
    return c.json({ workspaces: await listMyWorkspaces(memberships, session.person) });
  });

  app.post('/api/workspaces', async (c) => {
    const session = await signedIn(c);
    if (!session) return signedOut(c);

    const answer = await createWorkspace(
      { workspaces, sessions },
      session,
      (await objectBody(c)) ?? {},
    );
    if (answer.kind === 'invalid') {
      return c.json({ error: 'invalid_workspace', problems: answer.problems }, 400);
    }
    if (answer.kind === 'slug-taken') return c.json({ error: 'slug_taken' }, 409);
    return c.json(answer.workspace, 201);
  });

  // The token a cell trusts, for the session's active workspace. Nothing in the request names the
  // workspace or the role: both are read from the database as it is minted.
  app.post('/api/cell-token', async (c) => {
    const session = await signedIn(c);
    if (!session) return signedOut(c);

    const answer = await mintCellToken({ memberships, signer: cellTokens }, session, nowSeconds());
    if (answer.kind === 'no-workspace') return c.json({ error: 'no_active_workspace' }, 409);
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' }, 403);
    // A token is a credential, so no cache keeps it.
    c.header('cache-control', 'no-store');
    return c.json({ token: answer.token, expiresAt: answer.expiresAt });
  });

  // The public keys a cell checks the token with, for anyone to read.
  app.get(CELL_TOKEN_KEYS_PATH, (c) => c.json(cellTokenKeys(cellTokens)));

  app.get('/api/health', async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true });
    return c.json({ ok: false }, 503);
  });

  return app;
}

import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { z } from '@hono/zod-openapi';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '../../../shared/workspaceRole.js';
import type { GitHubApp, InstallationStore } from '../../application/gitHubPorts.js';
import type { MembershipReader } from '../../application/ports.js';
import type { SignedInPerson } from '../../domain/caller.js';
import type { GitHubInstallation } from '../../domain/connections.js';
import { createInstallStateSigner } from '../github/installStateSigner.js';
import { createWebhookSignatures } from '../github/webhookSignatures.js';
import { createGitHubStores } from '../persistence/gitHubStores.js';
import * as gitHubTables from '../persistence/gitHubTables.js';
import { WORKSPACE_HEADER } from './caller.js';
import { GITHUB_ROUTES, registerGitHubRoutes } from './gitHub.js';
import {
  deleteGitHubInstallation,
  getConnections,
  postGitHubInstall,
  postGitHubWebhook,
} from './gitHubContract.js';

// GitHub's routes on an app of their own, as the composition registers them, with a session
// that is a header (`x-test-person`) and members kept in a map. The whole API's suite, with
// Better Auth's sessions and the front door, is the composition's.

const PUBLIC_URL = 'http://localhost:5175';
const SECRET = 'sprocket-test-webhook-secret-0123456789';
const now = 1_795_000_000;

let client: PGlite;
let installations: InstallationStore;
let stores: ReturnType<typeof createGitHubStores>;
let app: OpenAPIHono;
let roles: Map<string, WorkspaceRole>;
const lines: string[] = [];

const membership: MembershipReader = {
  roleOf: async (personId, workspaceId) => roles.get(`${workspaceId}/${personId}`) ?? null,
  memberIds: async () => [],
  workspaceIds: async () => [],
};

const sprocketOrg: GitHubInstallation = {
  id: 41,
  account: { id: 9001, login: 'sprocket', type: 'Organization' },
  repositorySelection: 'selected',
};

const github: GitHubApp = {
  installUrl: (state) => `https://github.test/install?state=${state}`,
  installerFacts: async (code, installationId) =>
    code === 'good-code'
      ? {
          kind: 'read',
          facts: {
            installation: installationId === sprocketOrg.id ? sprocketOrg : null,
            gitHubUserId: 7,
            organizationRole: 'admin',
          },
        }
      : { kind: 'code-refused' },
  repositoriesOf: async () => ({ kind: 'listed', repositories: [] }),
};

/** GitHub's routes on an app of their own, with the GitHub App and the webhook secret or not. */
function build(
  configured: { github: boolean; webhooks: boolean } = { github: true, webhooks: true },
) {
  const log = (line: string) => {
    lines.push(line);
  };
  const built = new OpenAPIHono();
  registerGitHubRoutes(built, {
    // The session says who is asking, with Sprocket active: the person's one session, unless
    // the request names another of theirs (`x-test-session`).
    whoIsAsking: async (headers): Promise<SignedInPerson | null> => {
      const personId = headers.get('x-test-person');
      if (!personId) return null;
      const sessionId = headers.get('x-test-session') ?? `session-of-${personId}`;
      return { personId, sessionId, activeWorkspaceId: 'sprocket' };
    },
    membership,
    publicUrl: PUBLIC_URL,
    installations,
    github: configured.github ? github : null,
    installStates: createInstallStateSigner(
      'sprocket-test-secret-that-is-long-enough-to-sign-with',
    ),
    clock: { nowSeconds: () => now },
    webhooks: {
      signatures: configured.webhooks ? createWebhookSignatures(SECRET) : null,
      events: stores.events,
      log: { info: log, warn: log },
    },
  });
  return built;
}

beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  stores = createGitHubStores(drizzle(client));
  ({ installations } = stores);
  roles = new Map<string, WorkspaceRole>([
    ['sprocket/dana', 'owner'],
    ['sprocket/lee', 'member'],
  ]);
  lines.length = 0;
  app = build();
});

afterEach(async () => {
  if (!client.closed) await client.close();
});

/** The headers a page sends for a person, showing Sprocket. */
const as = (personId: string) => ({ 'x-test-person': personId, [WORKSPACE_HEADER]: 'sprocket' });

type Route = {
  responses: Record<
    number,
    { description: string; content?: Record<string, { schema: z.ZodType }> }
  >;
};

/** The body, checked against the schema the route declares for its status. */
async function declared(route: Route, response: Response): Promise<unknown> {
  const declaration = route.responses[response.status];
  expect(declaration, `${response.status} is not declared`).toBeDefined();
  const schema = declaration?.content?.['application/json']?.schema;
  if (!schema) return null;
  const body: unknown = await response.json();
  expect(schema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  return body;
}

function signed(body: string, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      'x-github-event': 'pull_request',
      'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      ...headers,
    },
  };
}

describe("GitHub's routes", () => {
  it('registers every route the list names, and only those', () => {
    const paths = app.openAPIRegistry.definitions
      .filter((definition) => definition.type === 'route')
      .map((definition) => `${definition.route.method} ${definition.route.path}`);
    expect(paths).toEqual(GITHUB_ROUTES.map((route) => `${route.method} ${route.path}`));
  });

  it('lets only an admitted caller list Connections, with what they may do', async () => {
    const signedOut = await app.request('/api/connections', {
      headers: { [WORKSPACE_HEADER]: 'sprocket' },
    });
    expect(signedOut.status).toBe(401);
    expect(await declared(getConnections, signedOut)).toEqual({ error: 'signed_out' });

    const outsider = await app.request('/api/connections', { headers: as('ana') });
    expect(await declared(getConnections, outsider)).toEqual({ error: 'not_a_member' });

    const switched = await app.request('/api/connections', {
      headers: { ...as('dana'), [WORKSPACE_HEADER]: 'acme' },
    });
    expect(await declared(getConnections, switched)).toEqual({ error: 'workspace_switched' });

    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: new Date(now * 1000),
    });
    const forLee = await app.request('/api/connections', { headers: as('lee') });
    expect(forLee.status).toBe(200);
    expect(await declared(getConnections, forLee)).toEqual({
      canManage: false,
      github: {
        configured: true,
        installations: [
          {
            id: 41,
            account: sprocketOrg.account,
            connectedAt: new Date(now * 1000).toISOString(),
            settingsUrl: 'https://github.com/organizations/sprocket/settings/installations/41',
            repositories: { kind: 'listed', repositories: [] },
          },
        ],
      },
    });
  });

  it('starts a Connect for an owner only, and connects it on the way back', async () => {
    const member = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: as('lee'),
    });
    expect(await declared(postGitHubInstall, member)).toEqual({ error: 'not_allowed' });

    const owner = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: as('dana'),
    });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('cache-control')).toBe('no-store');
    const { url } = (await declared(postGitHubInstall, owner)) as { url: string };
    const state = new URL(url).searchParams.get('state') ?? '';

    const query = new URLSearchParams({
      state,
      code: 'good-code',
      installation_id: '41',
      setup_action: 'install',
    });
    // The callback is a browser redirect: a session, but no workspace header.
    const back = await app.request(`/api/github/callback?${query}`, {
      headers: { 'x-test-person': 'dana' },
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      `${PUBLIC_URL}/?github=connected#/settings/connections`,
    );
    expect(back.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await installations.ofWorkspace('sprocket')).toHaveLength(1);
  });

  it('sends the same person back as bad_state from another of their sessions', async () => {
    const owner = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: as('dana'),
    });
    const { url } = (await declared(postGitHubInstall, owner)) as { url: string };
    const query = new URLSearchParams({
      state: new URL(url).searchParams.get('state') ?? '',
      code: 'good-code',
      installation_id: '41',
      setup_action: 'install',
    });
    // Dana, signed in in another browser too, follows the link there.
    const back = await app.request(`/api/github/callback?${query}`, {
      headers: { 'x-test-person': 'dana', 'x-test-session': 'session-of-dana-elsewhere' },
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      `${PUBLIC_URL}/?github=bad_state#/settings/connections`,
    );
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  it('says the app is not configured, on Connect and on the way back', async () => {
    app = build({ github: false, webhooks: true });
    const owner = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: as('dana'),
    });
    expect(await declared(postGitHubInstall, owner)).toEqual({ error: 'github_not_configured' });
    const back = await app.request('/api/github/callback?state=x', {
      headers: { 'x-test-person': 'dana' },
    });
    expect(back.headers.get('location')).toBe(
      `${PUBLIC_URL}/?github=not_configured#/settings/connections`,
    );
  });

  it('sends a signed-out person back as signed out', async () => {
    const back = await app.request('/api/github/callback?state=x&code=y');
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      `${PUBLIC_URL}/?github=signed_out#/settings/connections`,
    );
  });

  it('disconnects for an owner, and names what it cannot', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: new Date(now * 1000),
    });
    const remove = (id: string, personId = 'dana') =>
      app.request(`/api/connections/github/installations/${id}`, {
        method: 'DELETE',
        headers: as(personId),
      });

    expect(await declared(deleteGitHubInstallation, await remove('041'))).toEqual({
      error: 'invalid_request',
    });
    expect(await declared(deleteGitHubInstallation, await remove('41', 'lee'))).toEqual({
      error: 'not_allowed',
    });
    expect(await declared(deleteGitHubInstallation, await remove('52'))).toEqual({
      error: 'installation_not_found',
    });
    expect((await remove('41')).status).toBe(204);
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
  });

  describe('the webhook', () => {
    const pullRequest = JSON.stringify({ action: 'opened', installation: { id: 41 } });

    beforeEach(async () => {
      await installations.connect({
        installation: sprocketOrg,
        workspaceId: 'sprocket',
        connectedBy: 'dana',
        at: new Date(now * 1000),
      });
    });

    const post = (init: RequestInit) => app.request('/api/github/webhooks', init);

    it('records an event once: 201, then 409 for the same delivery', async () => {
      const first = await post(signed(pullRequest));
      expect(first.status).toBe(201);
      expect(await declared(postGitHubWebhook, first)).toEqual({ result: 'recorded' });

      const again = await post(signed(pullRequest));
      expect(await declared(postGitHubWebhook, again)).toEqual({ error: 'duplicate_delivery' });
      expect(lines).toEqual([
        'Recorded GitHub delivery 72d3162e-cc78-11e3-81ab-4c9367dc0958 (pull_request) for workspace sprocket (installation 41).',
        'Refused GitHub delivery 72d3162e-cc78-11e3-81ab-4c9367dc0958 (pull_request): workspace sprocket (installation 41) had it already.',
      ]);
    });

    it("answers GitHub's ping with 200", async () => {
      const ping = await post(
        signed('{"zen":"Keep it logically awesome."}', { 'x-github-event': 'ping' }),
      );
      expect(ping.status).toBe(200);
      expect(await declared(postGitHubWebhook, ping)).toEqual({ result: 'pong' });
    });

    it('refuses what is unsigned, unreadable, too large or nobody’s', async () => {
      const unsigned = await post({
        ...signed(pullRequest),
        headers: { 'x-github-event': 'push' },
      });
      expect(await declared(postGitHubWebhook, unsigned)).toEqual({ error: 'bad_signature' });

      const noEvent = await post(signed(pullRequest, { 'x-github-event': 'Pull Request' }));
      expect(await declared(postGitHubWebhook, noEvent)).toEqual({ error: 'invalid_delivery' });

      const elsewhere = await post(signed(JSON.stringify({ installation: { id: 52 } })));
      expect(await declared(postGitHubWebhook, elsewhere)).toEqual({
        error: 'unknown_installation',
      });
      const through = await post(signed(JSON.stringify({ action: 'revoked' })));
      expect(await declared(postGitHubWebhook, through)).toEqual({ error: 'no_installation' });

      const large = await post({
        ...signed(pullRequest),
        body: 'x'.repeat(25 * 1024 * 1024 + 1),
      });
      expect(await declared(postGitHubWebhook, large)).toEqual({ error: 'too_large' });
    });

    it('refuses every delivery while no webhook secret is set', async () => {
      app = build({ github: true, webhooks: false });
      const answer = await post(signed(pullRequest));
      expect(await declared(postGitHubWebhook, answer)).toEqual({
        error: 'webhooks_not_configured',
      });
    });

    it('is 503 unavailable when the database does not answer, and logs no payload', async () => {
      await client.close();
      const answer = await post(
        signed(JSON.stringify({ installation: { id: 41 }, secret: 'payload-text' })),
      );
      expect(answer.status).toBe(503);
      expect(await declared(postGitHubWebhook, answer)).toEqual({ error: 'unavailable' });
      expect(lines.join('\n')).not.toContain('payload-text');
    });
  });
});

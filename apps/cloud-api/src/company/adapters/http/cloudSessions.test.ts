import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { applyRunnerUpdate } from '../../application/cloudSessions.js';
import type {
  CloudSessionPorts,
  Offer,
  PassSigner,
  RunnerChannel,
} from '../../application/ports.js';
import { fakeMembership } from '../../application/testMembership.js';
import type { SignedInPerson } from '../../domain/caller.js';
import type { Database } from '../persistence/database.js';
import { createCloudSessionStore } from '../persistence/cloudSessions.js';
import { openTestDatabase } from '../persistence/testDatabase.js';
import type { COMPANY_ROUTES } from './app.js';
import { requireCaller, WORKSPACE_HEADER } from './caller.js';
import { cloudSessionRoutes } from './cloudSessions.js';
import {
  getCloudSession,
  getCloudSessionOptions,
  listCloudSessions,
  postCloudSession,
  postCloudSessionPass,
  postCloudSessionStop,
} from './contract.js';

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
});
afterEach(async () => {
  await close();
});

type ContractRoute = (typeof COMPANY_ROUTES)[number];
type DeclaredAnswer = { content?: Record<string, { schema: ZodType }> };

/**
 * The body of `response`, read with the schema `route` declares for its status, as the HTTP suite
 * reads every answer: a status the contract does not name, or a body with a field
 * its strict schema does not, fails the test.
 */
async function answerOf(route: ContractRoute, response: Response): Promise<unknown> {
  const declared = (route.responses as Record<number, DeclaredAnswer>)[response.status];
  expect(declared, `${route.method} ${route.path} declares ${response.status}`).toBeDefined();
  const schema = declared?.content?.['application/json']?.schema;
  if (!schema) {
    expect(await response.text()).toBe('');
    return undefined;
  }
  return schema.parse(await response.json());
}

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
};

/** Signs nothing: the pass is a stand-in the test can find in what the route answers. */
const passes: PassSigner = { sign: async (claims) => `pass-for-${claims.sid}-until-${claims.exp}` };

/**
 * An app as the composition builds one around company's routes: a body of the wrong shape is
 * 400 `invalid_request`, one that is not JSON 400 too, and one without a JSON content type 415,
 * as the front door answers them.
 */
function frontDoor(): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) =>
      result.success ? undefined : c.json({ error: 'invalid_request' } as const, 400),
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (error instanceof HTTPException && error.status === 415) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    throw error;
  });
  return app;
}

/** The app, asked as the page that shows the asking person's workspace asks it. */
type App = { request(path: string, init?: RequestInit): Promise<Response> };

function build(connected: Offer | null = offer, passSigner: PassSigner | null = passes) {
  let next = 0;
  const channel: RunnerChannel = {
    connected: () => connected,
    startSession: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
  };
  const ports: CloudSessionPorts = {
    sessions: createCloudSessionStore(db),
    runners: channel,
    ids: { newId: () => `session-${++next}` },
    clock: { nowSeconds: () => 1000 },
    passes: passSigner,
  };
  // The routes behind the real caller check: who is signed in, with which workspace active, is
  // whoever the test says, a member there, and every request names that workspace as shown.
  const membership = fakeMembership();
  let who: SignedInPerson | null = {
    personId: 'person-1',
    sessionId: 'session-1',
    activeWorkspaceId: 'acme',
  };
  const as = (personId: string, workspaceId = 'acme') => {
    membership.put(workspaceId, personId, 'member');
    who = { personId, sessionId: `session-of-${personId}`, activeWorkspaceId: workspaceId };
  };
  as('person-1');
  const router = frontDoor();
  const caller = requireCaller({ whoIsAsking: async () => who, membership });
  cloudSessionRoutes(router, { caller, ports });
  const app: App = {
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has(WORKSPACE_HEADER)) {
        headers.set(WORKSPACE_HEADER, who?.activeWorkspaceId ?? '');
      }
      return router.request(path, { ...init, headers });
    },
  };
  return {
    app,
    router,
    ports,
    channel,
    membership,
    as,
    signOut: () => {
      who = null;
    },
  };
}

const post = (app: App, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = { repository: 'sprocket/catalog-portal', harness: 'claude' };

describe('the caller check', () => {
  it("answers requireCaller's refusals before any route runs, starting nothing", async () => {
    const { app, router, membership, as, signOut, channel } = build();
    const start = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const ask = (headers: Record<string, string>) =>
      router.request('/api/cloud-sessions', {
        ...start,
        headers: { ...start.headers, ...headers },
        body: JSON.stringify(valid),
      });

    // No workspace shown: the page does not say which it shows.
    let response = await ask({});
    expect([response.status, await answerOf(postCloudSession, response)]).toEqual([
      400,
      { error: 'invalid_request' },
    ]);
    // Another tab switched the session's workspace.
    response = await ask({ [WORKSPACE_HEADER]: 'sprocket' });
    expect([response.status, await answerOf(postCloudSession, response)]).toEqual([
      409,
      { error: 'workspace_switched' },
    ]);
    // No longer a member of the workspace the session has active.
    membership.remove('acme', 'person-1');
    response = await app.request('/api/cloud-sessions', {
      ...start,
      body: JSON.stringify(valid),
    });
    expect([response.status, await answerOf(postCloudSession, response)]).toEqual([
      403,
      { error: 'not_a_member' },
    ]);
    as('person-1');
    signOut();
    response = await ask({ [WORKSPACE_HEADER]: 'acme' });
    expect([response.status, await answerOf(postCloudSession, response)]).toEqual([
      401,
      { error: 'signed_out' },
    ]);
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('serves no path but its routes', async () => {
    const { app } = build();
    expect((await app.request('/api/cloud-sessions/session-1/nothing')).status).toBe(404);
  });
});

describe('GET /api/cloud-sessions/options', () => {
  it('answers what the runner offers', async () => {
    const { app } = build();
    const response = await app.request('/api/cloud-sessions/options');
    expect(response.status).toBe(200);
    expect(await answerOf(getCloudSessionOptions, response)).toEqual({
      repositories: ['sprocket/catalog-portal'],
      harnesses: ['claude'],
    });
  });

  it('is 503 no_runner without one', async () => {
    const response = await build(null).app.request('/api/cloud-sessions/options');
    expect(response.status).toBe(503);
    expect(await answerOf(getCloudSessionOptions, response)).toEqual({ error: 'no_runner' });
  });
});

describe('POST /api/cloud-sessions', () => {
  it('is 201 with the session, and starts it once', async () => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', valid);
    expect(response.status).toBe(201);
    expect(await answerOf(postCloudSession, response)).toMatchObject({
      id: 'session-1',
      status: 'starting',
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      workspaceId: 'acme',
      personId: 'person-1',
    });
    expect(channel.startSession).toHaveBeenCalledTimes(1);
  });

  it('is 503 {"error":"no_runner"} with no runner, and leaves no row', async () => {
    const { app } = build(null);
    const response = await post(app, '/api/cloud-sessions', valid);
    expect(response.status).toBe(503);
    expect(await answerOf(postCloudSession, response.clone())).toEqual({ error: 'no_runner' });
    expect(await response.text()).toBe('{"error":"no_runner"}');
    const listed = await app.request('/api/cloud-sessions');
    expect(await answerOf(listCloudSessions, listed)).toEqual([]);
  });

  it.each([
    ['repository_not_offered', { ...valid, repository: 'sprocket/other' }],
    ['harness_not_offered', { ...valid, harness: 'codex' }],
  ])('is 400 %s and sends nothing', async (code, body) => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', body);
    expect(response.status).toBe(400);
    expect(await answerOf(postCloudSession, response)).toEqual({ error: code });
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['missing the harness', '{"repository":"sprocket/catalog-portal"}'],
    ['a harness no runner runs', '{"repository":"sprocket/catalog-portal","harness":"cursor"}'],
    ['a repository that is no owner/name', '{"repository":"sprocket","harness":"claude"}'],
    ['a repository named for a dot folder', '{"repository":"sprocket/.git","harness":"claude"}'],
    [
      'carrying a workspace id',
      '{"repository":"sprocket/catalog-portal","harness":"claude","workspaceId":"sprocket"}',
    ],
  ])('is 400 invalid_request for %s, sending nothing', async (_name, body) => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', body);
    expect(response.status).toBe(400);
    expect(await answerOf(postCloudSession, response)).toEqual({ error: 'invalid_request' });
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it('is 415 unsupported_media_type for a body not sent as JSON, sending nothing', async () => {
    const { app, channel } = build();
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/xml' },
    ]) {
      const response = await app.request('/api/cloud-sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify(valid),
      });
      expect(response.status).toBe(415);
      expect(await answerOf(postCloudSession, response)).toEqual({
        error: 'unsupported_media_type',
      });
    }
    expect(channel.startSession).not.toHaveBeenCalled();
  });
});

describe('listing and reading', () => {
  it('lists the caller’s sessions, newest first', async () => {
    const { app, as } = build();
    await post(app, '/api/cloud-sessions', valid);
    as('person-2');
    await post(app, '/api/cloud-sessions', valid);
    as('person-1');
    const listed = (await answerOf(
      listCloudSessions,
      await app.request('/api/cloud-sessions'),
    )) as Array<{ id: string }>;
    expect(listed.map((s) => s.id)).toEqual(['session-1']);
  });

  it('is 404 not_found for anything not the caller’s own', async () => {
    const { app, as } = build();
    await post(app, '/api/cloud-sessions', valid);
    const own = await app.request('/api/cloud-sessions/session-1');
    expect(own.status).toBe(200);
    expect(await answerOf(getCloudSession, own)).toMatchObject({ id: 'session-1' });
    for (const [person, workspace] of [
      ['person-2', 'acme'],
      ['person-1', 'sprocket'],
    ] as const) {
      as(person, workspace);
      const response = await app.request('/api/cloud-sessions/session-1');
      expect(response.status).toBe(404);
      expect(await answerOf(getCloudSession, response)).toEqual({ error: 'not_found' });
    }
    const unknown = await app.request('/api/cloud-sessions/unknown');
    expect(unknown.status).toBe(404);
    expect(await answerOf(getCloudSession, unknown)).toEqual({ error: 'not_found' });
  });
});

describe('agent runs', () => {
  /** An agent run an automation started in Acme, as `startAgentRun` records it, and reported on. */
  async function anAgentRun(ports: CloudSessionPorts) {
    await ports.sessions.insert({
      id: 'run-1',
      workspaceId: 'acme',
      personId: null,
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      status: 'starting',
      title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
      hostUrl: null,
      error: null,
      errorCode: null,
      runnerId: 'runner-1',
      createdAt: 2000,
      endedAt: null,
      origin: {
        kind: 'automation',
        factoryId: 'factory-1',
        factoryName: 'Reviews',
        automation: 'review-pull-requests',
        agent: 'orchestrator',
        item: {
          kind: 'pull_request',
          repository: 'sprocket/catalog-portal',
          number: 7,
          url: 'https://github.com/sprocket/catalog-portal/pull/7',
          title: 'Price the catalog in euros',
          headSha: 'a'.repeat(40),
        },
      },
      agentRun: null,
    });
    await applyRunnerUpdate(
      ports,
      { workspaceId: 'acme', runnerId: 'runner-1' },
      {
        type: 'session.update',
        sessionId: 'run-1',
        status: 'running',
        agentRun: {
          state: 'working',
          summary: 'Dispatched a review.',
          agents: [{ id: 'c-1', agent: 'review', status: 'working' }],
        },
      },
    );
  }

  it("are no one's sessions: the list holds a person's own, in the contract's shape", async () => {
    const { app, ports, as } = build();
    await post(app, '/api/cloud-sessions', valid);
    await anAgentRun(ports);
    as('person-2');
    const listed = await app.request('/api/cloud-sessions');
    expect(listed.status).toBe(200);
    // An agent run is a run of the Runs pages, whose page opens its session as its conversation.
    expect(await answerOf(listCloudSessions, listed)).toEqual([]);
    as('person-1');
    const own = (await answerOf(
      listCloudSessions,
      await app.request('/api/cloud-sessions'),
    )) as Array<{
      id: string;
      origin: unknown;
      agentRun: unknown;
    }>;
    expect(own.map((s) => s.id)).toEqual(['session-1']);
    expect(own[0]).toMatchObject({ origin: null, agentRun: null });
  });

  it("are read by any member in the contract's shape, the runner's report included", async () => {
    const { app, ports, as } = build();
    await anAgentRun(ports);
    as('person-2');
    const read = await app.request('/api/cloud-sessions/run-1');
    expect(await answerOf(getCloudSession, read)).toEqual(
      expect.objectContaining({
        id: 'run-1',
        personId: null,
        status: 'running',
        origin: expect.objectContaining({
          automation: 'review-pull-requests',
          agent: 'orchestrator',
        }),
        agentRun: {
          state: 'working',
          summary: 'Dispatched a review.',
          agents: [{ id: 'c-1', agent: 'review', status: 'working' }],
        },
      }),
    );
  });

  it('are read and stopped by any member, and never by another workspace', async () => {
    const { app, ports, as, channel } = build();
    await anAgentRun(ports);
    as('person-2');
    const read = await app.request('/api/cloud-sessions/run-1');
    expect(read.status).toBe(200);
    expect(await answerOf(getCloudSession, read)).toMatchObject({ id: 'run-1', personId: null });
    const stopped = await post(app, '/api/cloud-sessions/run-1/stop');
    expect(stopped.status).toBe(202);
    expect(await answerOf(postCloudSessionStop, stopped)).toMatchObject({ status: 'stopped' });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'run-1');
    as('person-2', 'sprocket');
    const elsewhere = await app.request('/api/cloud-sessions/run-1');
    expect(elsewhere.status).toBe(404);
    expect(await answerOf(getCloudSession, elsewhere)).toEqual({ error: 'not_found' });
  });
});

describe('POST /api/cloud-sessions/:id/stop', () => {
  it('is 202 with the session, now stopped', async () => {
    const { app, channel } = build();
    await post(app, '/api/cloud-sessions', valid);
    const response = await post(app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(202);
    expect(await answerOf(postCloudSessionStop, response)).toMatchObject({
      id: 'session-1',
      status: 'stopped',
    });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'session-1');
  });

  it('is 404 for another person’s session', async () => {
    const { app, as, channel } = build();
    await post(app, '/api/cloud-sessions', valid);
    as('person-2');
    const response = await post(app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(404);
    expect(await answerOf(postCloudSessionStop, response)).toEqual({ error: 'not_found' });
    expect(channel.stopSession).not.toHaveBeenCalled();
  });

  it('is still 202 while the runner is disconnected', async () => {
    const connected = build();
    await post(connected.app, '/api/cloud-sessions', valid);
    // Same database, a cell whose runner has gone.
    const gone = build(null);
    const response = await post(gone.app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(202);
    expect(await answerOf(postCloudSessionStop, response)).toMatchObject({ status: 'stopped' });
  });
});

describe('POST /api/cloud-sessions/:id/pass', () => {
  async function running(built = build()) {
    await post(built.app, '/api/cloud-sessions', valid);
    await applyRunnerUpdate(
      built.ports,
      { workspaceId: 'acme', runnerId: 'runner-1' },
      {
        type: 'session.update',
        sessionId: 'session-1',
        status: 'running',
        hostUrl: 'https://3000-abc.e2b.example',
      },
    );
    return built;
  }

  it('is 200 with exactly the pass, the host and when it expires, never stored', async () => {
    const { app } = await running();
    const response = await post(app, '/api/cloud-sessions/session-1/pass');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, response)).toEqual({
      pass: 'pass-for-session-1-until-1300',
      hostUrl: 'https://3000-abc.e2b.example',
      expiresAt: 1300,
    });
  });

  it('is 404 not_found, never stored, for a session not running or not the caller’s', async () => {
    const built = build();
    await post(built.app, '/api/cloud-sessions', valid);
    const starting = await post(built.app, '/api/cloud-sessions/session-1/pass');
    expect(starting.status).toBe(404);
    expect(starting.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, starting)).toEqual({ error: 'not_found' });

    // The same app: its runner moves session-1 on (and a second session starts, unused).
    const { app, as } = await running(built);
    as('person-2');
    const others = await post(app, '/api/cloud-sessions/session-1/pass');
    expect(others.status).toBe(404);
    expect(await answerOf(postCloudSessionPass, others)).toEqual({ error: 'not_found' });
    as('person-1');
    const unknown = await post(app, '/api/cloud-sessions/nope/pass');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, unknown)).toEqual({ error: 'not_found' });
  });

  it('is 503 no_runner when the cell has no pass key', async () => {
    const { app } = await running(build(offer, null));
    const response = await post(app, '/api/cloud-sessions/session-1/pass');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, response)).toEqual({ error: 'no_runner' });
  });
});

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRunnerUpdate } from '../../application/cloudSessions.js';
import type {
  CloudSessionPorts,
  Offer,
  PassSigner,
  RunnerChannel,
} from '../../application/ports.js';
import type { Caller } from '../../domain/caller.js';
import { type Database, migrateDatabase, openDatabase } from '../persistence/database.js';
import { createCloudSessionStore } from '../persistence/cloudSessions.js';
import type { CellEnv } from './caller.js';
import { cloudSessionRoutes } from './cloudSessions.js';

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
});
afterEach(async () => {
  await close();
});

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
};

/** Signs nothing: the pass is a stand-in the test can find in what the route answers. */
const passes: PassSigner = { sign: async (claims) => `pass-for-${claims.sid}-until-${claims.exp}` };

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
  // The caller is whoever the test says, standing in for `requireCaller`.
  const app = new Hono<CellEnv>();
  let who = { personId: 'person-1', workspaceId: 'acme' };
  app.use('*', async (c, next) => {
    c.set('caller', { ...who, role: 'member', region: 'eu' } as Caller);
    await next();
  });
  app.route('/', cloudSessionRoutes(ports));
  return {
    app,
    ports,
    channel,
    as: (personId: string, workspaceId = 'acme') => (who = { personId, workspaceId }),
  };
}

const post = (app: Hono<CellEnv>, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = { repository: 'sprocket/catalog-portal', harness: 'claude' };

describe('GET /api/cloud-sessions/options', () => {
  it('answers what the runner offers', async () => {
    const { app } = build();
    const response = await app.request('/api/cloud-sessions/options');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: ['sprocket/catalog-portal'],
      harnesses: ['claude'],
    });
  });

  it('is 503 no_runner without one', async () => {
    const response = await build(null).app.request('/api/cloud-sessions/options');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'no_runner' });
  });
});

describe('POST /api/cloud-sessions', () => {
  it('is 201 with the session, and starts it once', async () => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
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
    expect(await response.text()).toBe('{"error":"no_runner"}');
    expect(await (await app.request('/api/cloud-sessions')).json()).toEqual([]);
  });

  it.each([
    ['repository_not_offered', { ...valid, repository: 'sprocket/other' }],
    ['harness_not_offered', { ...valid, harness: 'codex' }],
  ])('is 400 %s and sends nothing', async (code, body) => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(channel.startSession).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['missing the harness', '{"repository":"sprocket/catalog-portal"}'],
    [
      'carrying a workspace id',
      '{"repository":"sprocket/catalog-portal","harness":"claude","workspaceId":"globex"}',
    ],
  ])('is 400 invalid_request for %s, sending nothing', async (_name, body) => {
    const { app, channel } = build();
    const response = await post(app, '/api/cloud-sessions', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
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
    const listed = (await (await app.request('/api/cloud-sessions')).json()) as { id: string }[];
    expect(listed.map((s) => s.id)).toEqual(['session-1']);
  });

  it('is 404 not_found for anything not the caller’s own', async () => {
    const { app, as } = build();
    await post(app, '/api/cloud-sessions', valid);
    expect((await app.request('/api/cloud-sessions/session-1')).status).toBe(200);
    for (const [person, workspace] of [
      ['person-2', 'acme'],
      ['person-1', 'globex'],
    ] as const) {
      as(person, workspace);
      const response = await app.request('/api/cloud-sessions/session-1');
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    expect((await app.request('/api/cloud-sessions/unknown')).status).toBe(404);
  });
});

describe('POST /api/cloud-sessions/:id/stop', () => {
  it('is 202 with the session, now stopped', async () => {
    const { app, channel } = build();
    await post(app, '/api/cloud-sessions', valid);
    const response = await post(app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: 'session-1', status: 'stopped' });
    expect(channel.stopSession).toHaveBeenCalledWith('runner-1', 'session-1');
  });

  it('is 404 for another person’s session', async () => {
    const { app, as, channel } = build();
    await post(app, '/api/cloud-sessions', valid);
    as('person-2');
    const response = await post(app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(404);
    expect(channel.stopSession).not.toHaveBeenCalled();
  });

  it('is still 202 while the runner is disconnected', async () => {
    const connected = build();
    await post(connected.app, '/api/cloud-sessions', valid);
    // Same database, a cell whose runner has gone.
    const gone = build(null);
    const response = await post(gone.app, '/api/cloud-sessions/session-1/stop');
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'stopped' });
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
    expect(await response.json()).toEqual({
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
    expect(await starting.json()).toEqual({ error: 'not_found' });

    const { app, as } = await running(build());
    as('person-2');
    expect((await post(app, '/api/cloud-sessions/session-1/pass')).status).toBe(404);
    as('person-1');
    const unknown = await post(app, '/api/cloud-sessions/nope/pass');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
  });

  it('is 503 no_runner when the cell has no pass key', async () => {
    const { app } = await running(build(offer, null));
    const response = await post(app, '/api/cloud-sessions/session-1/pass');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'no_runner' });
  });
});

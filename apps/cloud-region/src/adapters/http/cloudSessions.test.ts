import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSessionPorts, Offer, RunnerChannel } from '../../application/ports.js';
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

function build(connected: Offer | null = offer) {
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

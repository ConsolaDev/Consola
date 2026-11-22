import { Hono } from 'hono';
import {
  getSession,
  listSessions,
  readStartRequest,
  sessionOptions,
  startSession,
  stopSession,
} from '../../application/cloudSessions.js';
import type { CloudSessionPorts } from '../../application/ports.js';
import type { CellEnv } from './caller.js';

/**
 * The cloud session routes, mounted behind `requireCaller`. Each hands its use case the caller
 * and never a workspace or a person from the request; the only body is `{ repository, harness }`.
 */
export function cloudSessionRoutes(ports: CloudSessionPorts): Hono<CellEnv> {
  const routes = new Hono<CellEnv>();

  routes.get('/api/cloud-sessions/options', (c) => {
    const answer = sessionOptions(ports, c.var.caller);
    if (answer.kind === 'no_runner') return c.json({ error: 'no_runner' }, 503);
    return c.json({ repositories: answer.repositories, harnesses: answer.harnesses });
  });

  routes.post('/api/cloud-sessions', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = readStartRequest(body);
    if (!request.ok) return c.json({ error: 'invalid_request' }, 400);
    const answer = await startSession(ports, c.var.caller, request.value);
    switch (answer.kind) {
      case 'ok':
        return c.json(answer.session, 201);
      case 'no_runner':
        return c.json({ error: 'no_runner' }, 503);
      case 'repository_not_offered':
      case 'harness_not_offered':
        return c.json({ error: answer.kind }, 400);
    }
  });

  routes.get('/api/cloud-sessions', async (c) => c.json(await listSessions(ports, c.var.caller)));

  routes.get('/api/cloud-sessions/:id', async (c) => {
    const answer = await getSession(ports, c.var.caller, c.req.param('id'));
    if (answer.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
    return c.json(answer.session);
  });

  routes.post('/api/cloud-sessions/:id/stop', async (c) => {
    const answer = await stopSession(ports, c.var.caller, c.req.param('id'));
    if (answer.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
    return c.json(answer.session, 202);
  });

  return routes;
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  getSession,
  issuePass,
  listSessions,
  readStartRequest,
  sessionOptions,
  startSession,
  stopSession,
} from '../../application/cloudSessions.js';
import type { CloudSessionPorts } from '../../application/ports.js';
import { behindCaller } from './caller.js';
import type { CallerCheck } from './caller.js';
import {
  getCloudSession,
  getCloudSessionOptions,
  listCloudSessions,
  postCloudSession,
  postCloudSessionPass,
  postCloudSessionStop,
} from './contract.js';

const NO_RUNNER = { error: 'no_runner' } as const;
const NOT_FOUND = { error: 'not_found' } as const;

/**
 * The cloud session routes, on `app`, each behind the caller check. Each hands its use case the
 * caller and never a workspace or a person from the request; the only body is `{ repository, harness }`,
 * whose shape the contract checks and whose values `readStartRequest` does. A pass is a
 * credential, so no answer of its route is kept by a cache (`no-store`), and nothing here logs it.
 *
 * The options are registered before the session by id, so `/api/cloud-sessions/options` is never
 * read as a session's id.
 */
export function cloudSessionRoutes(
  app: OpenAPIHono,
  deps: { caller: CallerCheck; ports: CloudSessionPorts },
): void {
  const { caller, ports } = deps;
  app.openapi(behindCaller(caller, getCloudSessionOptions), (c) => {
    const answer = sessionOptions(ports, c.var.caller);
    if (answer.kind === 'no_runner') return c.json(NO_RUNNER, 503);
    return c.json({ repositories: answer.repositories, harnesses: answer.harnesses }, 200);
  });

  app.openapi(behindCaller(caller, postCloudSession), async (c) => {
    const request = readStartRequest(c.req.valid('json'));
    if (!request.ok) return c.json({ error: 'invalid_request' } as const, 400);
    const answer = await startSession(ports, c.var.caller, request.value);
    switch (answer.kind) {
      case 'ok':
        return c.json(answer.session, 201);
      case 'no_runner':
        return c.json(NO_RUNNER, 503);
      case 'repository_not_offered':
      case 'harness_not_offered':
        return c.json({ error: answer.kind }, 400);
    }
  });

  app.openapi(behindCaller(caller, listCloudSessions), async (c) => c.json(await listSessions(ports, c.var.caller), 200));

  app.openapi(behindCaller(caller, getCloudSession), async (c) => {
    const answer = await getSession(ports, c.var.caller, c.req.valid('param').sessionId);
    if (answer.kind === 'not_found') return c.json(NOT_FOUND, 404);
    return c.json(answer.session, 200);
  });

  app.openapi(behindCaller(caller, postCloudSessionStop), async (c) => {
    const answer = await stopSession(ports, c.var.caller, c.req.valid('param').sessionId);
    if (answer.kind === 'not_found') return c.json(NOT_FOUND, 404);
    return c.json(answer.session, 202);
  });

  app.openapi(behindCaller(caller, postCloudSessionPass), async (c) => {
    c.header('Cache-Control', 'no-store');
    const answer = await issuePass(ports, c.var.caller, c.req.valid('param').sessionId);
    switch (answer.kind) {
      case 'ok':
        return c.json(
          { pass: answer.pass, hostUrl: answer.hostUrl, expiresAt: answer.expiresAt },
          200,
        );
      case 'not_found':
        return c.json(NOT_FOUND, 404);
      case 'no_runner':
        return c.json(NO_RUNNER, 503);
    }
  });
}

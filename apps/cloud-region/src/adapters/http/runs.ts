import type { OpenAPIHono } from '@hono/zod-openapi';
import type { FactoryStore, RunnerChannel, RunStore, TeamStore } from '../../application/ports.js';
import { answerRunApproval, listRuns as listRunsUseCase, readRun } from '../../application/runs.js';
import type { CellEnv } from './caller.js';
import { getRun, listRuns, postRunApproval } from './contract.js';

const WORKSPACE_PENDING = { error: 'workspace_pending' } as const;

/**
 * The runs routes, on `app` behind its token check: each hands its use case the caller the
 * token names, and takes no workspace from the request. A run id in the path is looked up in the
 * caller's workspace alone, and a run the caller does not see is `run_not_found`. They only read:
 * a runner records runs through the store, never here.
 */
export function runRoutes(
  app: OpenAPIHono<CellEnv>,
  teams: TeamStore,
  factories: FactoryStore,
  runs: RunStore,
  runners: Pick<RunnerChannel, 'passAnswer'>,
): void {
  app.openapi(listRuns, async (c) => {
    const query = c.req.valid('query');
    const answer = await listRunsUseCase(teams, factories, runs, c.var.caller, {
      phases: query.phase ?? [],
      triggers: query.trigger ?? [],
      factoryId: query.factoryId ?? null,
      teamId: query.teamId ?? null,
      automation: query.automation ?? null,
      mine: query.mine === 'true',
      q: query.q ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    switch (answer.kind) {
      case 'listed':
        return c.json(
          {
            runs: answer.runs,
            nextCursor: answer.nextCursor,
            counts: answer.counts,
            facets: answer.facets,
          },
          200,
        );
      case 'invalid-cursor':
        return c.json({ error: 'invalid_request' } as const, 400);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
    }
  });

  // A person's answer to a run waiting for approval: recorded and passed on to the runner, never
  // acted on here.
  app.openapi(postRunApproval, async (c) => {
    const answer = await answerRunApproval(
      teams,
      factories,
      runs,
      runners,
      c.var.caller,
      c.req.valid('param').runId,
      c.req.valid('json'),
    );
    switch (answer.kind) {
      case 'answered':
        return c.json(answer.approval, 201);
      case 'not-found':
        return c.json({ error: 'run_not_found' } as const, 404);
      case 'not-allowed':
        return c.json({ error: 'not_allowed' } as const, 403);
      case 'not-waiting':
        return c.json({ error: 'not_waiting' } as const, 409);
      case 'version-moved':
        return c.json({ error: 'version_moved' } as const, 409);
      case 'already-answered':
        return c.json({ error: 'already_answered' } as const, 409);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
    }
  });

  app.openapi(getRun, async (c) => {
    const answer = await readRun(teams, factories, runs, c.var.caller, c.req.valid('param').runId);
    switch (answer.kind) {
      case 'found':
        return c.json(
          {
            run: answer.run,
            parent: answer.parent,
            steps: answer.steps,
            request: answer.request,
            children: answer.children,
            // The orchestrator's conversation comes with cloud sessions (CON-91).
            conversation: null,
            source: answer.source,
            approval: answer.approval,
          },
          200,
        );
      case 'not-found':
        return c.json({ error: 'run_not_found' } as const, 404);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
    }
  });
}

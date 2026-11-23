import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import {
  changeFactory,
  createFactory,
  listFactories as listFactoriesUseCase,
  readFactory,
  readFactoryVersion,
  saveFactoryFiles,
} from '../../application/factories.js';
import type { FactoryStore, TeamStore } from '../../application/ports.js';
import { FACTORY_BYTES_MAX } from '../../domain/factory.js';
import type { CellEnv } from './caller.js';
import {
  getFactory,
  getFactoryVersion,
  listFactories,
  patchFactory,
  postFactory,
  postFactoryVersion,
} from './contract.js';

const WORKSPACE_PENDING = { error: 'workspace_pending' } as const;
const FACTORY_NOT_FOUND = { error: 'factory_not_found' } as const;

/**
 * The largest body a save takes: the most a factory's files hold, twice over, for the room JSON's
 * escapes take. A larger one is 413 before it is read, so no request fills the cell's memory; the
 * use case still refuses files over `FACTORY_BYTES_MAX` in a body that fits.
 */
export const SAVE_BODY_MAX = 2 * FACTORY_BYTES_MAX;

/**
 * The factories routes, on `app` behind its token check: each hands its use case the caller the
 * token names, and takes no workspace from the request. A factory id in the path is looked up in
 * the caller's workspace alone, and a factory the caller does not see is `factory_not_found`.
 */
export function factoryRoutes(
  app: OpenAPIHono<CellEnv>,
  teams: TeamStore,
  factories: FactoryStore,
): void {
  app.openapi(listFactories, async (c) => {
    const answer = await listFactoriesUseCase(teams, factories, c.var.caller);
    if (answer.kind === 'workspace-pending') return c.json(WORKSPACE_PENDING, 409);
    return c.json({ factories: answer.factories }, 200);
  });

  app.openapi(postFactory, async (c) => {
    const answer = await createFactory(teams, factories, c.var.caller, c.req.valid('json'));
    switch (answer.kind) {
      case 'created':
        return c.json(answer.factory, 201);
      case 'invalid':
        return c.json({ error: 'invalid_factory', problems: answer.problems } as const, 400);
      case 'team-not-found':
        return c.json({ error: 'team_not_found' } as const, 404);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
      case 'name-taken':
        return c.json({ error: 'name_taken' } as const, 409);
    }
  });

  app.openapi(getFactory, async (c) => {
    const answer = await readFactory(
      teams,
      factories,
      c.var.caller,
      c.req.valid('param').factoryId,
    );
    switch (answer.kind) {
      case 'found':
        return c.json({ factory: answer.factory, version: answer.version }, 200);
      case 'not-found':
        return c.json(FACTORY_NOT_FOUND, 404);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
    }
  });

  app.openapi(patchFactory, async (c) => {
    const answer = await changeFactory(
      teams,
      factories,
      c.var.caller,
      c.req.valid('param').factoryId,
      c.req.valid('json'),
    );
    switch (answer.kind) {
      case 'changed':
        return c.json(answer.factory, 200);
      case 'invalid':
        return c.json({ error: 'invalid_factory', problems: answer.problems } as const, 400);
      case 'not-found':
        return c.json(FACTORY_NOT_FOUND, 404);
      case 'team-not-found':
        return c.json({ error: 'team_not_found' } as const, 404);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
      case 'name-taken':
        return c.json({ error: 'name_taken' } as const, 409);
    }
  });

  app.openapi(getFactoryVersion, async (c) => {
    const { factoryId, version } = c.req.valid('param');
    const answer = await readFactoryVersion(
      teams,
      factories,
      c.var.caller,
      factoryId,
      Number(version),
    );
    switch (answer.kind) {
      case 'found':
        return c.json(answer.version, 200);
      case 'not-found':
        return c.json(FACTORY_NOT_FOUND, 404);
      case 'version-not-found':
        return c.json({ error: 'version_not_found' } as const, 404);
      case 'workspace-pending':
        return c.json(WORKSPACE_PENDING, 409);
    }
  });

  app.openapi(
    {
      ...postFactoryVersion,
      middleware: [
        bodyLimit({
          maxSize: SAVE_BODY_MAX,
          onError: (c) => c.json({ error: 'too_large' } as const, 413),
        }),
      ],
    },
    async (c) => {
      const answer = await saveFactoryFiles(
        teams,
        factories,
        c.var.caller,
        c.req.valid('param').factoryId,
        c.req.valid('json'),
      );
      switch (answer.kind) {
        case 'saved':
          return c.json({ version: answer.version, notices: answer.notices }, 201);
        case 'invalid':
          return c.json({ error: 'invalid_files', issues: answer.issues } as const, 400);
        case 'not-found':
          return c.json(FACTORY_NOT_FOUND, 404);
        case 'moved':
          return c.json(
            { error: 'version_moved', latestVersion: answer.latestVersion } as const,
            409,
          );
        case 'workspace-pending':
          return c.json(WORKSPACE_PENDING, 409);
      }
    },
  );
}

import { GITHUB_EVENT_TYPE } from '@consola/cloud-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { systemClock } from './adapters/clock/systemClock.js';
import type { CellEnv } from './adapters/http/caller.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import {
  type CellTokenKeys,
  cloudGlobalKeys,
  createJoseTokenVerifier,
} from './adapters/token/cellTokens.js';
import { createJoseDeliveryVerifier } from './adapters/token/outboxDeliveries.js';
import type { CellConfig } from './config.js';

/**
 * The cell, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns, and the HTTP tests build through it too, so they test the
 * wiring that runs.
 *
 * The cell checks tokens, outbox deliveries and GitHub events with `cloud-global`'s keys, fetched from
 * `config.cloudGlobalUrl`: one key set for both, so it is fetched and kept once. Only a test
 * passes `cellTokenKeys`, a key set of its own, so it needs no `cloud-global` running.
 */
export function composeCell(deps: {
  db: Database;
  config: CellConfig;
  cellTokenKeys?: CellTokenKeys;
}): { app: OpenAPIHono<CellEnv> } {
  const { db, config } = deps;
  const stores = createDrizzleStores(db);
  const keys = deps.cellTokenKeys ?? cloudGlobalKeys(config.cloudGlobalUrl);
  const app = createApp({
    region: config.region,
    health: stores.health,
    tokens: createJoseTokenVerifier(keys),
    deliveries: createJoseDeliveryVerifier(keys),
    events: createJoseDeliveryVerifier(keys, console.error, GITHUB_EVENT_TYPE),
    workspaceCopies: stores.workspaceCopies,
    gitHubEvents: stores.gitHubEvents,
    teams: stores.teams,
    factories: stores.factories,
    clock: systemClock,
  });
  return { app };
}

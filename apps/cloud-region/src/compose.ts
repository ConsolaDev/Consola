import type { Hono } from 'hono';
import { systemClock } from './adapters/clock/systemClock.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import {
  type CellTokenKeys,
  cloudGlobalKeys,
  createJoseTokenVerifier,
} from './adapters/token/cellTokens.js';
import type { CellConfig } from './config.js';

/**
 * The cell, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns, and the HTTP tests build through it too, so they test the
 * wiring that runs.
 *
 * The cell checks tokens with `cloud-global`'s keys, fetched from `config.cloudGlobalUrl`. Only
 * a test passes `cellTokenKeys`, a key set of its own, so it needs no `cloud-global` running.
 */
export function composeCell(deps: {
  db: Database;
  config: CellConfig;
  cellTokenKeys?: CellTokenKeys;
}): { app: Hono } {
  const { db, config } = deps;
  const stores = createDrizzleStores(db);
  const tokens = createJoseTokenVerifier(
    deps.cellTokenKeys ?? cloudGlobalKeys(config.cloudGlobalUrl),
  );
  const app = createApp({
    region: config.region,
    health: stores.health,
    tokens,
    clock: systemClock,
  });
  return { app };
}

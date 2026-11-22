import type { Hono } from 'hono';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import type { CellConfig } from './config.js';

/**
 * The cell, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns, and the HTTP tests build through it too, so they test the
 * wiring that runs.
 */
export function composeCell(deps: { db: Database; config: CellConfig }): { app: Hono } {
  const { db, config } = deps;
  const stores = createDrizzleStores(db);
  const app = createApp({ region: config.region, health: stores.health });
  return { app };
}

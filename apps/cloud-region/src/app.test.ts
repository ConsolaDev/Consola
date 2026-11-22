import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { composeCell } from './compose.js';
import type { CellConfig } from './config.js';

const config: CellConfig = { databaseUrl: 'pglite:memory', region: 'eu', port: 3101 };

let app: Hono;
let closeDatabase: () => Promise<void>;

beforeEach(async () => {
  const opened = openDatabase(config.databaseUrl);
  let closed = false;
  closeDatabase = async () => {
    if (closed) return;
    closed = true;
    await opened.close();
  };
  await migrateDatabase(opened.db);
  // Built the way main.ts builds it.
  ({ app } = composeCell({ db: opened.db, config }));
});

afterEach(async () => {
  await closeDatabase();
});

describe('GET /api/health', () => {
  it('answers ok, with the region this cell serves, while the database answers', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, region: 'eu' });
  });

  it('answers 503 once the database does not', async () => {
    await closeDatabase();
    const response = await app.request('/api/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, region: 'eu' });
  });

  it('names the region it is configured with', async () => {
    const opened = openDatabase('pglite:memory');
    await migrateDatabase(opened.db);
    const us = composeCell({ db: opened.db, config: { ...config, region: 'us' } });
    expect(await (await us.app.request('/api/health')).json()).toEqual({ ok: true, region: 'us' });
    await opened.close();
  });
});

describe('everything else', () => {
  it('is not found', async () => {
    expect((await app.request('/api/me')).status).toBe(404);
    expect((await app.request('/')).status).toBe(404);
  });
});

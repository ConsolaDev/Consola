import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { type CloudConfig, ConfigError, loadConfig } from './config.js';
import { migrateDatabase, openDatabase } from './db/database.js';
import { ensureOrganization } from './organization.js';

// Beside package.json, from both `src/main.ts` (tsx) and `dist/main.js` (node).
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

let config: CloudConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(['Consola Cloud cannot start:', ...error.problems.map((p) => `  ${p}`)].join('\n'));
  process.exit(1);
}

const database = openDatabase(config.databaseUrl);
await migrateDatabase(database.db);
const organization = await ensureOrganization(database.db, config.organization);
const auth = createAuth({ db: database.db, config, organizationId: organization.id });
const app = createApp({ db: database.db, auth, organization });

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(
    `Consola Cloud API on http://127.0.0.1:${info.port} (web origin ${config.publicUrl})`,
  );
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await database.close();
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  migrateDatabase,
  type OpenDatabase,
  openDatabase,
} from './adapters/persistence/database.js';
import { createOrganizationStore } from './adapters/persistence/stores.js';
import { ensureOrganization } from './application/organization.js';
import { composeApi } from './compose.js';
import { type CloudConfig, ConfigError, loadConfig } from './config.js';
import type { Organization } from './domain/organization.js';
import { describeStartupFailure } from './startupError.js';

// Beside package.json, from both `src/main.ts` (tsx) and `dist/main.js` (node).
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function cannotStart(problems: string[]): never {
  console.error(['Consola Cloud cannot start:', ...problems.map((p) => `  ${p}`)].join('\n'));
  process.exit(1);
}

let config: CloudConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  cannotStart(error.problems);
}

let database: OpenDatabase;
let organization: Organization;
try {
  database = openDatabase(config.databaseUrl);
  await migrateDatabase(database.db);
  organization = await ensureOrganization(
    createOrganizationStore(database.db),
    config.organization,
  );
} catch (error) {
  cannotStart([`The database could not be prepared: ${describeStartupFailure(error, config)}`]);
}

const { app } = composeApi({ db: database.db, config, organization });

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(
    `Consola Cloud API on http://127.0.0.1:${info.port} (web origin ${config.publicUrl})`,
  );
});

// Only a failure to start listening (the port in use, say); later server errors are not this.
function cannotListen(error: Error) {
  const reason = describeStartupFailure(error, config);
  cannotStart([`The API could not listen on 127.0.0.1:${config.port}: ${reason}`]);
}
server.once('error', cannotListen);
server.once('listening', () => server.off('error', cannotListen));

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

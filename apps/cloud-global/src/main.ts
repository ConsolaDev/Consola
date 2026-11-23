import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { GITHUB_WEBHOOK_PATH } from './adapters/http/contract.js';
import type { OutboxWorker } from './adapters/outbox/outboxWorker.js';
import {
  migrateDatabase,
  type OpenDatabase,
  openDatabase,
} from './adapters/persistence/database.js';
import { composeApi } from './compose.js';
import { type CloudConfig, ConfigError, loadConfig } from './config.js';
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
try {
  database = openDatabase(config.databaseUrl);
  await migrateDatabase(database.db);
} catch (error) {
  cannotStart([`The database could not be prepared: ${describeStartupFailure(error, config)}`]);
}

let app: OpenAPIHono;
let outbox: OutboxWorker;
try {
  ({ app, outbox } = await composeApi({ db: database.db, config }));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  cannotStart(error.problems);
}

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(
    `Consola Cloud API on http://127.0.0.1:${info.port} (web origin ${config.publicUrl})`,
  );
  // How GitHub's webhooks get here in development: through a tunnel this process does not start.
  console.log(
    config.githubWebhookSecret === null
      ? 'GitHub webhooks are off: GITHUB_WEBHOOK_SECRET is not set (README, "Receive GitHub\'s webhooks").'
      : `GitHub webhooks on ${GITHUB_WEBHOOK_PATH}. Bring them here through a tunnel with ` +
          '`pnpm --filter @consola/cloud-global webhooks:tunnel`.',
  );
  // The database is migrated, so the outbox (and any message the migrations wrote) is there to
  // deliver, and the key set a cell checks deliveries with is published. One process delivers
  // the outbox: this one.
  if (!stopping) outbox.start();
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
  // The worker ends its pass before the database it records in closes.
  const outboxStopped = outbox.stop();
  server.close(async () => {
    await outboxStopped;
    await database.close();
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

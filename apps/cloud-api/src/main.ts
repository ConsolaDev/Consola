import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { GITHUB_WEBHOOK_PATH } from './company/adapters/http/gitHubContract.js';
import { composeApi } from './compose.js';
import type { Api } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import type { CloudConfig } from './config.js';
import { migrateDatabase, openDatabase } from './persistence/database.js';
import type { OpenDatabase } from './persistence/database.js';
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
  await migrateDatabase(database);
} catch (error) {
  cannotStart([`The database could not be prepared: ${describeStartupFailure(error, config)}`]);
}

let api: Api;
try {
  api = await composeApi({ db: database, config });
} catch (error) {
  // A GitHub App key or a pass key that is not one is found here, not by the parser.
  if (!(error instanceof ConfigError)) throw error;
  cannotStart(error.problems);
}

const server = serve(
  { fetch: api.app.fetch, hostname: '127.0.0.1', port: config.port },
  (info) => {
    console.log(
      `Consola Cloud API on http://127.0.0.1:${info.port}, in ${config.region} (web origin ${config.publicUrl})`,
    );
    // How GitHub's webhooks get here in development: through a tunnel this process does not start.
    console.log(
      config.githubWebhookSecret === null
        ? 'GitHub webhooks are off: GITHUB_WEBHOOK_SECRET is not set (README, "Receive GitHub\'s webhooks").'
        : `GitHub webhooks on ${GITHUB_WEBHOOK_PATH}. Bring them here through a tunnel with ` +
            '`pnpm --filter @consola/cloud-api webhooks:tunnel`.',
    );
    if (config.runner === null) {
      console.log('No runner is configured: RUNNER_SECRET, RUNNER_WORKSPACE_ID and PASS_PRIVATE_KEY are unset.');
    }
  },
);
// The runner's socket (`GET /api/runner`) is a WebSocket upgrade, which never reaches `fetch`.
api.injectWebSocket(server);

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
  // The server waits for every open socket, a runner's included, before it closes; the database
  // goes last, once nothing is left to ask it.
  api.closeRunnerSockets();
  server.close(() => {
    void database.close();
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

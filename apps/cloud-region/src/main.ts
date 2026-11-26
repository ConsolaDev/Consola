import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import type { OpenDatabase } from './adapters/persistence/database.js';
import { composeCell } from './compose.js';
import type { Cell } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import type { CellConfig } from './config.js';
import { describeStartupFailure } from './startupError.js';

// Beside package.json, from both `src/main.ts` (tsx) and `dist/main.js` (node).
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function cannotStart(problems: string[]): never {
  console.error(
    ['The Consola Cloud cell cannot start:', ...problems.map((p) => `  ${p}`)].join('\n'),
  );
  process.exit(1);
}

let config: CellConfig;
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

let cell: Cell;
try {
  cell = await composeCell({ db: database.db, config });
} catch (error) {
  // A pass key that is no Ed25519 private key is found here, not by the parser.
  if (!(error instanceof ConfigError)) throw error;
  cannotStart(error.problems);
}

const server = serve(
  { fetch: cell.app.fetch, hostname: '127.0.0.1', port: config.port },
  (info) => {
    console.log(`Consola Cloud cell for ${config.region} on http://127.0.0.1:${info.port}`);
  },
);
// The runner's socket (`GET /api/runner`) is a WebSocket upgrade, which never reaches `fetch`.
cell.injectWebSocket(server);

// Only a failure to start listening (the port in use, say); later server errors are not this.
function cannotListen(error: Error) {
  const reason = describeStartupFailure(error, config);
  cannotStart([`The cell could not listen on 127.0.0.1:${config.port}: ${reason}`]);
}
server.once('error', cannotListen);
server.once('listening', () => server.off('error', cannotListen));

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // The server waits for every open socket, a runner's included, before it closes.
  cell.closeRunnerSockets();
  server.close(() => {
    void database.close();
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

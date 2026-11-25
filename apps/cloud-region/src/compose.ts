import { GITHUB_EVENT_TYPE } from '@consola/cloud-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { systemClock } from './adapters/clock/systemClock.js';
import type { CellEnv } from './adapters/http/caller.js';
import { createGitHubTokenMinter } from './adapters/cloudGlobal/gitHubTokens.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { randomIds } from './adapters/persistence/cloudSessions.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import { createRunnerSocket, type RunnerSocket } from './adapters/runner/runnerSocket.js';
import {
  type CellTokenKeys,
  cloudGlobalKeys,
  createJoseTokenVerifier,
} from './adapters/token/cellTokens.js';
import { createGitHubTokenRequestSigner } from './adapters/token/gitHubTokenRequests.js';
import { createJoseDeliveryVerifier } from './adapters/token/outboxDeliveries.js';
import { createPassSigner } from './adapters/token/passSigner.js';
import type { CellConfig } from './config.js';

/** The cell, assembled. */
export type Cell = {
  app: OpenAPIHono<CellEnv>;
  /** Hands the server's WebSocket upgrades to the runner's socket. `main.ts` calls it once. */
  injectWebSocket: RunnerSocket['injectWebSocket'];
  /** Closes every runner's socket, so a server that is closing is not held open by one. */
  closeRunnerSockets: () => void;
};

/**
 * The cell, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns, and the HTTP tests build through it too, so they test the
 * wiring that runs.
 *
 * The cell checks tokens, outbox deliveries and GitHub events with `cloud-global`'s keys, fetched from
 * `config.cloudGlobalUrl`: one key set for both, so it is fetched and kept once. Only a test
 * passes `cellTokenKeys`, a key set of its own, so it needs no `cloud-global` running.
 *
 * With a runner configured, the pass key is imported first (a key that is not an Ed25519 private
 * key fails here, as a `ConfigError`), and its public half goes to the runner's socket, which
 * sends it in every `session.start`. With none, the socket refuses every runner and no session
 * starts.
 *
 * With a cell key (`CELL_PRIVATE_KEY`), imported the same way, the runner's socket asks
 * `cloud-global` for its runs' GitHub tokens, at `config.cloudGlobalUrl`. With none, it refuses
 * every token request in words.
 */
export async function composeCell(deps: {
  db: Database;
  config: CellConfig;
  cellTokenKeys?: CellTokenKeys;
}): Promise<Cell> {
  const { db, config } = deps;
  const stores = createDrizzleStores(db);
  const keys = deps.cellTokenKeys ?? cloudGlobalKeys(config.cloudGlobalUrl);
  const passKey = config.runner ? await createPassSigner(config.runner.passPrivateKey) : null;
  const gitHubTokens = config.cellPrivateKey
    ? {
        signer: await createGitHubTokenRequestSigner(config.cellPrivateKey),
        minter: createGitHubTokenMinter({ baseUrl: config.cloudGlobalUrl }),
      }
    : null;
  const runner = createRunnerSocket({
    settings:
      config.runner && passKey
        ? {
            secret: config.runner.secret,
            workspaceId: config.runner.workspaceId,
            passPublicKeyPem: passKey.publicKeyPem,
          }
        : null,
    ports: {
      sessions: stores.cloudSessions,
      clock: systemClock,
      gitHubEvents: stores.gitHubEvents,
      runs: stores.runs,
      factories: stores.factories,
      gitHubTokens,
    },
  });
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
    runs: stores.runs,
    clock: systemClock,
    cloudSessions: {
      sessions: stores.cloudSessions,
      runners: runner.channel,
      ids: randomIds,
      clock: systemClock,
      passes: passKey?.signer ?? null,
    },
    runners: runner.channel,
    runner: runner.routes,
  });
  return {
    app,
    injectWebSocket: runner.injectWebSocket,
    closeRunnerSockets: runner.closeAll,
  };
}

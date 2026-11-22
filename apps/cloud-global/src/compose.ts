import type { BetterAuthPlugin } from 'better-auth';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { type CloudAuth, createAuth, currentSessionOf } from './adapters/auth/betterAuth.js';
import { createCellTokenSigner } from './adapters/cellToken/cellTokenSigner.js';
import { createGitHubApp, loadGitHubAppKey } from './adapters/github/gitHubApp.js';
import { createInstallStateSigner } from './adapters/github/installStateSigner.js';
import { createApp } from './adapters/http/app.js';
import { createCellDelivery } from './adapters/outbox/cellDelivery.js';
import { createOutboxWorker, type OutboxWorker } from './adapters/outbox/outboxWorker.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import type { CloudConfig } from './config.js';

/**
 * The service, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns once the database is migrated, then starts the outbox's
 * worker, and the HTTP tests build through it too, so they test the wiring that runs. Nothing
 * here starts the worker: building the service sends nothing to any cell. A cell token key that
 * is not a key pair, and a GitHub App key that cannot be read or is not an RSA private key, fail
 * here, as a `ConfigError`.
 */
export async function composeApi(
  deps: { db: Database; config: CloudConfig },
  extraPlugins: BetterAuthPlugin[] = [],
): Promise<{ app: OpenAPIHono; auth: CloudAuth; outbox: OutboxWorker }> {
  const { db, config } = deps;
  // A change that writes a message wakes the worker, which is built below, once the stores are.
  let messageWritten = () => {};
  const stores = createDrizzleStores(db, { messageWritten: () => messageWritten() });
  const signer = await createCellTokenSigner(config.cellTokenPrivateKey);
  const github = config.github
    ? createGitHubApp({
        config: config.github,
        privateKey: await loadGitHubAppKey(config.github.privateKeyPath),
      })
    : null;

  const outbox = createOutboxWorker({
    outbox: stores.outbox,
    signer,
    cells: createCellDelivery({ cellUrls: config.cellUrls }),
  });
  messageWritten = outbox.wake;

  const auth = createAuth(
    {
      db,
      config,
      people: stores.people,
      memberships: stores.memberships,
      sessions: stores.sessions,
    },
    extraPlugins,
  );

  const app = createApp({
    handleAuth: (request) => auth.handler(request),
    currentSession: currentSessionOf(auth),
    webOrigin: config.publicUrl,
    workspaces: stores.workspaces,
    memberships: stores.memberships,
    sessions: stores.sessions,
    cellTokens: signer,
    installations: stores.installations,
    github,
    installStates: createInstallStateSigner(config.authSecret),
    health: stores.health,
  });

  return { app, auth, outbox };
}

import type { BetterAuthPlugin } from 'better-auth';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createAuth,
  currentSessionOf,
  whoIsAskingOf,
} from './accounts/adapters/auth/betterAuth.js';
import type { CloudAuth } from './accounts/adapters/auth/betterAuth.js';
import { ACCOUNT_ROUTES, registerAccountRoutes } from './accounts/adapters/http/app.js';
import { createMembershipReader } from './accounts/adapters/persistence/membershipReader.js';
import { createDrizzleStores as createAccountStores } from './accounts/adapters/persistence/stores.js';
import { checkHealth as checkAccountsHealth } from './accounts/application/health.js';
import { systemClock } from './company/adapters/clock/systemClock.js';
import { createGitHubApp, loadGitHubAppKey } from './company/adapters/github/gitHubApp.js';
import { createInstallStateSigner } from './company/adapters/github/installStateSigner.js';
import { createWebhookSignatures } from './company/adapters/github/webhookSignatures.js';
import { COMPANY_ROUTES, registerCompanyRoutes } from './company/adapters/http/app.js';
import { GITHUB_ROUTES, registerGitHubRoutes } from './company/adapters/http/gitHub.js';
import { GITHUB_WEBHOOK_PATH } from './company/adapters/http/gitHubContract.js';
import { registerSlackRoutes, SLACK_ROUTES } from './company/adapters/http/slack.js';
import {
  registerSlackEventRoutes,
  SLACK_EVENT_ROUTES,
} from './company/adapters/http/slackEvents.js';
import { randomIds } from './company/adapters/persistence/cloudSessions.js';
import { createGitHubStores } from './company/adapters/persistence/gitHubStores.js';
import { createDrizzleStores as createCompanyStores } from './company/adapters/persistence/stores.js';
import { createRunnerSocket } from './company/adapters/runner/runnerSocket.js';
import { createSlackStores } from './company/adapters/persistence/slackStores.js';
import { createSecretSealer } from './company/adapters/sealing/secretSealer.js';
import { createSlackInstallStateSigner } from './company/adapters/slack/installStateSigner.js';
import { linkTokens } from './company/adapters/slack/linkTokens.js';
import { createSlackApi } from './company/adapters/slack/slackApi.js';
import type { RunnerSocket } from './company/adapters/runner/runnerSocket.js';
import { createPassSigner } from './company/adapters/token/passSigner.js';
import { keepingRunsInStep } from './company/application/agentRuns.js';
import { checkHealth as checkCompanyHealth } from './company/application/health.js';
import { SLACK_EVENTS_PATH_PREFIX } from './company/domain/slack.js';
import type { CloudSessionPorts } from './company/application/ports.js';
import type { CloudConfig } from './config.js';
import { createFrontDoor } from './http/frontDoor.js';
import { RING_ROUTES, registerHealthRoute } from './http/health.js';
import { workspaceOpening } from './persistence/database.js';
import type { AppDatabase } from './persistence/database.js';

/**
 * Every route the app serves through its contract, in the order `composeApi` registers them:
 * accounts', company's, GitHub's, Slack's and the ring's health check. `openapi.test.ts` checks
 * that the composed app serves these and nothing else but `OUTSIDE_THE_CONTRACT`.
 */
export const ROUTES = [
  ...ACCOUNT_ROUTES,
  ...COMPANY_ROUTES,
  ...GITHUB_ROUTES,
  ...SLACK_ROUTES,
  ...SLACK_EVENT_ROUTES,
  ...RING_ROUTES,
];

/**
 * The paths Consola's origin check does not guard (`createFrontDoor`): every path under
 * Better Auth's `/api/auth/`, whose routes check their own trusted origins (`PUBLIC_URL`), as
 * they did before the apps merged; GitHub's webhook deliveries, exactly that path; and every
 * factory's Slack events, under `SLACK_EVENTS_PATH_PREFIX`. The last two carry no cookie and no
 * Origin, and are signed instead.
 */
export const ORIGIN_EXEMPT = ['/api/auth/', GITHUB_WEBHOOK_PATH, SLACK_EVENTS_PATH_PREFIX] as const;

/** The app, assembled. */
export type Api = {
  app: OpenAPIHono;
  /** Better Auth, for a test that signs people in through its `testUtils`. */
  auth: CloudAuth;
  /** Hands the server's WebSocket upgrades to the runner's socket. `main.ts` calls it once. */
  injectWebSocket: RunnerSocket['injectWebSocket'];
  /** Closes every runner's socket, so a server that is closing is not held open by one. */
  closeRunnerSockets: () => void;
};

/**
 * The app, assembled: the one place adapters are built and handed the ports they need, on the
 * one database `main.ts` opened and migrated. The HTTP suites build through it too, so they test
 * the wiring that runs.
 *
 * The one HTTP app is the front door's (`createFrontDoor`); then accounts' routes, company's,
 * GitHub's and the health check over both parts, then the runner's socket. Each part's stores are
 * built on its own view of the database; company's routes and GitHub's learn who is asking from
 * accounts' sessions (`whoIsAskingOf`) and their role from accounts' `member`
 * (`createMembershipReader`). A workspace is made with its first team in the same transaction
 * (`workspaceOpening`).
 *
 * A GitHub App key that cannot be read or is not an RSA private key, and a pass key that is not
 * an Ed25519 private key, fail here, as a `ConfigError`. With a runner configured, the pass key's
 * public half goes to the runner's socket, which sends it in every `session.start`; with none, the
 * socket refuses every runner and no session starts.
 */
export async function composeApi(
  deps: { db: AppDatabase; config: CloudConfig },
  extraAuthPlugins: BetterAuthPlugin[] = [],
): Promise<Api> {
  const { db, config } = deps;
  const report = (line: string) => console.error(line);

  const accounts = createAccountStores(db.accounts, workspaceOpening);
  const membership = createMembershipReader(db.accounts);
  const company = createCompanyStores(db.company);
  const gitHubStores = createGitHubStores(db.company);

  const auth = createAuth(
    {
      db: db.accounts,
      config,
      people: accounts.people,
      memberships: accounts.memberships,
      sessions: accounts.sessions,
    },
    extraAuthPlugins,
  );
  const whoIsAsking = whoIsAskingOf(auth);

  const github = config.github
    ? createGitHubApp({
        config: config.github,
        privateKey: await loadGitHubAppKey(config.github.privateKeyPath),
      })
    : null;

  // Every writer of a cloud session moves an agent run's run with it (`keepingRunsInStep`).
  const sessions = keepingRunsInStep(company.cloudSessions, {
    runs: company.runs,
    clock: systemClock,
    report,
  });
  const passKey = config.runner ? await createPassSigner(config.runner.passPrivateKey) : null;
  const runner = createRunnerSocket({
    settings:
      config.runner && passKey
        ? {
            secret: config.runner.secret,
            workspaceId: config.runner.workspaceId,
            passPublicKeyPem: passKey.publicKeyPem,
          }
        : null,
    ports: { sessions, clock: systemClock },
  });
  const cloudSessions: CloudSessionPorts = {
    sessions,
    runners: runner.channel,
    ids: randomIds,
    clock: systemClock,
    passes: passKey?.signer ?? null,
  };

  const app = createFrontDoor({ publicUrl: config.publicUrl, originExempt: ORIGIN_EXEMPT });

  registerAccountRoutes(app, {
    handleAuth: (request) => auth.handler(request),
    currentSession: currentSessionOf(auth),
    workspaces: accounts.workspaces,
    memberships: accounts.memberships,
    sessions: accounts.sessions,
    region: config.region,
  });

  registerCompanyRoutes(app, {
    whoIsAsking,
    membership,
    teams: company.teams,
    factories: company.factories,
    runs: company.runs,
    cloudSessions,
  });

  registerGitHubRoutes(app, {
    whoIsAsking,
    membership,
    publicUrl: config.publicUrl,
    installations: gitHubStores.installations,
    github,
    installStates: createInstallStateSigner(config.authSecret),
    clock: systemClock,
    webhooks: {
      signatures: config.githubWebhookSecret
        ? createWebhookSignatures(config.githubWebhookSecret)
        : null,
      events: gitHubStores.events,
      // An event recorded for the first time starts the agent runs it fires, on the cloud
      // sessions' ports and the workspace's factories.
      agentRuns: { ...cloudSessions, factories: company.factories, runs: company.runs, report },
    },
  });

  // Slack is off without the key that seals its secrets.
  const slackStores = createSlackStores(db.company);
  const sealer = config.connectionSecretsKey
    ? createSecretSealer(config.connectionSecretsKey)
    : null;
  registerSlackRoutes(app, {
    whoIsAsking,
    membership,
    publicUrl: config.publicUrl,
    slackPublicUrl: config.slackPublicUrl,
    slack: sealer && {
      teams: company.teams,
      factories: company.factories,
      apps: slackStores.apps,
      links: slackStores.links,
      sealer,
      states: createSlackInstallStateSigner(config.authSecret),
      api: createSlackApi(),
      tokens: linkTokens,
      clock: systemClock,
      report,
    },
  });
  registerSlackEventRoutes(app, { log: console });

  registerHealthRoute(app, [
    () => checkAccountsHealth(accounts.health),
    () => checkCompanyHealth(company.health),
  ]);

  // No session: a runner is no person, and presents its secret instead.
  app.route('/', runner.routes);

  return {
    app,
    auth,
    injectWebSocket: runner.injectWebSocket,
    closeRunnerSockets: runner.closeAll,
  };
}

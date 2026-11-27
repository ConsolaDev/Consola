// @effect-diagnostics nodeBuiltinImport:off - It starts the cloud app and the runner on this machine.
// @effect-diagnostics globalFetch:off - It calls the cloud app's API as the web app would.
// @effect-diagnostics globalTimers:off - Its waits poll outside any Effect runtime.
// @effect-diagnostics globalDate:off - Its waits and the session it writes read the wall clock.
/**
 * A Consola cloud session end to end, with no Google, no credential and no provider: the cloud
 * app as it is built (`@consola/cloud-api`'s `dist/main.js`) on a PGlite folder of the test's own;
 * the runner command over local sandboxes (`@consola/host`'s `src/testing/replayRunner.ts`, whose
 * sandboxes run the session command over a replayed Claude); and t3's own client, connected to the
 * session's host with the pass the app signed. A person is signed in by a session the test writes
 * into the app's database, and every request carries its cookie, signed as Better Auth signs one.
 *
 * Every process runs on a machine of the test's own (`@consola/host`'s `src/testing/machine.ts`):
 * a temporary home, no CLI or API-key variable, none of the runner's secrets (an E2B key, a git
 * token) and no `CONSOLA_` setting from the developer's shell, and a `PATH` of fake CLIs before
 * `/usr/bin:/bin`. A fake records its call and exits 1, so no CLI of the developer's can run; after
 * each test every recorded call must have seen that home and no config folder.
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  cliVariablesIn,
  homeVariables,
  pathWith,
  readCalls,
  writeFakeClis,
} from '@consola/host/src/testing/machine.ts';
import { RUNNER_SECRET_VARIABLES } from '@consola/host/src/testing/localProvider.ts';
import { loadReplay, REPLAY_TITLE, sendMessage } from '@consola/host/src/testing/replay.ts';
import { connectHost } from '@consola/host/src/testing/t3Client.ts';
import { ORCHESTRATION_V2_WS_METHODS, ThreadId } from '@t3tools/contracts';
import type { OrchestrationV2ThreadStreamItem } from '@t3tools/contracts';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

const resolve = createRequire(import.meta.url).resolve;
/** The cloud app as `pnpm --filter @consola/cloud-api build` writes it (turbo's `^build` does). */
const APP_MAIN = join(dirname(resolve('@consola/cloud-api/package.json')), 'dist', 'main.js');
/** The runner command, its sandboxes local processes of a replayed session (test-only). */
const REPLAY_RUNNER = join(
  dirname(resolve('@consola/host/package.json')),
  'src',
  'testing',
  'replayRunner.ts',
);

// Stand-ins, never real credentials. The runner's secret is the app's `RUNNER_SECRET` (at least
// 32 printable characters); the API key and the git token are the runner's, which it hands a
// sandbox and scrubs from everything it says. Better Auth signs session cookies with the app's
// `BETTER_AUTH_SECRET`, and so does the test.
const RUNNER_SECRET = 'runner-secret-sprocket-0123456789abcdef';
const AUTH_SECRET = 'auth-secret-sprocket-e2e-0123456789abcdef';
const RUNNER_ID = 'r-1';
const REPOSITORY = 'sprocket/catalog-portal';
/** Acme's person, whom the test signs in. */
const PERSON = { id: 'person-acme-1', name: 'Ada Acme', email: 'ada@acme.test' } as const;
/** The workspace the person makes, the one the runner serves. */
const WORKSPACE = { name: 'Sprocket', slug: 'sprocket' } as const;
/** The web app's origin (`PUBLIC_URL`), which every change must come from, as a browser's does. */
const WEB_ORIGIN = 'http://localhost:5175';
/**
 * Better Auth's session cookie: its default name, with no `__Secure-` prefix since `PUBLIC_URL`
 * is http (`createCookieGetter` in better-auth's `cookies/index.mjs`).
 */
const SESSION_COOKIE = 'better-auth.session_token';
/** The workspace the page shows, which every company request carries (the app's `caller.ts`). */
const WORKSPACE_HEADER = 'x-consola-workspace';
/** As long as Better Auth's own sessions last (seven days), from when the test writes one. */
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** What the `simple` fixture's Claude answers (`claude_transcript.ndjson`). */
const ASSISTANT_TEXT = 'fixture simple ok';

/** Starting node and loading t3 takes seconds; under load, far more. */
const WAIT_MS = 90_000;
const TEST_TIMEOUT_MS = 240_000;
/** How long the app is given to stop on SIGTERM before it is killed. */
const APP_STOP_GRACE_MS = 10_000;

type Exited = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A process the test started: what it printed, and how it ended. */
type Started = {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<Exited>;
};

/** The cloud app, started and listening. */
type App = Started & { readonly url: string; readonly port: number };

/** The app's answer to a request: its status and its JSON body. */
type Answer<A> = { readonly status: number; readonly body: A };

/** A cloud session as the app answers it (`CloudSession` in its contract). */
type CloudSession = {
  readonly id: string;
  readonly status: 'starting' | 'running' | 'stopped' | 'failed';
  readonly hostUrl: string | null;
  readonly title: string | null;
  readonly error: string | null;
  readonly errorCode: string | null;
};

type CloudSessionPass = { readonly pass: string; readonly hostUrl: string };

/** One test's machine: its folder, its home, the fake CLIs' record and the environment. */
type Machine = {
  readonly root: string;
  readonly home: string;
  readonly record: string;
  readonly env: NodeJS.ProcessEnv;
  /** The app's PGlite folder. */
  readonly database: string;
};

/** The person signed in: their session's token, and the workspace they made, active in it. */
type SignedIn = { readonly token: string; readonly workspaceId: string };

/** Everything one test runs on: its machine, the person signed in, the app and the runner. */
type Cloud = {
  readonly machine: Machine;
  readonly signedIn: SignedIn;
  readonly passPrivateKey: JsonWebKey;
  readonly app: App;
  readonly runner: Started;
  /** Every process a sandbox ran, for the teardown should a test end early. */
  readonly sandboxPids: number[];
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** `probe`'s first answer that is not undefined, asked every 100 ms until `timeoutMs`. */
const waitFor = async <A>(
  probe: () => A | undefined | Promise<A | undefined>,
  what: string,
  timeoutMs: number = WAIT_MS,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await probe();
    if (answer !== undefined) return answer;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

/** Starts `node <script> <args>` with `env`, collecting what it prints. */
const startNode = (script: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
  // The machine's PATH holds only fake CLIs and /usr/bin:/bin, so node is named by its path.
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<Exited>((done) =>
    child.on('exit', (code, signal) => done({ code, signal })),
  );
  const started: Started = { child, stdout: () => stdout, stderr: () => stderr, exited };
  return started;
};

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every process below `pid`: a runner's sandboxes are its children. */
const descendantsOf = (pid: number): number[] => {
  const table = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isFinite));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [child, ppid] of table) {
      if (ppid === parent && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
};

/** A port nothing listens on just now, for the app (its `PORT` takes no 0). */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createNetServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

let machine: Machine | undefined;
/** Every app process the test started, those that only prepared its database included. */
let apps: Started[] = [];
let cloud: Cloud | undefined;

const current = (): Cloud => {
  if (cloud === undefined) throw new Error('no cloud is running');
  return cloud;
};

/**
 * The session cookie's value for `token`, signed as Better Auth signs it: better-call's
 * `signCookieValue` (its `crypto.mjs`), which `setSignedCookie` runs when Better Auth sets
 * `better-auth.session_token` (`setSessionCookie`): the token, a dot and the base64 HMAC-SHA256
 * of the token under the secret, URI-encoded. `getSignedCookie` checks it the same way.
 */
const signedCookie = (token: string) =>
  encodeURIComponent(
    `${token}.${createHmac('sha256', AUTH_SECRET).update(token).digest('base64')}`,
  );

/** What the web app's page sends: the session cookie, its origin, and the workspace it shows. */
const fromPage = (token: string, workspaceId?: string): Headers => {
  const headers = new Headers({
    cookie: `${SESSION_COOKIE}=${signedCookie(token)}`,
    origin: WEB_ORIGIN,
  });
  if (workspaceId !== undefined) headers.set(WORKSPACE_HEADER, workspaceId);
  return headers;
};

/** The runner the app admits: the one workspace it serves, and the key passes are signed with. */
type AppRunner = { readonly workspaceId: string; readonly passPrivateKey: JsonWebKey };

/**
 * Every variable the app reads (`config.ts`), set here: `main.ts` loads `apps/cloud-api/.env`
 * for any left unset, and a worktree's is the developer's own. An empty one is unset to the app,
 * yet set to `.env`'s loader, so it stays empty: no GitHub App, no webhook secret, and with
 * `runner` null no runner.
 */
const appEnvironment = (
  { env, database }: Machine,
  port: number,
  runner: AppRunner | null,
): NodeJS.ProcessEnv => ({
  ...env,
  DATABASE_URL: `pglite:${database}`,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  // Better Auth signs with this list's first secret, when it has one, before `BETTER_AUTH_SECRET`.
  BETTER_AUTH_SECRETS: '',
  PUBLIC_URL: WEB_ORIGIN,
  GOOGLE_CLIENT_ID: 'sprocket-e2e.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'sprocket-e2e-google-client-secret',
  REGION: 'eu',
  PORT: String(port),
  GITHUB_APP_CLIENT_ID: '',
  GITHUB_APP_CLIENT_SECRET: '',
  GITHUB_APP_SLUG: '',
  GITHUB_APP_PRIVATE_KEY_PATH: '',
  GITHUB_WEBHOOK_SECRET: '',
  RUNNER_SECRET: runner === null ? '' : RUNNER_SECRET,
  RUNNER_WORKSPACE_ID: runner === null ? '' : runner.workspaceId,
  PASS_PRIVATE_KEY: runner === null ? '' : JSON.stringify(runner.passPrivateKey),
});

/** Starts the app on a free port, once it listens. */
const startApp = async (on: Machine, runner: AppRunner | null): Promise<App> => {
  const port = await freePort();
  const started = startNode(APP_MAIN, [], appEnvironment(on, port, runner));
  apps.push(started);
  await waitFor(() => {
    if (!isRunning(started.child)) {
      throw new Error(`the app exited; its stderr:\n${started.stderr()}`);
    }
    return started.stdout().includes(`on http://127.0.0.1:${port}`) ? true : undefined;
  }, 'the app to listen');
  return { ...started, url: `http://127.0.0.1:${port}`, port };
};

/** Stops the app as `main.ts` has it on SIGTERM, killing it once the grace is over. */
const stopApp = async (app: Started): Promise<Exited> => {
  if (isRunning(app.child)) app.child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const graceOver = new Promise<'grace over'>((done) => {
    timer = setTimeout(() => done('grace over'), APP_STOP_GRACE_MS);
  });
  const ended = await Promise.race([app.exited, graceOver]);
  clearTimeout(timer);
  if (ended !== 'grace over') return ended;
  app.child.kill('SIGKILL');
  return app.exited;
};

/** Stops an app that only prepared the database: it must stop on its own, closing its folder. */
const expectStops = async (app: Started) => {
  expect(
    await stopApp(app),
    `the app did not stop on SIGTERM; its stderr:\n${app.stderr()}`,
  ).toEqual({
    code: 0,
    signal: null,
  });
};

/**
 * Writes Acme's person (`user`) and a session of theirs (`session`), with no workspace active,
 * into the app's migrated folder, with the app stopped (PGlite takes one process per folder): the
 * rows Better Auth's own sign-in writes once Google answered. The session's token is random.
 */
const writePerson = async (database: string): Promise<string> => {
  const token = randomBytes(24).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const db = new PGlite(database);
  try {
    // The columns are `timestamp` with no time zone, which Drizzle reads as UTC: an ISO time's
    // `Z` is dropped, and its UTC wall time kept.
    await db.query(
      'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, $4, $4)',
      [PERSON.id, PERSON.name, PERSON.email, now.toISOString()],
    );
    await db.query(
      'insert into "session" (id, token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, $4, $5, $5)',
      [randomUUID(), token, PERSON.id, expiresAt.toISOString(), now.toISOString()],
    );
  } finally {
    await db.close();
  }
  return token;
};

/**
 * Signs Acme's person in without Google. The app, started once with no runner, makes and migrates
 * its PGlite folder; with it stopped, the test writes the person and their session
 * (`writePerson`). Started again, the app makes their workspace through `POST /api/workspaces`,
 * as the web app asks, so it is born whole (its owner's `member` row, its first team) and is
 * the session's active workspace.
 */
const signIn = async (on: Machine): Promise<SignedIn> => {
  await expectStops(await startApp(on, null));
  const token = await writePerson(on.database);
  const app = await startApp(on, null);
  const headers = fromPage(token);
  headers.set('content-type', 'application/json');
  const made = await fetch(`${app.url}/api/workspaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify(WORKSPACE),
  });
  const workspace = (await made.json()) as { readonly id: string; readonly slug: string };
  expect(made.status).toBe(201);
  expect(workspace.slug).toBe(WORKSPACE.slug);
  const me = await fetch(`${app.url}/api/me`, { headers: fromPage(token) });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({
    user: { id: PERSON.id },
    workspace: { id: workspace.id, role: 'owner', region: 'eu' },
  });
  await expectStops(app);
  return { token, workspaceId: workspace.id };
};

/** Asks the app's API as the person signed in, from the page of their workspace. */
const askApp = async <A>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer<A>> => {
  const { app, signedIn } = current();
  const headers = fromPage(signedIn.token, signedIn.workspaceId);
  const request: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    request.body = JSON.stringify(body);
  }
  const response = await fetch(`${app.url}${path}`, request);
  return { status: response.status, body: (await response.json()) as A };
};

const readSession = async (sessionId: string): Promise<CloudSession> => {
  const answer = await askApp<CloudSession>('GET', `/api/cloud-sessions/${sessionId}`);
  expect(answer.status).toBe(200);
  return answer.body;
};

/** Starts a Claude session on the runner's repository; it is `starting` until the runner says. */
const startSession = async (): Promise<CloudSession> => {
  const answer = await askApp<CloudSession>('POST', '/api/cloud-sessions', {
    repository: REPOSITORY,
    harness: 'claude',
  });
  expect(answer.status).toBe(201);
  expect(answer.body).toMatchObject({
    status: 'starting',
    repository: REPOSITORY,
    harness: 'claude',
    personId: PERSON.id,
    workspaceId: current().signedIn.workspaceId,
    runnerId: RUNNER_ID,
  });
  return answer.body;
};

/** The session once its status is no longer `from`. */
const sessionOnceNot = (sessionId: string, from: CloudSession['status']) =>
  waitFor(async () => {
    const session = await readSession(sessionId);
    return session.status === from ? undefined : session;
  }, `session ${sessionId} to leave ${from}`);

/** The sandbox processes the runner runs just now, kept for the teardown too. */
const sandboxProcesses = (): number[] => {
  const running = current();
  const pids = descendantsOf(running.runner.child.pid ?? -1);
  running.sandboxPids.push(...pids);
  return pids;
};

const noneAlive = (pids: readonly number[], what: string) =>
  waitFor(() => (pids.every((pid) => !isAlive(pid)) ? true : undefined), what);

/** The answer's text, when `item` carries the `simple` fixture's complete answer. */
const answerIn = (item: OrchestrationV2ThreadStreamItem): string | undefined => {
  if (item.kind === 'snapshot') {
    for (const turnItem of item.projection.turnItems) {
      if (turnItem.type === 'assistant_message' && turnItem.text.includes(ASSISTANT_TEXT)) {
        return turnItem.text;
      }
    }
    return undefined;
  }
  if (
    item.kind === 'event' &&
    item.event.type === 'turn-item.updated' &&
    item.event.payload.type === 'assistant_message' &&
    item.event.payload.text.includes(ASSISTANT_TEXT)
  ) {
    return item.event.payload.text;
  }
  return undefined;
};

/**
 * Sends the `simple` fixture's first message to the session's host as t3's chat sends it, through
 * t3's own client (a socket ticket for the pass, then the socket), and answers with the reply's
 * text: from the thread's snapshot or its live events, whichever holds it first.
 */
const chat = Effect.fn('chat')(function* (hostPort: number, pass: string, sessionId: string) {
  const { variant, text } = yield* loadReplay('simple');
  const { client } = yield* connectHost(hostPort, pass);
  const answered = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId: ThreadId.make(sessionId),
  }).pipe(
    Stream.map(answerIn),
    Stream.filter((answer): answer is string => answer !== undefined),
    Stream.runHead,
    Effect.forkScoped,
  );
  yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
    sendMessage({ sessionId, harness: 'claude', cwd: '' }, text, variant.modelSelection),
  );
  const answer = yield* Fiber.join(answered).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(WAIT_MS),
      orElse: () => Effect.die(new Error('the host sent no answer in time')),
    }),
  );
  return Option.getOrElse(answer, () => '');
}, Effect.scoped);

/** Every secret the test made: none may show in what any app process or the runner printed. */
const expectNothingSecretPrinted = (passes: readonly string[]) => {
  const { runner, passPrivateKey, signedIn } = current();
  const printed = [
    ...apps.flatMap((app) => [app.stdout(), app.stderr()]),
    runner.stdout(),
    runner.stderr(),
  ].join('\n');
  const secrets = [RUNNER_SECRET, AUTH_SECRET, String(passPrivateKey.d), signedIn.token, ...passes];
  for (const secret of secrets) {
    expect(printed).not.toContain(secret);
  }
  // The runner's stdout is empty: everything it says goes to the app, its log to stderr.
  expect(runner.stdout()).toBe('');
};

beforeEach(async () => {
  if (!existsSync(APP_MAIN)) {
    throw new Error(
      `${APP_MAIN} is not built: run \`pnpm exec turbo run test --filter=@consola/cloud-session-e2e\`, which builds it first.`,
    );
  }
  // The machine: a home of its own, and fake CLIs first on the PATH.
  const root = mkdtempSync(join(tmpdir(), 'consola-cloud-session-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const record = join(root, 'cli-calls.tsv');
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(record, '');
  writeFakeClis(bin, record);
  // No CLI's variable, none of the runner's secrets and no Consola setting comes from the
  // developer's shell: the runner gets only the stand-ins the test gives it below.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const consolaVariables = Object.keys(env).filter((name) => name.startsWith('CONSOLA_'));
  for (const name of [...cliVariablesIn(env), ...RUNNER_SECRET_VARIABLES, ...consolaVariables]) {
    delete env[name];
  }
  Object.assign(env, homeVariables(home), { PATH: pathWith(bin) });
  const on: Machine = { root, home, record, env, database: join(root, 'cloud-db') };
  machine = on;

  const signedIn = await signIn(on);
  // The app's own key for passes (`pass-key:generate` makes one the same way).
  const passPrivateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const app = await startApp(on, { workspaceId: signedIn.workspaceId, passPrivateKey });
  const runner = startNode(
    REPLAY_RUNNER,
    ['runner', '--cell-url', `ws://127.0.0.1:${app.port}/api/runner`, '--runner-id', RUNNER_ID],
    {
      ...env,
      CONSOLA_RUNNER_SECRET: RUNNER_SECRET,
      CONSOLA_RUNNER_REPOSITORIES: REPOSITORY,
      ANTHROPIC_API_KEY: 'test',
      GIT_TOKEN: 'test',
    },
  );
  cloud = { machine: on, signedIn, passPrivateKey, app, runner, sandboxPids: [] };

  // The runner has said hello once the app offers its repository and harness to the person.
  const options = await waitFor(async () => {
    if (!isRunning(runner.child)) {
      throw new Error(`the runner exited; its stderr:\n${runner.stderr()}`);
    }
    const answer = await askApp<unknown>('GET', '/api/cloud-sessions/options');
    return answer.status === 200 ? answer.body : undefined;
  }, 'the runner to connect');
  expect(options).toEqual({ repositories: [REPOSITORY], harnesses: ['claude'] });
}, WAIT_MS * 2);

afterEach(async () => {
  const ended = cloud;
  const endedMachine = machine;
  const endedApps = apps;
  cloud = undefined;
  machine = undefined;
  apps = [];
  // Nothing outlives the test: the runner's sandboxes, the runner, then every app process.
  if (ended !== undefined) {
    const { runner, sandboxPids } = ended;
    const left = isRunning(runner.child) ? descendantsOf(runner.child.pid ?? -1) : [];
    for (const pid of [...sandboxPids, ...left]) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    if (isRunning(runner.child)) runner.child.kill('SIGKILL');
    await runner.exited;
  }
  for (const app of endedApps) await stopApp(app);
  if (endedMachine === undefined) return;
  const calls = readCalls(endedMachine.record);
  rmSync(endedMachine.root, { recursive: true, force: true });
  for (const call of calls) {
    expect(call).toMatchObject({ home: endedMachine.home, claudeConfigDir: '', codexHome: '' });
  }
}, APP_STOP_GRACE_MS * 3);

describe('a cloud session', () => {
  it(
    'starts on the runner, answers through a pass, and stops with no sandbox process left',
    async () => {
      const { id } = await startSession();
      const running = await sessionOnceNot(id, 'starting');
      expect(running).toMatchObject({ status: 'running', error: null, errorCode: null });
      const hostUrl = String(running.hostUrl);
      expect(hostUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const sandbox = sandboxProcesses();
      expect(sandbox.length).toBeGreaterThan(0);

      const issued = await askApp<CloudSessionPass>('POST', `/api/cloud-sessions/${id}/pass`);
      expect(issued.status).toBe(200);
      expect(issued.body.hostUrl).toBe(hostUrl);
      const { pass } = issued.body;
      const answer = await Effect.runPromise(chat(Number(new URL(hostUrl).port), pass, id));
      expect(answer).toContain(ASSISTANT_TEXT);
      // The host titled the thread, and the title reached the app through the runner.
      await waitFor(
        async () => ((await readSession(id)).title === REPLAY_TITLE ? true : undefined),
        "the thread's title to reach the app",
      );

      const stopped = await askApp<CloudSession>('POST', `/api/cloud-sessions/${id}/stop`);
      expect(stopped.status).toBe(202);
      expect(stopped.body).toMatchObject({ status: 'stopped' });
      // The app told the runner, which stopped the sandbox: its replayed host is gone.
      await noneAlive(sandbox, "the sandbox's processes to end");
      expect(await readSession(id)).toMatchObject({
        status: 'stopped',
        error: null,
        errorCode: null,
      });
      expect(isRunning(current().runner.child)).toBe(true);
      expectNothingSecretPrinted([pass]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is held stopped once its runner stops on SIGTERM while it runs',
    async () => {
      const { id } = await startSession();
      expect(await sessionOnceNot(id, 'starting')).toMatchObject({ status: 'running' });
      const sandbox = sandboxProcesses();
      expect(sandbox.length).toBeGreaterThan(0);

      const { runner } = current();
      runner.child.kill('SIGTERM');
      // The runner says each session's end on its socket, stops its sandboxes, then closes.
      expect(await runner.exited).toEqual({ code: 0, signal: null });
      await noneAlive(sandbox, "the sandbox's processes to end");
      // The app kept the end the runner said before it closed: not running, not failed.
      expect(await sessionOnceNot(id, 'running')).toMatchObject({
        status: 'stopped',
        error: null,
        errorCode: null,
      });
      expectNothingSecretPrinted([]);
    },
    TEST_TIMEOUT_MS,
  );
});

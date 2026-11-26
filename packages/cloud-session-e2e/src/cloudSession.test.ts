// @effect-diagnostics nodeBuiltinImport:off - It starts the cell, the runner and a key server on this machine.
// @effect-diagnostics globalFetch:off - It calls the cell's API as the web app would.
// @effect-diagnostics globalTimers:off - Its waits poll outside any Effect runtime.
// @effect-diagnostics globalDate:off - Its waits and its tokens read the wall clock.
/**
 * A Consola cloud session end to end, with no credential and no provider: the cell as it is built
 * (`@consola/cloud-region`'s `dist/main.js`), trusting a key set served here as `cloud-global`
 * serves its own; the runner command over local sandboxes (`@consola/host`'s
 * `src/testing/replayRunner.ts`, whose sandboxes run the session command over a replayed Claude);
 * and t3's own client, connected to the session's host with the pass the cell signed. A person's
 * requests carry a cell token signed here as `cloud-global` signs one.
 *
 * Every process runs on a machine of the test's own (`@consola/host`'s `src/testing/machine.ts`):
 * a temporary home, no CLI or API-key variable, none of the runner's secrets (an E2B key, a git
 * token) and no `CONSOLA_` setting from the developer's shell, and a `PATH` of fake CLIs before
 * `/usr/bin:/bin`. A fake records its call and exits 1, so no CLI of the developer's can run; after
 * each test every recorded call must have seen that home and no config folder.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  cellTokenClaims,
} from '@consola/cloud-contract';
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
import { calculateJwkThumbprint, exportJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  descendantsOf,
  freePort,
  isAlive,
  isRunning,
  noneAlive,
  portOf,
  type Started,
  sleep,
  startNode,
  WAIT_MS,
  waitFor,
} from './processes.ts';

const resolve = createRequire(import.meta.url).resolve;
/** The cell as `pnpm --filter @consola/cloud-region build` writes it (turbo's `^build` does). */
const CELL_MAIN = join(dirname(resolve('@consola/cloud-region/package.json')), 'dist', 'main.js');
/** The runner command, its sandboxes local processes of a replayed session (test-only). */
const REPLAY_RUNNER = join(
  dirname(resolve('@consola/host/package.json')),
  'src',
  'testing',
  'replayRunner.ts',
);

// Stand-ins, never real credentials. The runner's secret is the cell's `RUNNER_SECRET` (at least
// 32 printable characters); the API key and the git token are the runner's, which it hands a
// sandbox and scrubs from everything it says.
const RUNNER_SECRET = 'runner-secret-sprocket-0123456789abcdef';
const RUNNER_ID = 'r-1';
const REPOSITORY = 'sprocket/catalog-portal';
const WORKSPACE_ID = 'workspace-sprocket';
const PERSON_ID = 'person-acme-1';
/** What the `simple` fixture's Claude answers (`claude_transcript.ndjson`). */
const ASSISTANT_TEXT = 'fixture simple ok';

const TEST_TIMEOUT_MS = 240_000;
/** How long the teardown gives the cell to stop on SIGTERM before it kills it. */
const CELL_STOP_GRACE_MS = 10_000;

/** The cell's answer to a request: its status and its JSON body. */
type Answer<A> = { readonly status: number; readonly body: A };

/** A cloud session as the cell answers it (`CloudSession` in its contract). */
type CloudSession = {
  readonly id: string;
  readonly status: 'starting' | 'running' | 'stopped' | 'failed';
  readonly hostUrl: string | null;
  readonly title: string | null;
  readonly error: string | null;
  readonly errorCode: string | null;
};

type CloudSessionPass = { readonly pass: string; readonly hostUrl: string };

/** Everything one test runs on: its machine, the key server, the cell and the runner. */
type Cloud = {
  readonly root: string;
  readonly home: string;
  readonly record: string;
  readonly env: NodeJS.ProcessEnv;
  readonly keys: Server;
  readonly signingKey: KeyObject;
  readonly kid: string;
  readonly passPrivateKey: JWK;
  readonly cellUrl: string;
  readonly cell: Started;
  readonly runner: Started;
  /** Every process a sandbox ran, for the teardown should a test end early. */
  readonly sandboxPids: number[];
};

/** `cloud-global`'s key route, on a port of its own, publishing `jwk` alone. */
const serveKeys = (jwk: JWK) =>
  new Promise<Server>((done) => {
    const server = createHttpServer((request, response) => {
      const found = request.method === 'GET' && request.url === CELL_TOKEN_KEYS_PATH;
      response
        .writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(found ? { keys: [jwk] } : {}));
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });

let cloud: Cloud | undefined;

const current = (): Cloud => {
  if (cloud === undefined) throw new Error('no cloud is running');
  return cloud;
};

/** A cell token for Acme's person in Sprocket's workspace, signed as `cloud-global` signs one. */
const cellToken = ({ signingKey, kid }: Cloud) =>
  new SignJWT({
    ...cellTokenClaims({
      personId: PERSON_ID,
      workspaceId: WORKSPACE_ID,
      role: 'member',
      region: 'eu',
      issuedAt: Math.floor(Date.now() / 1000),
    }),
  })
    .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid })
    .sign(signingKey);

/** Asks the cell's API as a person in the workspace, with a token of their own. */
const askCell = async <A>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer<A>> => {
  const running = current();
  const response = await fetch(`${running.cellUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await cellToken(running)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as A };
};

const readSession = async (sessionId: string): Promise<CloudSession> => {
  const answer = await askCell<CloudSession>('GET', `/api/cloud-sessions/${sessionId}`);
  expect(answer.status).toBe(200);
  return answer.body;
};

/** Starts a Claude session on the runner's repository; it is `starting` until the runner says. */
const startSession = async (): Promise<CloudSession> => {
  const answer = await askCell<CloudSession>('POST', '/api/cloud-sessions', {
    repository: REPOSITORY,
    harness: 'claude',
  });
  expect(answer.status).toBe(201);
  expect(answer.body).toMatchObject({
    status: 'starting',
    repository: REPOSITORY,
    harness: 'claude',
    personId: PERSON_ID,
    workspaceId: WORKSPACE_ID,
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

/** Every secret the test made: none may show in what the cell or the runner printed. */
const expectNothingSecretPrinted = (passes: readonly string[]) => {
  const { cell, runner, passPrivateKey } = current();
  const printed = [cell.stdout(), cell.stderr(), runner.stdout(), runner.stderr()].join('\n');
  for (const secret of [RUNNER_SECRET, String(passPrivateKey.d), ...passes]) {
    expect(printed).not.toContain(secret);
  }
  // The runner's stdout is empty: everything it says goes to the cell, its log to stderr.
  expect(runner.stdout()).toBe('');
};

beforeEach(async () => {
  if (!existsSync(CELL_MAIN)) {
    throw new Error(
      `${CELL_MAIN} is not built: run \`pnpm exec turbo run test --filter=@consola/cloud-session-e2e\`, which builds it first.`,
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

  // `cloud-global`'s signing key, published where the cell fetches it.
  const { privateKey: signingKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const keys = await serveKeys({ ...jwk, kid, alg: CELL_TOKEN_ALGORITHM, use: 'sig' });
  // The cell's own key for passes (`pass-key:generate` makes one the same way).
  const passPrivateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

  // Every variable the cell reads is set here: `main.ts` loads `apps/cloud-region/.env` for any
  // left unset, and a worktree's is the developer's own.
  const port = await freePort();
  const cell = startNode(CELL_MAIN, [], {
    ...env,
    DATABASE_URL: 'pglite:memory',
    REGION: 'eu',
    PORT: String(port),
    CLOUD_GLOBAL_URL: `http://127.0.0.1:${portOf(keys)}`,
    RUNNER_SECRET,
    RUNNER_WORKSPACE_ID: WORKSPACE_ID,
    PASS_PRIVATE_KEY: JSON.stringify(passPrivateKey),
  });
  const runner = startNode(
    REPLAY_RUNNER,
    ['runner', '--cell-url', `ws://127.0.0.1:${port}/api/runner`, '--runner-id', RUNNER_ID],
    {
      ...env,
      CONSOLA_RUNNER_SECRET: RUNNER_SECRET,
      CONSOLA_RUNNER_REPOSITORIES: REPOSITORY,
      ANTHROPIC_API_KEY: 'test',
      GIT_TOKEN: 'test',
    },
  );
  cloud = {
    root,
    home,
    record,
    env,
    keys,
    signingKey,
    kid,
    passPrivateKey,
    cellUrl: `http://127.0.0.1:${port}`,
    cell,
    runner,
    sandboxPids: [],
  };

  await waitFor(() => {
    if (!isRunning(cell.child)) throw new Error(`the cell exited; its stderr:\n${cell.stderr()}`);
    return cell.stdout().includes(`on http://127.0.0.1:${port}`) ? true : undefined;
  }, 'the cell to listen');
  // The runner has said hello once the cell offers its repository and harness to a person.
  const options = await waitFor(async () => {
    if (!isRunning(runner.child)) {
      throw new Error(`the runner exited; its stderr:\n${runner.stderr()}`);
    }
    const answer = await askCell<unknown>('GET', '/api/cloud-sessions/options');
    return answer.status === 200 ? answer.body : undefined;
  }, 'the runner to connect');
  expect(options).toEqual({ repositories: [REPOSITORY], harnesses: ['claude'] });
}, WAIT_MS * 2);

afterEach(async () => {
  const ended = cloud;
  cloud = undefined;
  if (ended === undefined) return;
  // Nothing outlives the test: the runner's sandboxes, the runner, then the cell.
  const left = isRunning(ended.runner.child) ? descendantsOf(ended.runner.child.pid ?? -1) : [];
  for (const pid of [...ended.sandboxPids, ...left]) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  if (isRunning(ended.runner.child)) ended.runner.child.kill('SIGKILL');
  await ended.runner.exited;
  // The cell stops as `main.ts` has it on SIGTERM; one that has not within the grace is killed.
  if (isRunning(ended.cell.child)) ended.cell.child.kill('SIGTERM');
  const graceOver = sleep(CELL_STOP_GRACE_MS).then(() => 'grace over' as const);
  if ((await Promise.race([ended.cell.exited, graceOver])) === 'grace over') {
    ended.cell.child.kill('SIGKILL');
    await ended.cell.exited;
  }
  ended.keys.closeAllConnections();
  await new Promise<void>((done) => ended.keys.close(() => done()));
  const calls = readCalls(ended.record);
  rmSync(ended.root, { recursive: true, force: true });
  for (const call of calls) {
    expect(call).toMatchObject({ home: ended.home, claudeConfigDir: '', codexHome: '' });
  }
}, CELL_STOP_GRACE_MS * 3);

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

      const issued = await askCell<CloudSessionPass>('POST', `/api/cloud-sessions/${id}/pass`);
      expect(issued.status).toBe(200);
      expect(issued.body.hostUrl).toBe(hostUrl);
      const { pass } = issued.body;
      const answer = await Effect.runPromise(chat(Number(new URL(hostUrl).port), pass, id));
      expect(answer).toContain(ASSISTANT_TEXT);
      // The host titled the thread, and the title reached the cell through the runner.
      await waitFor(
        async () => ((await readSession(id)).title === REPLAY_TITLE ? true : undefined),
        "the thread's title to reach the cell",
      );

      const stopped = await askCell<CloudSession>('POST', `/api/cloud-sessions/${id}/stop`);
      expect(stopped.status).toBe(202);
      expect(stopped.body).toMatchObject({ status: 'stopped' });
      // The cell told the runner, which stopped the sandbox: its replayed host is gone.
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
      // The cell kept the end the runner said before it closed: not running, not failed.
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

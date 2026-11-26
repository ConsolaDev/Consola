// @effect-diagnostics nodeBuiltinImport:off - It starts the cell, the runner and a stand-in for cloud-global on this machine.
// @effect-diagnostics globalFetch:off - It calls the cell's API as the web app and cloud-global would.
// @effect-diagnostics globalTimers:off - Its waits poll outside any Effect runtime.
// @effect-diagnostics globalDate:off - Its tokens, deliveries and minted tokens read the wall clock.
/**
 * A pull request's triggered run end to end (stage 1 of the cloud's automations, CON-116), with no
 * credential and no provider: the cell as it is built, trusting a stand-in for `cloud-global` that
 * publishes its keys and mints GitHub tokens for the cell's signed requests; the runner command
 * over local sandboxes (`@consola/host`'s `src/testing/replayRunner.ts`), whose agent step's host
 * is a replayed Claude that takes the engine's prompt as the fixture's own (`anyPrompt`) and
 * whose step tools are called as the reviewer would call them, and whose command step runs a real
 * `bash` with a stub `gh` first on its `PATH`.
 *
 * The test saves factory-spec's Review pull requests files through the cell as the web app does,
 * delivers a signed `pull_request` `opened` event as `cloud-global` passes one on, approves (or
 * dismisses) the run through the cell's API, and reads what the run recorded there.
 *
 * Every process runs on a machine of the test's own (`@consola/host`'s `src/testing/machine.ts`),
 * as `cloudSession.test.ts` sets it up.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  cellTokenClaims,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  GITHUB_EVENT_TYPE,
  GITHUB_TOKEN_REQUEST_TYPE,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  readGitHubTokenRequest,
} from '@consola/cloud-contract';
import type { GitHubTokenRequest } from '@consola/cloud-contract';
import {
  cliVariablesIn,
  homeVariables,
  pathWith,
  readCalls,
  writeFakeClis,
} from '@consola/host/src/testing/machine.ts';
import { RUNNER_SECRET_VARIABLES } from '@consola/host/src/testing/localProvider.ts';
import type { LocalStepsOptions } from '@consola/host/src/testing/localProvider.ts';
import { CompactSign, calculateJwkThumbprint, compactVerify, exportJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  descendantsOf,
  freePort,
  isAlive,
  isRunning,
  portOf,
  sleep,
  startNode,
  WAIT_MS,
  waitFor,
} from './processes.ts';
import type { Started } from './processes.ts';

const resolve = createRequire(import.meta.url).resolve;
/** The cell as `pnpm --filter @consola/cloud-region build` writes it (turbo's `^build` does). */
const CELL_MAIN = join(dirname(resolve('@consola/cloud-region/package.json')), 'dist', 'main.js');
/** The runner command, its sandboxes local processes (test-only). */
const REPLAY_RUNNER = join(
  dirname(resolve('@consola/host/package.json')),
  'src',
  'testing',
  'replayRunner.ts',
);
/** The canonical Review pull requests files: the factory a person saves. */
const REVIEW_FIXTURE = join(
  dirname(resolve('@consola/factory-spec/package.json')),
  'src',
  'fixtures',
  'review-pull-requests',
);

// Stand-ins, never real credentials. The API key and the git token are the runner's own, which it
// scrubs from everything it says; the tokens a step gets are minted by the stand-in below.
const RUNNER_SECRET = 'runner-secret-sprocket-0123456789abcdef';
const API_KEY = 'sk-ant-sprocket-e2e-0123456789';
const GIT_TOKEN = 'ghs_sprocket_runner_git_0123456789';
const RUNNER_ID = 'r-1';
const REPOSITORY = 'sprocket/catalog-portal';
const REPOSITORY_ID = 70_123_456;
const INSTALLATION_ID = 51_234_567;
const WORKSPACE_ID = 'workspace-sprocket';
const PERSON_ID = 'person-sprocket-1';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PULL_REQUEST = 42;

/** What the reviewer leaves, through the step tools, as the agent would during its turn. */
const HANDOVER =
  '# Review\n\nThe retry never backs off: `src/sync.ts:42` loops at once when the catalog answers 503.\n';
/** An approving verdict, which nothing posts unattended: the review goes as a comment. */
const VERDICT = 'APPROVE';

const TEST_TIMEOUT_MS = 300_000;
/** How long the teardown gives the cell to stop on SIGTERM before it kills it. */
const CELL_STOP_GRACE_MS = 10_000;

/** The cell's answer to a request: its status and its JSON body. */
type Answer<A> = { readonly status: number; readonly body: A };

type RunItem = {
  readonly url: string;
  readonly title: string;
  readonly kind: string | null;
  readonly repo: string | null;
  readonly number: number | null;
  readonly headSha: string | null;
  readonly baseRef: string | null;
};

type RunSummary = {
  readonly id: string;
  readonly status: string;
  readonly automation: string | null;
  readonly trigger: string;
  readonly triggerDetail: string | null;
  readonly item: RunItem | null;
  readonly factory: { readonly id: string; readonly version: number } & Record<string, unknown>;
  readonly error: string | null;
};

type StepSummary = {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly error: string | null;
  readonly outputs: Record<string, unknown> | null;
  readonly artifacts: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
  readonly command: { readonly exitCode: number | null } | null;
  readonly output: { readonly stdout: string; readonly stderr: string } | null;
};

type RunDetail = { readonly run: RunSummary; readonly steps: readonly StepSummary[] };

/** A token the stand-in minted, and the request the cell signed for it. */
type Minted = { readonly request: GitHubTokenRequest; readonly token: string };

/** Everything one test runs on. */
type Cloud = {
  readonly root: string;
  readonly home: string;
  readonly record: string;
  /** What the stub `gh` wrote: its calls, and the body it was handed. */
  readonly ghCalls: string;
  readonly ghBody: string;
  readonly cloudGlobal: Server;
  readonly signingKey: KeyObject;
  readonly kid: string;
  readonly passPrivateKey: JWK;
  readonly cellPrivateKey: JWK;
  /** Every token the stand-in minted, in order. */
  readonly minted: Minted[];
  /** Every request the stand-in refused, by why. */
  readonly refusedMints: string[];
  readonly cellUrl: string;
  readonly cell: Started;
  /** The runner now: a case may stop it and start another (`startRunner`). */
  runner: Started;
  /** Starts the runner command, as at the start of the case. */
  readonly startRunner: () => Started;
  /** Every outbox message delivered so far, for the next sequence. */
  outboxSequence: number;
};

let cloud: Cloud | undefined;

const current = (): Cloud => {
  if (cloud === undefined) throw new Error('no cloud is running');
  return cloud;
};

/** Every file under `folder`, by its path inside it: a factory's files, as the web app sends them. */
const filesIn = (folder: string, prefix = ''): Array<{ path: string; content: string }> =>
  readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesIn(folder, path)
      : [{ path, content: readFileSync(join(folder, path), 'utf8') }];
  });

const readJson = (request: import('node:http').IncomingMessage): Promise<unknown> =>
  new Promise((done, fail) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        done(JSON.parse(body));
      } catch (error) {
        fail(error);
      }
    });
    request.on('error', fail);
  });

/** What each purpose grants, as `cloud-global` gives it, with GitHub's metadata read. */
const GRANTS: Record<string, Record<string, string>> = {
  'run-read': { contents: 'read', metadata: 'read' },
  'review-run': { contents: 'read', pull_requests: 'write', metadata: 'read' },
};

/**
 * A stand-in for `cloud-global`: its key route, publishing `jwk` alone, and `POST
 * /api/github/tokens`, which mints a token only for a request signed with the cell's key
 * (`cellPublicKey`), of `GITHUB_TOKEN_REQUEST_TYPE`, that the contract's reader takes, for the
 * workspace's installation and repository, as `cloud-global` checks it. It answers as
 * `cloud-global`'s contract declares.
 */
const serveCloudGlobal = (
  jwk: JWK,
  cellPublicKey: KeyObject,
  minted: Minted[],
  refused: string[],
) =>
  new Promise<Server>((done) => {
    const server = createHttpServer((request, response) => {
      const answer = (status: number, body: unknown) =>
        response
          .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify(body));
      if (request.method === 'GET' && request.url === CELL_TOKEN_KEYS_PATH) {
        answer(200, { keys: [jwk] });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/api/github/tokens') {
        answer(404, {});
        return;
      }
      void (async () => {
        const body = (await readJson(request)) as { request?: unknown };
        const refuse = (status: number, error: string) => {
          refused.push(error);
          answer(status, { error });
        };
        if (typeof body.request !== 'string') return refuse(400, 'invalid_request');
        let payload: unknown;
        try {
          const verified = await compactVerify(body.request, cellPublicKey, {
            algorithms: [CELL_TOKEN_ALGORITHM],
          });
          if (verified.protectedHeader.typ !== GITHUB_TOKEN_REQUEST_TYPE) {
            return refuse(401, 'unsigned');
          }
          payload = JSON.parse(new TextDecoder().decode(verified.payload));
        } catch {
          return refuse(401, 'unsigned');
        }
        const read = readGitHubTokenRequest(payload, Math.floor(Date.now() / 1000));
        if (!read.ok) return refuse(400, 'unreadable');
        const ask = read.value;
        const grants = GRANTS[ask.purpose];
        if (ask.workspaceId !== WORKSPACE_ID || ask.installationId !== INSTALLATION_ID) {
          return refuse(404, 'installation_not_found');
        }
        if (ask.repositoryIds.length !== 1 || ask.repositoryIds[0] !== REPOSITORY_ID) {
          return refuse(403, 'repository_not_covered');
        }
        if (grants === undefined) return refuse(403, 'scope_refused');
        const token = `ghs_e2e${ask.purpose.replace('-', '')}${randomBytes(12).toString('hex')}`;
        minted.push({ request: ask, token });
        answer(201, {
          token,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          repositories: [{ id: REPOSITORY_ID, fullName: REPOSITORY }],
          permissions: grants,
        });
      })().catch(() => answer(500, {}));
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });

/** A cell token for the person in Sprocket's workspace, signed as `cloud-global` signs one. */
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

/** Asks the cell's API as the person, with a token of their own, as the web app does. */
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

/** Delivers `message`, signed with `cloud-global`'s key under `typ`, as `cloud-global` does. */
const deliver = async (path: string, mediaType: string, typ: string, message: unknown) => {
  const { signingKey, kid, cellUrl } = current();
  const signed = await new CompactSign(new TextEncoder().encode(JSON.stringify(message)))
    .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid, typ })
    .sign(signingKey);
  const response = await fetch(`${cellUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': mediaType },
    body: signed,
  });
  return response.status;
};

/** The workspace's next outbox message, delivered: the cell then holds the workspace. */
const deliverOutbox = async (change: Record<string, unknown>) => {
  const running = current();
  running.outboxSequence += 1;
  const status = await deliver(
    OUTBOX_DELIVERY_PATH,
    OUTBOX_DELIVERY_MEDIA_TYPE,
    OUTBOX_MESSAGE_TYPE,
    {
      workspaceId: WORKSPACE_ID,
      region: 'eu',
      sequence: running.outboxSequence,
      change,
    },
  );
  expect(status).toBe(200);
};

/** GitHub's `pull_request` payload for pull request `number`, as the GitHub App receives it. */
const pullRequestPayload = (action: string, number: number) => ({
  action,
  number,
  pull_request: {
    number,
    html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
    title: 'Retry the catalog sync when it answers 503',
    user: { login: 'acme-dev' },
    draft: false,
    head: { sha: HEAD, ref: 'fix/catalog-retry', repo: { id: REPOSITORY_ID } },
    base: { ref: 'main', repo: { id: REPOSITORY_ID } },
  },
  repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
  installation: { id: INSTALLATION_ID },
});

/** Passes a `pull_request` event on to the cell, as `cloud-global` does: its status. */
const deliverPullRequest = (deliveryId: string, number = PULL_REQUEST, action = 'opened') =>
  deliver(GITHUB_EVENT_DELIVERY_PATH, GITHUB_EVENT_DELIVERY_MEDIA_TYPE, GITHUB_EVENT_TYPE, {
    workspaceId: WORKSPACE_ID,
    region: 'eu',
    deliveryId,
    event: 'pull_request',
    installationId: INSTALLATION_ID,
    payload: pullRequestPayload(action, number),
  });

/**
 * The workspace as `cloud-global`'s outbox makes it in the cell (made, the person a member, so on
 * its first team), and the Review pull requests factory saved on that team as the web app saves
 * it: made blank (version 1), then its files as version 2. Answers the factory's id and version.
 */
const saveReviewFactory = async (): Promise<{ id: string; version: number }> => {
  await deliverOutbox({ type: 'workspace.created' });
  await deliverOutbox({ type: 'member.added', personId: PERSON_ID, role: 'member' });
  const teams = await askCell<{ teams: Array<{ id: string; first: boolean }> }>(
    'GET',
    '/api/teams',
  );
  expect(teams.status).toBe(200);
  const team = teams.body.teams.find((each) => each.first);
  if (team === undefined) throw new Error('the workspace has no first team');

  const made = await askCell<{ id: string; latestVersion: number }>('POST', '/api/factories', {
    name: 'Review pull requests',
    teamId: team.id,
  });
  expect(made.status).toBe(201);
  expect(made.body.latestVersion).toBe(1);
  const files = filesIn(REVIEW_FIXTURE);
  // The automation file ends in `.yaml`, as the web editor requires.
  expect(files.map((file) => file.path).sort()).toEqual([
    'agents/reviewer.md',
    'automations/review-pr.yaml',
    'factory.yml',
  ]);
  const saved = await askCell<{ version: { version: number } }>(
    'POST',
    `/api/factories/${made.body.id}/versions`,
    { baseVersion: 1, files },
  );
  expect(saved.status).toBe(201);
  expect(saved.body.version.version).toBe(2);
  return { id: made.body.id, version: 2 };
};

const listRuns = async (): Promise<RunSummary[]> => {
  const answer = await askCell<{ runs: RunSummary[] }>('GET', '/api/runs');
  expect(answer.status).toBe(200);
  return answer.body.runs;
};

const readRun = async (runId: string): Promise<RunDetail> => {
  const answer = await askCell<RunDetail>('GET', `/api/runs/${runId}`);
  expect(answer.status).toBe(200);
  return answer.body;
};

/** The run once its status is one of `statuses`. */
const runOnce = (runId: string, statuses: readonly string[], timeoutMs = WAIT_MS) =>
  waitFor(
    async () => {
      if (!isRunning(current().runner.child)) {
        throw new Error(`the runner exited; its stderr:\n${current().runner.stderr()}`);
      }
      const detail = await readRun(runId);
      return statuses.includes(detail.run.status) ? detail : undefined;
    },
    `run ${runId} to be ${statuses.join(' or ')}`,
    timeoutMs,
  );

/** The one run the event recorded, once the runner recorded it. */
const recordedRun = () =>
  waitFor(async () => {
    const runs = await listRuns();
    return runs.length > 0 ? runs : undefined;
  }, 'the runner to record a run');

/** A call of the stub `gh`: its arguments, and the `GH_TOKEN` it was given ('' for none). */
type GhCall = { readonly args: string[]; readonly token: string };

/** What the stub `gh` was called with: two lines a call, its arguments, then its token. */
const ghCalls = (): GhCall[] => {
  const { ghCalls: file } = current();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
  const calls: GhCall[] = [];
  for (let at = 0; at + 1 < lines.length; at += 2) {
    calls.push({ args: lines[at] ?? [], token: lines[at + 1]?.[1] ?? '' });
  }
  return calls;
};

/** Nothing the cell, the runner or the cell's records hold carries a secret the test made. */
const expectNoSecretIn = (said: readonly string[]) => {
  const { cell, runner, passPrivateKey, cellPrivateKey, minted } = current();
  const printed = [cell.stdout(), cell.stderr(), runner.stdout(), runner.stderr(), ...said].join(
    '\n',
  );
  const secrets = [
    RUNNER_SECRET,
    API_KEY,
    GIT_TOKEN,
    String(passPrivateKey.d),
    String(cellPrivateKey.d),
    ...minted.map(({ token }) => token),
  ];
  for (const secret of secrets) {
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(encodeURIComponent(secret));
  }
  // The runner's stdout is empty: everything it says goes to the cell, its log to stderr.
  expect(runner.stdout()).toBe('');
};

/** How the step sandboxes behave: the reviewer's tool calls, on a replay that takes any prompt. */
const STEPS: LocalStepsOptions = {
  fixture: 'simple',
  mode: 'full-access',
  anyPrompt: true,
  toolCalls: [
    { name: 'consola_set_outputs', arguments: { outputs: { verdict: VERDICT } } },
    { name: 'consola_write_artifact', arguments: { name: 'handover', content: HANDOVER } },
  ],
};

/**
 * A stand-in for GitHub's CLI, first on the command sandbox's `PATH`: it posts nothing, records
 * its arguments and whether it was given the step's token (by the token's own value, in a file of
 * the test's), copies the body file it was handed, and prints the token, which the runner must
 * mask in what it records.
 */
const writeStubGh = (bin: string, calls: string, body: string) => {
  const script = [
    '#!/bin/sh',
    `calls='${calls}'`,
    `body='${body}'`,
    String.raw`tab=$(printf '\t')`,
    'line="gh"',
    'for arg in "$@"; do',
    '  line="$line$tab$arg"',
    '  case "$arg" in body=@*) cp "${arg#body=@}" "$body" ;; esac',
    'done',
    String.raw`printf "%s\n" "$line" >> "$calls"`,
    'printf "token\\t%s\\n" "${GH_TOKEN:-}" >> "$calls"',
    'echo "Posted the review with ${GH_TOKEN:-no token}."',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
};

/** Once the runner has said hello: the cell offers its repository and harness to a person. */
const runnerConnected = () =>
  waitFor(async () => {
    const { runner } = current();
    if (!isRunning(runner.child)) {
      throw new Error(`the runner exited; its stderr:\n${runner.stderr()}`);
    }
    const answer = await askCell<unknown>('GET', '/api/cloud-sessions/options');
    return answer.status === 200 ? true : undefined;
  }, 'the runner to connect');

beforeEach(async () => {
  if (!existsSync(CELL_MAIN)) {
    throw new Error(
      `${CELL_MAIN} is not built: run \`pnpm exec turbo run test --filter=@consola/cloud-session-e2e\`, which builds it first.`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), 'consola-triggered-run-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const stubs = join(root, 'stubs');
  const record = join(root, 'cli-calls.tsv');
  const ghCallsFile = join(root, 'gh-calls.tsv');
  const ghBody = join(root, 'gh-body.md');
  for (const dir of [home, bin, stubs]) mkdirSync(dir, { recursive: true });
  writeFileSync(record, '');
  writeFakeClis(bin, record);
  writeStubGh(stubs, ghCallsFile, ghBody);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const consolaVariables = Object.keys(env).filter((name) => name.startsWith('CONSOLA_'));
  for (const name of [...cliVariablesIn(env), ...RUNNER_SECRET_VARIABLES, ...consolaVariables]) {
    delete env[name];
  }
  Object.assign(env, homeVariables(home), { PATH: pathWith(bin) });

  // `cloud-global`'s signing key, published where the cell fetches it; the cell's own pass key;
  // and the cell's key for token requests, whose public half the stand-in holds as
  // `cloud-global` holds `CELL_PUBLIC_KEY_EU`.
  const { privateKey: signingKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const passPrivateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const cellKeys = generateKeyPairSync('ed25519');
  const cellPrivateKey = cellKeys.privateKey.export({ format: 'jwk' });
  const minted: Minted[] = [];
  const refusedMints: string[] = [];
  const cloudGlobal = await serveCloudGlobal(
    { ...jwk, kid, alg: CELL_TOKEN_ALGORITHM, use: 'sig' },
    cellKeys.publicKey,
    minted,
    refusedMints,
  );

  const port = await freePort();
  const cell = startNode(CELL_MAIN, [], {
    ...env,
    DATABASE_URL: 'pglite:memory',
    REGION: 'eu',
    PORT: String(port),
    CLOUD_GLOBAL_URL: `http://127.0.0.1:${portOf(cloudGlobal)}`,
    RUNNER_SECRET,
    RUNNER_WORKSPACE_ID: WORKSPACE_ID,
    PASS_PRIVATE_KEY: JSON.stringify(passPrivateKey),
    CELL_PRIVATE_KEY: JSON.stringify(cellPrivateKey),
  });
  const startRunner = () =>
    startNode(
      REPLAY_RUNNER,
      ['runner', '--cell-url', `ws://127.0.0.1:${port}/api/runner`, '--runner-id', RUNNER_ID],
      {
        ...env,
        // The stub `gh` first: a command step's sandbox takes the runner's PATH (`localProvider.ts`).
        PATH: `${stubs}:${pathWith(bin)}`,
        CONSOLA_RUNNER_SECRET: RUNNER_SECRET,
        CONSOLA_RUNNER_REPOSITORIES: REPOSITORY,
        CONSOLA_TEST_STEPS: JSON.stringify(STEPS),
        ANTHROPIC_API_KEY: API_KEY,
        GIT_TOKEN,
      },
    );
  const runner = startRunner();
  cloud = {
    root,
    home,
    record,
    ghCalls: ghCallsFile,
    ghBody,
    cloudGlobal,
    signingKey,
    kid,
    passPrivateKey,
    cellPrivateKey,
    minted,
    refusedMints,
    cellUrl: `http://127.0.0.1:${port}`,
    cell,
    runner,
    startRunner,
    outboxSequence: 0,
  };

  await waitFor(() => {
    if (!isRunning(cell.child)) throw new Error(`the cell exited; its stderr:\n${cell.stderr()}`);
    return cell.stdout().includes(`on http://127.0.0.1:${port}`) ? true : undefined;
  }, 'the cell to listen');
  await runnerConnected();
}, WAIT_MS * 2);

afterEach(async () => {
  const ended = cloud;
  cloud = undefined;
  if (ended === undefined) return;
  // Nothing outlives the test: the runner's sandboxes, the runner, then the cell.
  const left = isRunning(ended.runner.child) ? descendantsOf(ended.runner.child.pid ?? -1) : [];
  for (const pid of left) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  if (isRunning(ended.runner.child)) ended.runner.child.kill('SIGKILL');
  await ended.runner.exited;
  if (isRunning(ended.cell.child)) ended.cell.child.kill('SIGTERM');
  const graceOver = sleep(CELL_STOP_GRACE_MS).then(() => 'grace over' as const);
  if ((await Promise.race([ended.cell.exited, graceOver])) === 'grace over') {
    ended.cell.child.kill('SIGKILL');
    await ended.cell.exited;
  }
  ended.cloudGlobal.closeAllConnections();
  await new Promise<void>((done) => ended.cloudGlobal.close(() => done()));
  const calls = readCalls(ended.record);
  rmSync(ended.root, { recursive: true, force: true });
  // The step's host is a replay: no CLI ran, and none saw anything but the machine's home.
  for (const call of calls) {
    expect(call).toMatchObject({ home: ended.home, claudeConfigDir: '', codexHome: '' });
  }
}, CELL_STOP_GRACE_MS * 3);

describe('a pull request’s triggered run', () => {
  it(
    'waits for approval, then reviews and posts the review as a comment with the step’s own token',
    async () => {
      const factory = await saveReviewFactory();

      // The event, signed as cloud-global passes it on, then the same delivery again.
      expect(await deliverPullRequest('d0c5e2e0-0000-4000-8000-000000000001')).toBe(201);
      expect(await deliverPullRequest('d0c5e2e0-0000-4000-8000-000000000001')).toBe(200);

      const [waiting, ...others] = await recordedRun();
      if (waiting === undefined) throw new Error('no run');
      expect(others).toEqual([]);
      expect(waiting).toMatchObject({
        status: 'needs-approval',
        automation: 'review-pr',
        trigger: 'event',
        triggerDetail: 'pull_request.opened',
        error: null,
        item: {
          url: `https://github.com/${REPOSITORY}/pull/${PULL_REQUEST}`,
          title: 'Retry the catalog sync when it answers 503',
          kind: 'pr',
          repo: REPOSITORY,
          number: PULL_REQUEST,
          headSha: HEAD,
          baseRef: 'main',
        },
      });
      expect(waiting.factory).toMatchObject({ id: factory.id, version: factory.version });
      const before = await readRun(waiting.id);
      expect(before.steps.map(({ id, kind, status }) => ({ id, kind, status }))).toEqual([
        { id: 'review', kind: 'agent', status: 'pending' },
        { id: 'post', kind: 'run', status: 'pending' },
      ]);
      // Nothing runs, and no token is asked for, before a person approves.
      expect(current().minted).toEqual([]);
      expect(ghCalls()).toEqual([]);

      const approval = await askCell<{ decision: string }>(
        'POST',
        `/api/runs/${waiting.id}/approval`,
        { decision: 'approve', version: factory.version },
      );
      expect(approval.status).toBe(201);

      const ended = await runOnce(waiting.id, ['completed', 'failed', 'rejected'], 240_000);
      const why = JSON.stringify(
        {
          run: ended.run,
          steps: ended.steps,
          refused: current().refusedMints,
          runner: current().runner.stderr().slice(-4000),
        },
        null,
        2,
      );
      expect(ended.run.status, why).toBe('completed');
      const [review, post] = ended.steps;
      expect(review).toMatchObject({ id: 'review', status: 'completed', error: null });
      expect(review?.outputs).toEqual({ verdict: VERDICT });
      expect(review?.artifacts.map((artifact) => artifact.name)).toContain('handover');
      expect(post).toMatchObject({ id: 'post', status: 'completed', error: null });
      expect(post?.command?.exitCode).toBe(0);

      // Every token came through the cell's check, for the run's repository and installation:
      // the two checkouts read it (run-read), and the post writes pull requests (review-run).
      const { minted } = current();
      expect(minted.map(({ request }) => request.purpose)).toEqual([
        'run-read',
        'run-read',
        'review-run',
      ]);
      for (const { request } of minted) {
        expect(request).toMatchObject({
          workspaceId: WORKSPACE_ID,
          installationId: INSTALLATION_ID,
          repositoryIds: [REPOSITORY_ID],
        });
      }
      expect(current().refusedMints).toEqual([]);

      // gh posted once, on the commit the run read, with the review's body, as a comment: an
      // approving verdict is never posted as APPROVE. (The agent step's host, t3's server, asks gh
      // for its configuration as it starts, and is never given a token.)
      const calls = ghCalls();
      const posts = calls.filter((call) => call.args[1] === 'api');
      expect(posts, JSON.stringify(calls)).toHaveLength(1);
      for (const call of calls.filter((each) => each.args[1] !== 'api')) {
        expect(call.token).toBe('');
      }
      const [{ args, token } = { args: [], token: '' }] = posts;
      expect(args).toEqual([
        'gh',
        'api',
        `repos/${REPOSITORY}/pulls/${PULL_REQUEST}/reviews`,
        '-f',
        `commit_id=${HEAD}`,
        '-f',
        'event=COMMENT',
        '-F',
        expect.stringMatching(/^body=@\/.+/),
      ]);
      expect(args.join(' ')).not.toContain('APPROVE');
      expect(readFileSync(current().ghBody, 'utf8')).toBe(HANDOVER);
      // Its token is the one the cell got for the step (review-run), and no other.
      expect(token).toBe(minted[2]?.token);
      // What the command printed holds the token masked.
      expect(post?.output?.stdout).toContain('Posted the review with ***.');

      // One run for the delivery sent twice.
      expect((await listRuns()).map((run) => run.id)).toEqual([waiting.id]);
      // Every step's sandbox stopped: nothing runs below the runner.
      await waitFor(
        () => (descendantsOf(current().runner.child.pid ?? -1).length === 0 ? true : undefined),
        "the steps' sandboxes to stop",
      );
      expectNoSecretIn([
        JSON.stringify(await readRun(waiting.id)),
        JSON.stringify(await listRuns()),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is approved while no runner is connected, and runs once a runner says hello',
    async () => {
      const factory = await saveReviewFactory();
      expect(await deliverPullRequest('d0c5e2e0-0000-4000-8000-000000000003', 44)).toBe(201);
      const [waiting] = await recordedRun();
      if (waiting === undefined) throw new Error('no run');
      expect(waiting).toMatchObject({ status: 'needs-approval', item: { number: 44 } });

      // The runner stops (a deploy, a restart): it keeps nothing of the run.
      const first = current().runner;
      first.child.kill('SIGTERM');
      expect(await first.exited).toEqual({ code: 0, signal: null });
      await waitFor(async () => {
        const answer = await askCell<unknown>('GET', '/api/cloud-sessions/options');
        return answer.status === 503 ? true : undefined;
      }, 'the cell to see the runner gone');

      // The person approves while no runner is connected: the cell keeps the answer.
      const approval = await askCell<{ decision: string }>(
        'POST',
        `/api/runs/${waiting.id}/approval`,
        { decision: 'approve', version: factory.version },
      );
      expect(approval.status).toBe(201);
      expect((await readRun(waiting.id)).run.status).toBe('needs-approval');

      // A runner says hello: the cell passes it the answer with the stored record, and the runner
      // rebuilds the run from that record and the factory at its version.
      current().runner = current().startRunner();
      await runnerConnected();
      const ended = await runOnce(waiting.id, ['completed', 'failed', 'rejected'], 240_000);
      expect(ended.run.status, JSON.stringify(ended, null, 2)).toBe('completed');
      expect(ended.steps.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'review', status: 'completed' },
        { id: 'post', status: 'completed' },
      ]);
      expect(ended.run.item).toMatchObject({ number: 44, headSha: HEAD, baseRef: 'main' });
      const posts = ghCalls().filter((call) => call.args[1] === 'api');
      expect(posts.map((call) => call.args[2])).toEqual([`repos/${REPOSITORY}/pulls/44/reviews`]);
      expect(current().minted.map(({ request }) => request.purpose)).toEqual([
        'run-read',
        'run-read',
        'review-run',
      ]);
      // The event was acknowledged before the restart: one run, recorded once.
      expect((await listRuns()).map((run) => run.id)).toEqual([waiting.id]);
      expectNoSecretIn([JSON.stringify(await readRun(waiting.id)), first.stderr()]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is rejected when a person dismisses it: nothing runs and no token is asked for',
    async () => {
      const factory = await saveReviewFactory();
      expect(await deliverPullRequest('d0c5e2e0-0000-4000-8000-000000000002', 43)).toBe(201);
      const [waiting] = await recordedRun();
      if (waiting === undefined) throw new Error('no run');
      expect(waiting).toMatchObject({ status: 'needs-approval', item: { number: 43 } });

      const dismissal = await askCell<{ decision: string }>(
        'POST',
        `/api/runs/${waiting.id}/approval`,
        { decision: 'dismiss', version: factory.version },
      );
      expect(dismissal.status).toBe(201);
      const ended = await runOnce(waiting.id, ['rejected', 'completed', 'failed']);
      expect(ended.run.status).toBe('rejected');
      expect(ended.steps.every((step) => step.status !== 'completed')).toBe(true);
      // A second answer is refused: the first stands.
      const again = await askCell<{ error: string }>('POST', `/api/runs/${waiting.id}/approval`, {
        decision: 'approve',
        version: factory.version,
      });
      expect(again.status).toBe(409);
      // Give a stray start the time to show, then: no token, no gh, no sandbox.
      await sleep(1000);
      expect(current().minted).toEqual([]);
      expect(ghCalls()).toEqual([]);
      expect(descendantsOf(current().runner.child.pid ?? -1)).toEqual([]);
      expectNoSecretIn([JSON.stringify(await readRun(waiting.id))]);
    },
    TEST_TIMEOUT_MS,
  );
});

// @effect-diagnostics nodeBuiltinImport:off - It starts the host with node and reads what it prints.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCHESTRATION_V2_WS_METHODS } from '@t3tools/contracts';
import type * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import { decodeJwt, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { type WebSocket, WebSocketServer } from 'ws';
import { DEV_PASS_SECONDS } from './adapters/devPass.ts';
import { HOST_LINE_TYPES } from './adapters/stdoutEvents.ts';
import {
  DEFAULT_MAX_SESSION_MINUTES,
  DEV_SESSION_ID,
  folderWarning,
  isRunnerCommand,
  parseRunnerArgs,
  parseSessionArgs,
  StartFailed,
  UsageError,
} from './bin.ts';
import { isolateMachine } from './testing/machine.ts';
import { loadReplay, REPLAY_TITLE, sendMessage } from './testing/replay.ts';
import { connectT3Client, hostSocketUrl } from './testing/t3Client.ts';

/**
 * Each test runs on a machine of its own (`./testing/machine.ts`): a temporary home, no CLI config
 * or login variables, and fake CLIs first on the PATH. Every host a test starts inherits that
 * environment, so the host's drivers only ever find the fakes.
 */
const machine = isolateMachine();

const SRC = dirname(fileURLToPath(import.meta.url));
/** The command as Track B's runner starts it. */
const BIN = join(SRC, 'bin.ts');
/** The same command, its Claude driver replaying one of t3's fixtures (test-only). */
const REPLAY_ENTRY = join(SRC, 'testing', 'replaySession.ts');
/** The runner, its sandboxes local processes of `replaySession.ts` (test-only). */
const REPLAY_RUNNER = join(SRC, 'testing', 'replayRunner.ts');

/** Starting node, loading t3 and hydrating its drivers takes seconds; under load, more. */
const LINE_TIMEOUT = Duration.seconds(60);
const TEST_TIMEOUT_MS = 150_000;

type Line = { readonly type: string } & Record<string, unknown>;
type Exited = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A host a test started: its stdout lines as they arrive, its stderr, and how it ended. */
type Host = {
  readonly pid: number;
  /** Every stdout line, as printed. */
  readonly printed: ReadonlyArray<string>;
  /** The next stdout line, parsed; dies when the host ends first or prints none in time. */
  readonly next: Effect.Effect<Line>;
  readonly stderr: () => string;
  readonly exited: Effect.Effect<Exited>;
  readonly signal: (signal: NodeJS.Signals) => void;
};

/** Hosts still running when a test ends are killed, before the machine checks its record. */
const running = new Set<ChildProcess>();
afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
});

/** The test machine's environment (set on this process by `isolateMachine`), and `env` over it. */
const machineEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...process.env, ...env });

/** The test machine's `PATH` with `dir` first. */
const pathWithFirst = (dir: string): string => `${dir}:${process.env.PATH ?? ''}`;

const parseLine = (printed: string): Line => JSON.parse(printed) as Line;

/** Starts `node <script> <args>` with the test machine's environment (and `env` over it). */
const startHost = Effect.fn('startHost')(function* (
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
) {
  const lines = yield* Queue.unbounded<string, Cause.Done>();
  // The machine's PATH holds only fake CLIs and /usr/bin:/bin, so node is named by its path.
  const child = spawn(process.execPath, [script, ...args], {
    env: machineEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  const printed: string[] = [];
  let buffered = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const printedLine = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      printed.push(printedLine);
      Queue.offerUnsafe(lines, printedLine);
      newline = buffered.indexOf('\n');
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<Exited>((resolve) => {
    child.on('exit', (code, signal) => {
      running.delete(child);
      Queue.endUnsafe(lines);
      resolve({ code, signal });
    });
  });
  const tail = () => `stderr:\n${stderr.slice(-4000)}`;
  if (child.pid === undefined) return yield* Effect.die(new Error('node did not start'));
  const host: Host = {
    pid: child.pid,
    printed,
    next: Queue.take(lines).pipe(
      Effect.map(parseLine),
      Effect.catch(() => Effect.die(new Error(`the host ended first; ${tail()}`))),
      Effect.timeoutOrElse({
        duration: LINE_TIMEOUT,
        orElse: () => Effect.die(new Error(`no line from the host in time; ${tail()}`)),
      }),
    ),
    stderr: () => stderr,
    exited: Effect.promise(() => exited),
    signal: (signal) => child.kill(signal),
  };
  return host;
});

/** Every line the host printed is one JSON object of a type the runner reads. */
const expectOnlyHostLines = (printed: ReadonlyArray<string>) => {
  for (const each of printed) {
    const parsed = parseLine(each);
    expect(parsed).toMatchObject({ type: expect.any(String) });
    expect(HOST_LINE_TYPES).toContain(parsed.type);
  }
};

const typesOf = (printed: ReadonlyArray<string>) => printed.map((each) => parseLine(each).type);

/** A folder for the test, removed with its scope. */
const tempFolder = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

/** t3's settings file in `stateDir`, with update checks off: the host asks no one online. */
const writeOfflineSettings = (stateDir: string) => {
  mkdirSync(join(stateDir, 'userdata'), { recursive: true });
  writeFileSync(
    join(stateDir, 'userdata', 'settings.json'),
    JSON.stringify({ enableProviderUpdateChecks: false }),
  );
};

const offlineState = tempFolder('consola-host-bin-state-').pipe(
  Effect.tap((stateDir) => Effect.sync(() => writeOfflineSettings(stateDir))),
);

/**
 * A `claude` that answers `--version` as an installed CLI, so t3 runs its capabilities probe; the
 * probe's `claude` records its pid and `HOME` in `pids` and stays running, as a CLI's would.
 */
const writeLongLivedClaude = (dir: string, pids: string) => {
  writeFileSync(pids, '');
  const claude = join(dir, 'claude');
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
      `printf '%s\\t%s\\n' "$$" "\${HOME-}" >> '${pids}'`,
      'exec sleep 120',
      '',
    ].join('\n'),
  );
  chmodSync(claude, 0o755);
};

const readPids = (pids: string) =>
  readFileSync(pids, 'utf8')
    .split('\n')
    .filter((row) => row.length > 0)
    .map((row) => {
      const [pid = '', home = ''] = row.split('\t');
      return { pid: Number(pid), home };
    });

/** The pids of every process below `pid`, now. */
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

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = (check: () => boolean, what: string, timeout: Duration.Input = LINE_TIMEOUT) =>
  Effect.gen(function* () {
    while (!check()) yield* Effect.sleep(Duration.millis(50));
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
    }),
  );

/** A port someone else already listens on, released with the scope. */
const takenPort = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer().listen(0, '127.0.0.1', () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }),
);

/** A pass for `sessionId` signed with `privateKey`, valid for ten minutes, as the cell signs one. */
const signPass = Effect.fn('signPass')(function* (privateKey: KeyObject, sessionId: string) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return yield* Effect.promise(() =>
    new SignJWT({ sub: 'person-acme-1', ws: 'workspace-sprocket', sid: sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(privateKey),
  );
});

describe('consola-host session', () => {
  it(
    "replaying t3's simple fixture: ready, dev-pass, then a message brings status and title lines",
    () =>
      Effect.gen(function* () {
        const { variant, text } = yield* loadReplay('simple');
        const sessionId = 'session-sprocket-bin';
        const host = yield* startHost(REPLAY_ENTRY, [
          'simple',
          'full-access',
          'session',
          '--dev',
          '--session-id',
          sessionId,
          '--harness',
          'claude',
          '--port',
          '0',
        ]);

        const ready = yield* host.next;
        expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
        const devPass = yield* host.next;
        expect(devPass).toEqual({
          type: 'dev-pass',
          pass: expect.any(String),
          expiresInSeconds: 43_200,
        });
        const pass = devPass.pass as string;
        const claims = decodeJwt(pass);
        expect(claims).toMatchObject({ sub: 'dev', ws: 'local', sid: sessionId });
        expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(DEV_PASS_SECONDS);

        const { client } = yield* connectT3Client(hostSocketUrl(ready.port as number, pass));
        const spec = { sessionId, harness: 'claude', cwd: '' } as const;
        yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          sendMessage(spec, text, variant.modelSelection),
        );

        // The run works and ends, and t3 titles the thread: from the message's title seed at once,
        // then with the title its text generation gives. Each line is printed once, on a change.
        const seen: Line[] = [];
        const settled = () =>
          seen.some((each) => each.type === 'title' && each.title === REPLAY_TITLE) &&
          seen.filter((each) => each.type === 'status').at(-1)?.status === 'idle';
        while (!settled()) seen.push(yield* host.next);
        const statusLines = seen.filter((each) => each.type === 'status');
        expect(statusLines[0]).toEqual({ type: 'status', status: 'working' });
        expect(statusLines.at(-1)).toEqual({ type: 'status', status: 'idle' });
        for (const [index, each] of statusLines.entries()) {
          expect(each.status).not.toBe(statusLines[index - 1]?.status);
        }
        expect(seen.filter((each) => each.type === 'title')).toEqual([
          { type: 'title', title: text },
          { type: 'title', title: REPLAY_TITLE },
        ]);

        host.signal('SIGTERM');
        expect(yield* host.exited).toEqual({ code: 0, signal: null });
        expectOnlyHostLines(host.printed);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it(
    'as the runner starts it: ready and dev-pass, a socket that takes the pass, and SIGTERM ends it with no process left',
    () =>
      Effect.gen(function* () {
        const stateDir = yield* offlineState;
        const cwd = yield* tempFolder('consola-host-bin-acme-');
        const longLived = yield* tempFolder('consola-host-bin-cli-');
        const pids = join(longLived, 'pids.tsv');
        writeLongLivedClaude(longLived, pids);
        const host = yield* startHost(
          BIN,
          [
            'session',
            '--dev',
            '--harness',
            'claude',
            '--cwd',
            cwd,
            '--port',
            '0',
            '--state-dir',
            stateDir,
          ],
          { PATH: pathWithFirst(longLived) },
        );

        const ready = yield* host.next;
        const readyAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
        // One human line on stderr, naming the folder, before anything started.
        const warnings = host
          .stderr()
          .split('\n')
          .filter((line) => line.startsWith('consola-host: warning:'));
        expect(warnings).toEqual([folderWarning(cwd)]);
        expect(folderWarning(cwd)).toMatch(/project settings and hooks with no trust prompt/);
        expect(folderWarning(cwd)).toContain('refs/t3/orchestration-v2/checkpoints');
        const devPass = yield* host.next;
        expect(devPass).toMatchObject({ type: 'dev-pass', expiresInSeconds: 43_200 });
        const pass = devPass.pass as string;
        // Without `--session-id`, `--dev` serves `DEV_SESSION_ID`, and the pass names it.
        const claims = decodeJwt(pass);
        expect(claims).toMatchObject({ sid: DEV_SESSION_ID, sub: 'dev', ws: 'local' });
        // Signed as the host is about to listen, not before the CLI's slow start: it lasts the
        // twelve hours `expiresInSeconds` says from about the moment it is printed.
        expect(claims.iat).toBeGreaterThanOrEqual(readyAt - 3);
        expect(claims.iat).toBeLessThanOrEqual(readyAt);

        // t3's own client is let in and gets its first config snapshot.
        const connected = yield* connectT3Client(hostSocketUrl(ready.port as number, pass));
        expect(connected.initialConfig.environment.environmentId).toBe(DEV_SESSION_ID);

        yield* waitFor(() => readPids(pids).length > 0, 'the long-lived claude to start');
        const cliPids = readPids(pids).map((record) => record.pid);
        for (const record of readPids(pids)) expect(record.home).toBe(machine.home());
        const children = descendantsOf(host.pid);
        expect(children).toEqual(expect.arrayContaining(cliPids));

        host.signal('SIGTERM');
        expect(yield* host.exited).toEqual({ code: 0, signal: null });
        // Nothing the host started outlives it.
        yield* waitFor(
          () => [...children, ...cliPids].every((pid) => !isAlive(pid)),
          'every process the host started to end',
          Duration.seconds(10),
        );
        expect(typesOf(host.printed)).toEqual(['ready', 'dev-pass']);
        expectOnlyHostLines(host.printed);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it(
    "with the cell's key: no dev-pass, its pass is let in, and the host exits idle once no client has stayed",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* offlineState;
        const cwd = yield* tempFolder('consola-host-bin-acme-');
        const keys = yield* tempFolder('consola-host-bin-key-');
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const keyFile = join(keys, 'cell.pem');
        writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }).toString());
        const sessionId = 'session-sprocket-idle';
        const idleMinutes = 0.1; // six seconds
        const host = yield* startHost(BIN, [
          'session',
          '--session-id',
          sessionId,
          '--harness',
          'claude',
          '--cwd',
          cwd,
          '--port',
          '0',
          '--pass-public-key',
          keyFile,
          '--idle-minutes',
          String(idleMinutes),
          '--state-dir',
          stateDir,
        ]);

        const ready = yield* host.next;
        expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
        const pass = yield* signPass(privateKey, sessionId);

        // A connected client holds the host past its idle time.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* connectT3Client(hostSocketUrl(ready.port as number, pass));
            yield* Effect.sleep(Duration.millis(idleMinutes * 60_000 + 3_000));
            expect(typesOf(host.printed)).toEqual(['ready']);
          }),
        );

        // Once it has gone, the idle time runs from then: the host says so and ends.
        const leftAt = yield* Clock.currentTimeMillis;
        expect(yield* host.next).toEqual({ type: 'exit', reason: 'idle' });
        const exitedAt = yield* Clock.currentTimeMillis;
        expect(exitedAt - leftAt).toBeGreaterThanOrEqual(idleMinutes * 60_000 - 1_000);
        expect(yield* host.exited).toEqual({ code: 0, signal: null });
        expect(typesOf(host.printed)).toEqual(['ready', 'exit']);
        expectOnlyHostLines(host.printed);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to start on a port already taken: a message on stderr, exit 1, nothing on stdout',
    () =>
      Effect.gen(function* () {
        const stateDir = yield* offlineState;
        const cwd = yield* tempFolder('consola-host-bin-acme-');
        const port = yield* takenPort;
        const host = yield* startHost(BIN, [
          'session',
          '--dev',
          '--harness',
          'claude',
          '--cwd',
          cwd,
          '--port',
          String(port),
          '--state-dir',
          stateDir,
        ]);
        expect(yield* host.exited).toEqual({ code: 1, signal: null });
        expect(host.printed).toEqual([]);
        expect(host.stderr()).toContain(`consola-host: Cannot listen on 127.0.0.1:${port}`);
        expect(host.stderr()).toContain('EADDRINUSE');
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'a harness it does not know',
      ['--harness', 'cursor'],
      /consola-host: --harness must be one of claude, codex, opencode, pi, acp\./,
    ],
    [
      'a folder that does not exist',
      ['--dev', '--cwd', '/nonexistent/acme'],
      /--cwd \/nonexistent\/acme is not a folder/,
    ],
    [
      'no --pass-public-key without --dev',
      [],
      /consola-host: --pass-public-key is required without --dev\./,
    ],
    [
      '--dev on an address that is not loopback',
      ['--dev', '--bind', '0.0.0.0'],
      /consola-host: --dev listens only on loopback \(127\.0\.0\.1, ::1 or localhost\), not on 0\.0\.0\.0\./,
    ],
    [
      'a key that is not an Ed25519 public key',
      ['--pass-public-key', 'NOT_A_PEM'],
      /consola-host: The pass public key is not an Ed25519 public key in SPKI PEM form\./,
    ],
  ])(
    'refuses to start on %s: a message on stderr, exit 1, nothing on stdout',
    (_case, extra, message) =>
      Effect.gen(function* () {
        const cwd = yield* tempFolder('consola-host-bin-acme-');
        const notAPem = join(cwd, 'not-a-key.pem');
        writeFileSync(notAPem, 'not a pem');
        const args = extra.map((arg) => (arg === 'NOT_A_PEM' ? notAPem : arg));
        const host = yield* startHost(BIN, [
          'session',
          '--session-id',
          'session-sprocket-refused',
          ...(args.includes('--harness') ? [] : ['--harness', 'claude']),
          ...(args.includes('--cwd') ? [] : ['--cwd', cwd]),
          ...args,
        ]);
        expect(yield* host.exited).toEqual({ code: 1, signal: null });
        expect(host.printed).toEqual([]);
        expect(host.stderr()).toMatch(message);
        expect(host.stderr()).not.toContain('not a pem');
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );
});

describe('parseSessionArgs', () => {
  const parse = (argv: ReadonlyArray<string>) => Effect.runSync(parseSessionArgs(argv));
  const refusal = (argv: ReadonlyArray<string>) =>
    Effect.runSync(Effect.flip(parseSessionArgs(argv)));
  const required = [
    'session',
    '--session-id',
    'session-sprocket-1',
    '--harness',
    'codex',
    '--cwd',
    '/srv/acme',
    '--pass-public-key',
    '/etc/consola/cell.pem',
  ];

  it('defaults to port 7420 on 127.0.0.1, ten idle minutes and a fresh state folder', () => {
    expect(parse(required)).toEqual({
      spec: { sessionId: 'session-sprocket-1', harness: 'codex', cwd: '/srv/acme' },
      port: 7420,
      bind: '127.0.0.1',
      access: { type: 'key', publicKeyFile: '/etc/consola/cell.pem' },
      idleMinutes: 10,
      stateDir: null,
    });
  });

  it('takes every flag', () => {
    expect(
      parse([
        ...required,
        '--port',
        '0',
        '--bind',
        '0.0.0.0',
        '--idle-minutes',
        '2.5',
        '--state-dir',
        '/var/lib/consola-host',
      ]),
    ).toMatchObject({
      port: 0,
      bind: '0.0.0.0',
      idleMinutes: 2.5,
      stateDir: '/var/lib/consola-host',
    });
  });

  it('--dev needs no key and no session id, and ignores a key given', () => {
    expect(parse(['session', '--dev', '--harness', 'claude', '--cwd', '/srv/acme'])).toMatchObject({
      spec: { sessionId: DEV_SESSION_ID },
      access: { type: 'dev' },
    });
    expect(parse([...required, '--dev'])).toMatchObject({
      spec: { sessionId: 'session-sprocket-1' },
      access: { type: 'dev' },
    });
  });

  it.each(['127.0.0.1', '127.1.2.3', '::1', 'localhost'])('--dev may bind loopback %s', (bind) => {
    expect(parse([...required, '--dev', '--bind', bind])).toMatchObject({ bind });
  });

  it('resolves --cwd against the working folder', () => {
    expect(parse(['session', '--dev', '--harness', 'pi', '--cwd', 'acme']).spec.cwd).toBe(
      join(process.cwd(), 'acme'),
    );
  });

  it.each([
    ['no command', required.slice(1), /session/],
    ['another command', ['serve', ...required.slice(1)], /serve/],
    ['an extra argument', [...required, 'sprocket'], /sprocket/],
    ['an unknown flag', [...required, '--verbose'], /--verbose/],
    ['an unknown harness', [...required, '--harness', 'cursor'], /--harness/],
    ['no harness', required.filter((_, i) => i !== 3 && i !== 4), /--harness/],
    ['no folder', required.filter((_, i) => i !== 5 && i !== 6), /--cwd/],
    ['no session id', required.filter((_, i) => i !== 1 && i !== 2), /--session-id/],
    ['no key', required.slice(0, 7), /--pass-public-key/],
    ['a port out of range', [...required, '--port', '65536'], /--port/],
    ['a port that is not a number', [...required, '--port', 'acme'], /--port/],
    ['a negative port', [...required, '--port=-1'], /--port/],
    ['no idle minutes', [...required, '--idle-minutes', '0'], /--idle-minutes/],
    ['idle minutes that are not a number', [...required, '--idle-minutes', 'x'], /--idle-minutes/],
    ['an empty bind address', [...required, '--bind', ''], /--bind/],
    ['--dev on every address', [...required, '--dev', '--bind', '0.0.0.0'], /--dev listens only/],
    ['--dev on every IPv6 address', [...required, '--dev', '--bind', '::'], /--dev listens only/],
    [
      '--dev on a LAN address',
      [...required, '--dev', '--bind', '192.168.1.20'],
      /--dev listens only/,
    ],
    ['--dev on a name', [...required, '--dev', '--bind', 'acme.example'], /--dev listens only/],
  ])('refuses %s', (_case, argv, message) => {
    const error = refusal(argv);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(message);
  });
});

/** The runner's secrets, as the tests give them: none may show on its stderr or stdout. */
const RUNNER_SECRET = 'runner-secret-sprocket-0123456789abcdef';
const RUNNER_GIT_TOKEN = 'ghp_sprocketRunnerToken0123456789';
const RUNNER_ANTHROPIC_KEY = 'sk-ant-sprocket-runner-0123456789';
const RUNNER_SECRETS = [RUNNER_SECRET, RUNNER_GIT_TOKEN, RUNNER_ANTHROPIC_KEY];
const RUNNER_ENV: NodeJS.ProcessEnv = {
  CONSOLA_RUNNER_SECRET: RUNNER_SECRET,
  CONSOLA_RUNNER_REPOSITORIES: 'sprocket/catalog-portal',
  GIT_TOKEN: RUNNER_GIT_TOKEN,
  ANTHROPIC_API_KEY: RUNNER_ANTHROPIC_KEY,
};

type Frame = Record<string, unknown>;

/** A cell's runner socket on a free port of loopback, which hands the test what the runner says. */
const fakeRunnerCell = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<Frame, Cause.Done>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<WebSocketServer>((resume) => {
      const wss: WebSocketServer = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: '/api/runner',
      });
      wss.on('listening', () => resume(Effect.succeed(wss)));
    }),
    (wss) =>
      Effect.callback<void>((resume) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resume(Effect.void));
      }),
  );
  const sockets: WebSocket[] = [];
  const authorizations: string[] = [];
  const closes: number[] = [];
  server.on('connection', (socket, request) => {
    sockets.push(socket);
    authorizations.push(request.headers.authorization ?? '');
    socket.on('message', (data) => Queue.offerUnsafe(frames, JSON.parse(String(data)) as Frame));
    socket.on('close', (code) => closes.push(code));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api/runner`,
    next: Queue.take(frames).pipe(
      Effect.timeoutOrElse({
        duration: LINE_TIMEOUT,
        orElse: () => Effect.die(new Error('no frame from the runner in time')),
      }),
      Effect.orDie,
    ),
    send: (message: unknown) => sockets.at(-1)?.send(JSON.stringify(message)),
    close: (code: number, reason: string) => sockets.at(-1)?.close(code, reason),
    authorizations,
    closes,
  };
});

/** The status of `GET <url>`, or the error's code when nothing answers. */
const statusOf = (url: string) =>
  Effect.callback<number | string>((resume) => {
    get(url, (response) => {
      response.resume();
      resume(Effect.succeed(response.statusCode ?? 0));
    }).on('error', (error: NodeJS.ErrnoException) => resume(Effect.succeed(error.code ?? 'error')));
  });

describe('consola-host runner', () => {
  it(
    "runs a session in a local sandbox: hello, running at the host's address, then on SIGTERM stopped, exit 0 and nothing left",
    () =>
      Effect.gen(function* () {
        const cell = yield* fakeRunnerCell;
        const runner = yield* startHost(
          REPLAY_RUNNER,
          [
            'runner',
            '--cell-url',
            cell.url,
            '--runner-id',
            'runner-sprocket-1',
            '--idle-minutes',
            '5',
          ],
          RUNNER_ENV,
        );
        expect(yield* cell.next).toEqual({
          type: 'hello',
          runnerId: 'runner-sprocket-1',
          repositories: ['sprocket/catalog-portal'],
          harnesses: ['claude'],
          runningSessionIds: [],
          endedSessions: [],
        });
        expect(cell.authorizations).toEqual([`Bearer ${RUNNER_SECRET}`]);

        const { publicKey } = generateKeyPairSync('ed25519');
        const sessionId = 'session-sprocket-runner-1';
        cell.send({
          type: 'session.start',
          sessionId,
          workspaceId: 'workspace-sprocket',
          repository: 'sprocket/catalog-portal',
          harness: 'claude',
          passPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        });
        const running = yield* cell.next;
        expect(running).toMatchObject({ type: 'session.update', sessionId, status: 'running' });
        const hostUrl = String(running.hostUrl);
        expect(hostUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        // The session's host listens where the runner said: t3's environment descriptor answers.
        expect(yield* statusOf(`${hostUrl}/.well-known/t3/environment`)).toBe(200);
        const inSandbox = descendantsOf(runner.pid);
        expect(inSandbox.length).toBeGreaterThan(0);

        runner.signal('SIGTERM');
        expect(yield* cell.next).toEqual({ type: 'session.update', sessionId, status: 'stopped' });
        expect(yield* runner.exited).toEqual({ code: 0, signal: null });
        yield* waitFor(() => inSandbox.every((pid) => !isAlive(pid)), 'no process left');
        yield* waitFor(() => cell.closes.length > 0, 'the socket closed');
        expect(cell.closes).toEqual([1001]);
        expect(runner.printed).toEqual([]);
        for (const secret of RUNNER_SECRETS) expect(runner.stderr()).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it(
    'stops, and exits 1 saying why, once another runner with its secret replaced it (4000)',
    () =>
      Effect.gen(function* () {
        const cell = yield* fakeRunnerCell;
        const runner = yield* startHost(
          REPLAY_RUNNER,
          ['runner', '--cell-url', cell.url, '--runner-id', 'runner-sprocket-1'],
          RUNNER_ENV,
        );
        expect(yield* cell.next).toMatchObject({ type: 'hello' });
        cell.close(4000, 'another socket of the runner said hello');
        expect(yield* runner.exited).toEqual({ code: 1, signal: null });
        expect(runner.stderr()).toMatch(/consola-host: Another runner connected to the cell/);
        expect(cell.authorizations).toHaveLength(1);
        for (const secret of RUNNER_SECRETS) expect(runner.stderr()).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 1 within its 15 s grace once replaced (4000), though a sandbox never stops',
    () =>
      Effect.gen(function* () {
        const cell = yield* fakeRunnerCell;
        const runner = yield* startHost(
          REPLAY_RUNNER,
          ['runner', '--cell-url', cell.url, '--runner-id', 'runner-sprocket-1'],
          { ...RUNNER_ENV, CONSOLA_TEST_SANDBOX_STOP: 'hangs' },
        );
        expect(yield* cell.next).toMatchObject({ type: 'hello' });
        const { publicKey } = generateKeyPairSync('ed25519');
        const sessionId = 'session-sprocket-runner-2';
        cell.send({
          type: 'session.start',
          sessionId,
          workspaceId: 'workspace-sprocket',
          repository: 'sprocket/catalog-portal',
          harness: 'claude',
          passPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        });
        expect(yield* cell.next).toMatchObject({ sessionId, status: 'running' });
        // Its sandbox never stops, so the test ends what ran in it.
        const inSandbox = descendantsOf(runner.pid);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of inSandbox) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
          }),
        );

        const replacedAt = yield* Clock.currentTimeMillis;
        cell.close(4000, 'another socket of the runner said hello');
        const exited = yield* runner.exited.pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(40),
            orElse: () =>
              Effect.die(new Error(`the runner did not exit; stderr:\n${runner.stderr()}`)),
          }),
        );
        const tookMs = (yield* Clock.currentTimeMillis) - replacedAt;
        expect(exited).toEqual({ code: 1, signal: null });
        expect(runner.stderr()).toMatch(/consola-host: the runner did not stop in time\./);
        // The grace, not the 30 s a sandbox's stop is given.
        expect(tookMs).toBeLessThan(25_000);
        expect(runner.printed).toEqual([]);
        for (const secret of RUNNER_SECRETS) expect(runner.stderr()).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );

  it.each<[string, string[], NodeJS.ProcessEnv, RegExp]>([
    [
      'no secret',
      [],
      { CONSOLA_RUNNER_SECRET: '' },
      /consola-host: CONSOLA_RUNNER_SECRET is not set/,
    ],
    [
      'a repository that is not owner/name',
      [],
      { CONSOLA_RUNNER_REPOSITORIES: 'sprocket/catalog-portal,sprocket/..' },
      /consola-host: CONSOLA_RUNNER_REPOSITORIES holds sprocket\/\.\., which is not a repository/,
    ],
    [
      'ws: to a host that is not loopback',
      ['--cell-url', 'ws://eu.cells.sprocket.test/api/runner'],
      {},
      /consola-host: --cell-url may use ws: only to this machine's loopback/,
    ],
    [
      'no API key, so no harness to offer',
      [],
      { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      /consola-host: The runner offers no harness/,
    ],
    ['no sandbox provider to run on', [], {}, /consola-host: No sandbox provider is configured/],
  ])(
    'refuses to start on %s: a message on stderr, exit 1, nothing on stdout, no secret said',
    (_case, extra, env, message) =>
      Effect.gen(function* () {
        const args = [
          'runner',
          ...(extra.includes('--cell-url') ? [] : ['--cell-url', 'ws://127.0.0.1:9/api/runner']),
          '--runner-id',
          'runner-sprocket-1',
          ...extra,
        ];
        const runner = yield* startHost(BIN, args, { ...RUNNER_ENV, ...env });
        expect(yield* runner.exited).toEqual({ code: 1, signal: null });
        expect(runner.printed).toEqual([]);
        expect(runner.stderr()).toMatch(message);
        for (const secret of RUNNER_SECRETS) expect(runner.stderr()).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.runPromise),
    TEST_TIMEOUT_MS,
  );
});

describe('parseRunnerArgs', () => {
  const flags = [
    'runner',
    '--cell-url',
    'wss://eu.cells.sprocket.test/api/runner',
    '--runner-id',
    'r-1',
  ];
  const parse = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = RUNNER_ENV) =>
    Effect.runSync(parseRunnerArgs(argv, env));
  const refusal = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = RUNNER_ENV) =>
    Effect.runSync(Effect.flip(parseRunnerArgs(argv, env)));

  it('reads its flags and environment, with ten idle minutes and an eight-hour cap by default', () => {
    expect(parse(flags)).toEqual({
      cellUrl: 'wss://eu.cells.sprocket.test/api/runner',
      runnerId: 'r-1',
      secret: RUNNER_SECRET,
      offer: { repositories: ['sprocket/catalog-portal'], harnesses: ['claude'] },
      secrets: { gitToken: RUNNER_GIT_TOKEN, apiKeys: { claude: RUNNER_ANTHROPIC_KEY } },
      secretValues: [RUNNER_SECRET, RUNNER_GIT_TOKEN, RUNNER_ANTHROPIC_KEY],
      idleMinutes: 10,
      maxSessionMinutes: DEFAULT_MAX_SESSION_MINUTES,
    });
    expect(DEFAULT_MAX_SESSION_MINUTES).toBe(480);
  });

  it('takes its minutes, both harnesses, and no git token', () => {
    const args = parse([...flags, '--idle-minutes', '2.5', '--max-session-minutes', '30'], {
      ...RUNNER_ENV,
      GIT_TOKEN: '',
      OPENAI_API_KEY: 'sk-openai-sprocket',
    });
    expect(args.idleMinutes).toBe(2.5);
    expect(args.maxSessionMinutes).toBe(30);
    expect(args.offer.harnesses).toEqual(['claude', 'codex']);
    expect(args.secrets.gitToken).toBeUndefined();
    expect(args.secretValues).not.toContain('');
  });

  it('is the command when runner comes first', () => {
    expect(isRunnerCommand(flags)).toBe(true);
    expect(isRunnerCommand(['session', '--dev'])).toBe(false);
  });

  it.each([
    ['no --cell-url', ['runner', '--runner-id', 'r-1'], /--cell-url is required/],
    ['no --runner-id', flags.slice(0, 3), /--runner-id is required/],
    [
      'an http address',
      ['runner', '--cell-url', 'https://eu.cells.sprocket.test', '--runner-id', 'r-1'],
      /wss:/,
    ],
    [
      'credentials in the address',
      ['runner', '--cell-url', 'wss://r:s3cret@eu.cells.sprocket.test', '--runner-id', 'r-1'],
      /credentials/,
    ],
    ['an unknown flag', [...flags, '--verbose'], /--verbose/],
    ['an extra argument', [...flags, 'sprocket'], /sprocket/],
    ['no idle minutes', [...flags, '--idle-minutes', '0'], /--idle-minutes/],
    ['no lifetime', [...flags, '--max-session-minutes', 'x'], /--max-session-minutes/],
  ])('refuses %s as usage', (_case, argv, message) => {
    const error = refusal(argv);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('s3cret');
  });

  it('refuses a secret with a space, without quoting it', () => {
    const error = refusal(flags, { ...RUNNER_ENV, CONSOLA_RUNNER_SECRET: 'sprocket secret 01' });
    expect(error).toBeInstanceOf(StartFailed);
    expect(error.message).toMatch(/printable characters with no space/);
    expect(error.message).not.toContain('sprocket secret');
  });
});

#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The wiring reads the command line, the key file and the folders it is given.
/**
 * `consola-host session`: runs one Consola session's thread and serves it to t3's chat UI.
 *
 *   consola-host session --session-id <id> --harness <claude|codex|opencode|pi|acp> --cwd <dir>
 *     [--port <n, default 7420>] [--bind <addr, default 127.0.0.1>]
 *     --pass-public-key <PEM file> | --dev
 *     [--idle-minutes <n, default 10>] [--state-dir <dir>]
 *
 * `consola-host runner` (below, and `AGENTS.md`): connects to a regional cell and runs each
 * session it is asked for in a sandbox of its own, where the session command runs.
 *
 *   consola-host runner --cell-url <wss://…/api/runner> --runner-id <id>
 *     [--idle-minutes <n, default 10>] [--max-session-minutes <n, default 480>]
 *
 * It prints JSON lines on stdout and nothing else (`HostLine`, `adapters/stdoutEvents.ts`): Track
 * B's runner starts it in a sandbox and reads them. t3's logs and every error go to stderr. It
 * exits 0 after `{"type":"exit","reason":"idle"}`, or on SIGTERM or SIGINT once the session has
 * stopped; 1, with a message on stderr and nothing on stdout, when it cannot start.
 *
 * This is the host's only wiring: `runSession` takes the runtime as a parameter, and the entry at
 * the bottom passes the production one. A test entry (`testing/replaySession.ts`) runs the same
 * command over a replaying runtime; nothing here can reach a test seam.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import type * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import { type SandboxProvider, sandboxesFrom } from '@consola/sandbox';
import { makeCellSocket } from './adapters/cellSocket.ts';
import { type DevAccess, makeDevAccess } from './adapters/devPass.ts';
import { PassKeyInvalid, parsePassKey } from './adapters/passVerifier.ts';
import { type HostListening, listenHost } from './adapters/rpcServer.ts';
import { makeSandboxSessions } from './adapters/sandboxSessions.ts';
import { reportSession, sessionStatusOf, writeHostLine } from './adapters/stdoutEvents.ts';
import { isIdle } from './core/idle.ts';
import {
  cellUrlProblem,
  HARNESS_API_KEYS,
  harnessesFromEnv,
  type RunnerOffer,
  readRepositories,
  type SandboxSecrets,
  scrubSecrets,
} from './core/runnerDecisions.ts';
import type { SessionSpec } from './core/sessionSpec.ts';
import * as ThreadRuntime from './runtime/threadRuntime.ts';

export const DEFAULT_PORT = 7420;
/** Only this machine, unless the caller asks for more: the host never binds wider by itself. */
export const DEFAULT_BIND = '127.0.0.1';

/**
 * Whether `bind` names this machine's loopback only: `localhost`, `::1` or an address in
 * `127.0.0.0/8`. A `--dev` host lets anyone holding the pass it prints in, so it listens nowhere
 * else.
 */
export const isLoopback = (bind: string): boolean =>
  bind === 'localhost' || bind === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(bind);
/** Spec §8.2: a session stops after ten minutes without a turn or a connected client. */
export const DEFAULT_IDLE_MINUTES = 10;
/** The longest a runner lets a session's sandbox run, whatever it does: eight hours. */
export const DEFAULT_MAX_SESSION_MINUTES = 480;

/** The session a `--dev` host serves when no `--session-id` is given. */
export const DEV_SESSION_ID = 'dev-session';

const HARNESSES: ReadonlyArray<SessionSpec['harness']> = [
  'claude',
  'codex',
  'opencode',
  'pi',
  'acp',
];

const USAGE = `Usage:
  consola-host session --session-id <id> --harness <${HARNESSES.join('|')}> --cwd <dir>
    [--port <n, default ${DEFAULT_PORT}; 0 for any free port>] [--bind <address, default ${DEFAULT_BIND}>]
    --pass-public-key <Ed25519 public key, SPKI PEM file> | --dev
    [--idle-minutes <n, default ${DEFAULT_IDLE_MINUTES}>] [--state-dir <dir, default a temporary one>]

  --dev makes a key pair in memory, ignores --pass-public-key, defaults --session-id to
  ${DEV_SESSION_ID}, and prints a pass for the session after "ready".

  consola-host runner --cell-url <wss://…/api/runner, or ws: to loopback> --runner-id <id>
    [--idle-minutes <n, default ${DEFAULT_IDLE_MINUTES}>] [--max-session-minutes <n, default ${DEFAULT_MAX_SESSION_MINUTES}>]

  It reads CONSOLA_RUNNER_SECRET, CONSOLA_RUNNER_REPOSITORIES (owner/name, comma-separated),
  GIT_TOKEN, ANTHROPIC_API_KEY (offers claude) and OPENAI_API_KEY (offers codex).`;

/** The command line did not say what to run. `problem` names what is wrong, never a secret. */
export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

/** The session could not start: a folder, a key file or the address it was given. */
export class StartFailed extends Schema.TaggedError<StartFailed>()('StartFailed', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

/** What `consola-host session` was asked to run. */
export type SessionArgs = {
  readonly spec: SessionSpec;
  readonly port: number;
  readonly bind: string;
  /** `dev`: a key pair made in memory and a pass printed; `key`: the cell's public key file. */
  readonly access:
    | { readonly type: 'dev' }
    | { readonly type: 'key'; readonly publicKeyFile: string };
  /** Minutes without a turn or a client before the host stops by itself (fractions allowed). */
  readonly idleMinutes: number;
  /** Where t3's state and settings live; `null` is a temporary folder, removed at exit. */
  readonly stateDir: string | null;
};

const isHarness = (value: string): value is SessionSpec['harness'] =>
  (HARNESSES as ReadonlyArray<string>).includes(value);

/** Reads `session` and its flags (`argv` without node and the script). */
export const parseSessionArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<SessionArgs, UsageError> =>
  Effect.gen(function* () {
    const refuse = (problem: string) => Effect.fail(new UsageError({ problem }));
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...argv],
          strict: true,
          allowPositionals: true,
          options: {
            'session-id': { type: 'string' },
            harness: { type: 'string' },
            cwd: { type: 'string' },
            port: { type: 'string' },
            bind: { type: 'string' },
            'pass-public-key': { type: 'string' },
            'idle-minutes': { type: 'string' },
            'state-dir': { type: 'string' },
            dev: { type: 'boolean' },
          },
        }),
      catch: (error) =>
        new UsageError({ problem: error instanceof Error ? error.message : String(error) }),
    });
    const [command, ...extra] = parsed.positionals;
    if (command !== 'session') {
      return yield* refuse(
        command === undefined
          ? 'Name the command: consola-host session, or consola-host runner.'
          : `Unknown command ${command}; the command is session or runner.`,
      );
    }
    if (extra.length > 0) return yield* refuse(`Unexpected argument ${extra.join(' ')}.`);

    const values = parsed.values;
    const dev = values.dev === true;
    const sessionId = values['session-id'] ?? (dev ? DEV_SESSION_ID : undefined);
    if (sessionId === undefined || sessionId === '') {
      return yield* refuse('--session-id is required (or --dev).');
    }
    const harness = values.harness;
    if (harness === undefined || !isHarness(harness)) {
      return yield* refuse(`--harness must be one of ${HARNESSES.join(', ')}.`);
    }
    if (values.cwd === undefined || values.cwd === '') return yield* refuse('--cwd is required.');

    const port = values.port ?? String(DEFAULT_PORT);
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) {
      return yield* refuse('--port must be a whole number from 0 to 65535.');
    }
    const bind = values.bind ?? DEFAULT_BIND;
    if (bind === '') return yield* refuse('--bind must name an address.');
    if (dev && !isLoopback(bind)) {
      return yield* refuse(
        `--dev listens only on loopback (127.0.0.1, ::1 or localhost), not on ${bind}.`,
      );
    }
    const idleMinutes = Number(values['idle-minutes'] ?? DEFAULT_IDLE_MINUTES);
    if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
      return yield* refuse('--idle-minutes must be a number of minutes above 0.');
    }
    const publicKeyFile = values['pass-public-key'];
    if (!dev && (publicKeyFile === undefined || publicKeyFile === '')) {
      return yield* refuse('--pass-public-key is required without --dev.');
    }

    const args: SessionArgs = {
      spec: { sessionId, harness, cwd: resolve(values.cwd) },
      port: Number(port),
      bind,
      access: dev || publicKeyFile === undefined ? { type: 'dev' } : { type: 'key', publicKeyFile },
      idleMinutes,
      stateDir: values['state-dir'] === undefined ? null : resolve(values['state-dir']),
    };
    return args;
  });

/** The key every pass is checked against and, with `--dev`, the pass to print. */
type Access = { readonly publicKeyPem: string; readonly devPass: DevAccess | null };

/**
 * The cell's pass key, read and checked before the session starts, so a missing or misconfigured
 * key costs no CLI start. `listenHost` parses it again as it binds.
 */
const readPassKey = (file: string): Effect.Effect<Access, StartFailed | PassKeyInvalid> =>
  Effect.try({
    try: () => readFileSync(file, 'utf8'),
    catch: () => new StartFailed({ problem: `Cannot read the pass public key file ${file}.` }),
  }).pipe(
    Effect.tap(parsePassKey),
    Effect.map((publicKeyPem) => ({ publicKeyPem, devPass: null })),
  );

/** A dev host's key pair and pass, made as it is about to listen, so the pass lasts its time. */
const devAccess = (sessionId: string): Effect.Effect<Access> =>
  makeDevAccess(sessionId).pipe(
    Effect.map((devPass) => ({ publicKeyPem: devPass.publicKeyPem, devPass })),
  );

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const folderMustExist = (cwd: string): Effect.Effect<void, StartFailed> =>
  Effect.suspend(() =>
    isFolder(cwd)
      ? Effect.void
      : Effect.fail(new StartFailed({ problem: `--cwd ${cwd} is not a folder.` })),
  );

/** The innermost message of an error and the errors that caused it (`EADDRINUSE`, say). */
const innermostMessage = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause !== undefined) current = current.cause;
  return current instanceof Error ? current.message : String(current);
};

/**
 * The one human line the host writes as it starts (on stderr, before any CLI runs): what a turn
 * does to the session's folder (`AGENTS.md`, "What a turn does"). Only trusted folders should be
 * given; checking that is the runner's (Track A), not the host's.
 */
export const folderWarning = (cwd: string): string =>
  `consola-host: warning: turns in ${cwd} load its project settings and hooks with no trust ` +
  `prompt (Claude: .claude/settings.json, .claude/settings.local.json), and t3 writes checkpoint ` +
  `refs (refs/t3/orchestration-v2/checkpoints) and objects into its git repository.`;

/** A state folder of the session's own, removed when the session stops. */
const temporaryStateDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'consola-host-state-'))),
  (stateDir) => Effect.sync(() => rmSync(stateDir, { recursive: true, force: true })),
);

/** How often the host asks whether it is idle. */
const IDLE_CHECK_INTERVAL = Duration.seconds(1);

/**
 * Returns once the host is idle (`isIdle`): no client connected and no turn running, with nothing
 * done for `idleMinutes`. A client counts as activity while it is connected, so the idle time runs
 * from the last moment one was; the host counts as active when it becomes ready.
 */
const untilIdle = (
  handle: ThreadRuntime.ThreadHandle,
  listening: HostListening,
  idleMinutes: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let clientSeenAt = yield* Clock.currentTimeMillis;
    while (true) {
      yield* Effect.sleep(IDLE_CHECK_INTERVAL);
      const nowMs = yield* Clock.currentTimeMillis;
      const connectedClients = listening.connectedClients();
      if (connectedClients > 0) clientSeenAt = nowMs;
      const idle = isIdle({
        lastActivityMs: Math.max(handle.lastActivityMs(), clientSeenAt),
        connectedClients,
        turnRunning: sessionStatusOf(handle.snapshot()) === 'working',
        nowMs,
        idleMinutes,
      });
      if (idle) return;
    }
  });

/** Builds the session's runtime over its state folder: `ThreadRuntime.layer` in production. */
export type RuntimeFor = (
  options: ThreadRuntime.ThreadRuntimeOptions,
) => Layer.Layer<ThreadRuntime.ThreadRuntime>;

/**
 * Runs one session until it is idle: opens its thread on `runtimeFor`'s runtime, serves it, prints
 * `ready` (and, with `--dev`, the pass), then `title` and `status` lines as they change, and
 * `exit` when it is idle. Everything it starts (the server, the thread, the provider session and
 * the CLI it runs) stops when it returns or is interrupted.
 */
export const runSession = (
  args: SessionArgs,
  runtimeFor: RuntimeFor,
): Effect.Effect<void, StartFailed | PassKeyInvalid | ThreadRuntime.ThreadRuntimeError> =>
  Effect.gen(function* () {
    const cellKey =
      args.access.type === 'key' ? yield* readPassKey(args.access.publicKeyFile) : null;
    yield* folderMustExist(args.spec.cwd);
    yield* Effect.sync(() => process.stderr.write(`${folderWarning(args.spec.cwd)}\n`));
    const stateDir = args.stateDir ?? (yield* temporaryStateDir);
    const handle = yield* Effect.gen(function* () {
      const runtime = yield* ThreadRuntime.ThreadRuntime;
      return yield* runtime.open(args.spec);
    }).pipe(Effect.provide(runtimeFor({ stateDir })));
    const access = cellKey ?? (yield* devAccess(args.spec.sessionId));
    const listening = yield* listenHost({
      port: args.port,
      host: args.bind,
      sessionId: args.spec.sessionId,
      publicKeyPem: access.publicKeyPem,
      runtime: handle,
    }).pipe(
      Effect.catchTag('HostListenError', (error) =>
        Effect.fail(
          new StartFailed({
            problem: `Cannot listen on ${args.bind}:${args.port}: ${innermostMessage(error.cause)}.`,
          }),
        ),
      ),
    );

    yield* writeHostLine({ type: 'ready', port: listening.port });
    if (access.devPass !== null) {
      yield* writeHostLine({
        type: 'dev-pass',
        pass: access.devPass.pass,
        expiresInSeconds: access.devPass.expiresInSeconds,
      });
    }
    const reporting = yield* reportSession(handle, writeHostLine).pipe(Effect.forkScoped);
    yield* untilIdle(handle, listening, args.idleMinutes);
    yield* Fiber.interrupt(reporting);
    yield* writeHostLine({ type: 'exit', reason: 'idle' });
  }).pipe(Effect.scoped);

/** `consola-host session …`: `argv` parsed, then the session run over `runtimeFor`. */
export const sessionCommand = (
  argv: ReadonlyArray<string>,
  runtimeFor: RuntimeFor,
): Effect.Effect<
  void,
  UsageError | StartFailed | PassKeyInvalid | ThreadRuntime.ThreadRuntimeError
> => parseSessionArgs(argv).pipe(Effect.flatMap((args) => runSession(args, runtimeFor)));

/** What `consola-host runner` was asked to run: its flags, and what it read of its environment. */
export type RunnerArgs = {
  /** The cell's runner socket, checked by `cellUrlProblem`. */
  readonly cellUrl: string;
  readonly runnerId: string;
  /** `CONSOLA_RUNNER_SECRET`, sent in the socket's upgrade only. */
  readonly secret: string;
  /** The repositories it offers and the harnesses its API keys offer. */
  readonly offer: RunnerOffer;
  /** What a sandbox is given: the git token and its harness's key. */
  readonly secrets: SandboxSecrets;
  /** Every secret it holds, taken out of whatever it reports or logs. */
  readonly secretValues: ReadonlyArray<string>;
  /** A session host's idle minutes. */
  readonly idleMinutes: number;
  /** The lifetime cap of a session's sandbox, in minutes. */
  readonly maxSessionMinutes: number;
};

/** The runner's environment, as `process.env` holds it. */
export type RunnerEnv = Readonly<Record<string, string | undefined>>;

/** Printable ASCII with no space, as the cell asks of `RUNNER_SECRET`: it goes in a header. */
const isHeaderSafe = (value: string): boolean => /^[\x21-\x7e]+$/.test(value);

const positiveMinutes = (value: string | undefined, fallback: number): number | null => {
  const minutes = Number(value ?? fallback);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
};

/**
 * Reads `runner`, its flags (`argv` without node and the script) and its environment. A flag that
 * is wrong is a `UsageError`; a variable that is missing or wrong a `StartFailed`. Neither ever
 * quotes a secret.
 */
export const parseRunnerArgs = (
  argv: ReadonlyArray<string>,
  env: RunnerEnv,
): Effect.Effect<RunnerArgs, UsageError | StartFailed> =>
  Effect.gen(function* () {
    const refuse = (problem: string) => Effect.fail(new UsageError({ problem }));
    const startFails = (problem: string) => Effect.fail(new StartFailed({ problem }));
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...argv],
          strict: true,
          allowPositionals: true,
          options: {
            'cell-url': { type: 'string' },
            'runner-id': { type: 'string' },
            'idle-minutes': { type: 'string' },
            'max-session-minutes': { type: 'string' },
          },
        }),
      catch: (error) =>
        new UsageError({ problem: error instanceof Error ? error.message : String(error) }),
    });
    const [command, ...extra] = parsed.positionals;
    if (command !== 'runner') return yield* refuse('The command is runner.');
    if (extra.length > 0) return yield* refuse(`Unexpected argument ${extra.join(' ')}.`);
    const values = parsed.values;
    const cellUrl = values['cell-url'];
    if (cellUrl === undefined || cellUrl === '') return yield* refuse('--cell-url is required.');
    const urlProblem = cellUrlProblem(cellUrl);
    if (urlProblem !== null) return yield* refuse(urlProblem);
    const runnerId = values['runner-id'];
    if (runnerId === undefined || runnerId === '') return yield* refuse('--runner-id is required.');
    const idleMinutes = positiveMinutes(values['idle-minutes'], DEFAULT_IDLE_MINUTES);
    if (idleMinutes === null) {
      return yield* refuse('--idle-minutes must be a number of minutes above 0.');
    }
    const maxSessionMinutes = positiveMinutes(
      values['max-session-minutes'],
      DEFAULT_MAX_SESSION_MINUTES,
    );
    if (maxSessionMinutes === null) {
      return yield* refuse('--max-session-minutes must be a number of minutes above 0.');
    }

    const secret = env.CONSOLA_RUNNER_SECRET ?? '';
    if (secret === '') {
      return yield* startFails(
        'CONSOLA_RUNNER_SECRET is not set: the runner connects to its cell with it.',
      );
    }
    if (!isHeaderSafe(secret)) {
      return yield* startFails('CONSOLA_RUNNER_SECRET must be printable characters with no space.');
    }
    const repositories = readRepositories(env.CONSOLA_RUNNER_REPOSITORIES);
    if (!repositories.ok) return yield* startFails(repositories.problem);
    const harnesses = harnessesFromEnv(env);
    if (harnesses.length === 0) {
      return yield* startFails(
        `The runner offers no harness: set ${HARNESS_API_KEYS.claude} (claude) or ${HARNESS_API_KEYS.codex} (codex).`,
      );
    }
    const gitToken = env.GIT_TOKEN === '' ? undefined : env.GIT_TOKEN;
    const apiKeys = {
      ...(env.ANTHROPIC_API_KEY ? { claude: env.ANTHROPIC_API_KEY } : {}),
      ...(env.OPENAI_API_KEY ? { codex: env.OPENAI_API_KEY } : {}),
    };
    const args: RunnerArgs = {
      cellUrl,
      runnerId,
      secret,
      offer: { repositories: repositories.repositories, harnesses },
      secrets: { gitToken, apiKeys },
      secretValues: [secret, gitToken, ...Object.values(apiKeys)].filter(
        (value): value is string => value !== undefined && value !== '',
      ),
      idleMinutes,
      maxSessionMinutes,
    };
    return args;
  });

/** Another runner with this one's secret said hello to the cell, which closed this one's socket. */
export class RunnerReplaced extends Schema.TaggedError<RunnerReplaced>()('RunnerReplaced', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

/**
 * The sandbox provider a runner starts its sessions on, from its environment, or null when none
 * is configured. Production has none until the E2B provider (Task 6): a runner with none fails at
 * start, and never falls back to a fake.
 */
export type ProviderFor = (env: RunnerEnv) => SandboxProvider | null;

/** Production's providers: none yet (Task 6 adds E2B, from `E2B_API_KEY`). */
export const productionProvider: ProviderFor = () => null;

/**
 * Runs the runner until it is stopped: its sessions (`makeSandboxSessions`) and its socket to the
 * cell (`makeCellSocket`), the cell's messages handed to the sessions. On SIGTERM, or once another
 * runner replaced it, every sandbox is stopped and its end told to the cell while the socket is
 * still open; then the socket closes. It logs to stderr, scrubbed of its secrets, and never its
 * environment; stdout stays empty.
 */
export const runRunner = (
  args: RunnerArgs,
  provider: SandboxProvider,
): Effect.Effect<void, RunnerReplaced> =>
  Effect.gen(function* () {
    const log = (message: string) =>
      Effect.sync(() => {
        process.stderr.write(`consola-host runner: ${scrubSecrets(message, args.secretValues)}\n`);
      });
    const { socket, sessions } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const socket = yield* makeCellSocket({
          url: args.cellUrl,
          secret: args.secret,
          runnerId: args.runnerId,
          offer: args.offer,
          log,
        });
        const sessions = yield* makeSandboxSessions({
          sandboxes: sandboxesFrom(provider),
          offer: args.offer,
          secrets: args.secrets,
          secretValues: args.secretValues,
          idleMinutes: args.idleMinutes,
          maxLifetime: Duration.minutes(args.maxSessionMinutes),
          report: socket.send,
          log,
        });
        return { socket, sessions };
      }),
      // Every sandbox first, its end said on the open socket; the socket last.
      ({ socket, sessions }) => sessions.stopAll.pipe(Effect.andThen(socket.close)),
    );
    yield* log(
      `runner ${args.runnerId} offers ${args.offer.repositories.join(', ')} with ${args.offer.harnesses.join(', ')}; dialling ${args.cellUrl}`,
    );
    yield* socket.connect({
      live: sessions.liveNow,
      onMessage: (message) =>
        message.type === 'session.start'
          ? sessions.start(message)
          : // A stop waits for the sandbox; the socket's next message does not.
            sessions.stop(message.sessionId).pipe(Effect.forkDetach, Effect.asVoid),
    });
    yield* socket.replaced;
    return yield* new RunnerReplaced({
      problem:
        'Another runner connected to the cell with this secret and replaced this one, which has stopped its sandboxes. Run one runner per secret.',
    });
  }).pipe(Effect.scoped);

/**
 * `consola-host runner …`: `argv` and `env` read, a provider from `providerFor`, then the runner
 * run on it. No provider is a start failure.
 */
export const runnerCommand = (
  argv: ReadonlyArray<string>,
  env: RunnerEnv,
  providerFor: ProviderFor,
): Effect.Effect<void, UsageError | StartFailed | RunnerReplaced> =>
  Effect.gen(function* () {
    const args = yield* parseRunnerArgs(argv, env);
    const provider = providerFor(env);
    if (provider === null) {
      return yield* new StartFailed({
        problem:
          'No sandbox provider is configured, so the runner has nowhere to start sessions (the E2B provider is not there yet).',
      });
    }
    return yield* runRunner(args, provider);
  });

/** Whether `argv` asks for the runner rather than a session: its command comes first. */
export const isRunnerCommand = (argv: ReadonlyArray<string>): boolean => argv[0] === 'runner';

/** How long the session (or the runner) may take to stop after a signal before the host gives up. */
const SHUTDOWN_GRACE = Duration.seconds(15);

/** What stderr says when the host stops on a failure. */
const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (Schema.is(UsageError)(error)) return `${error.message}\n\n${USAGE}`;
  if (
    Schema.is(StartFailed)(error) ||
    Schema.is(PassKeyInvalid)(error) ||
    Schema.is(RunnerReplaced)(error)
  ) {
    return error.message;
  }
  return Cause.pretty(cause);
};

/**
 * Runs `program` as the host's process. Every Effect log goes to stderr. SIGTERM and SIGINT
 * interrupt it, which stops everything it started; then the process exits 0 (1, with a message,
 * if stopping takes longer than `SHUTDOWN_GRACE`). It exits 0 when `program` ends, and 1 with
 * a message on stderr when it fails.
 */
export const runHostProcess = <E>(
  program: Effect.Effect<void, E>,
  what: 'session' | 'runner' = 'session',
): void => {
  // The process exits from `teardown` either way, so this timer never keeps it alive.
  const onSignal = () => {
    Effect.runFork(
      Effect.sleep(SHUTDOWN_GRACE).pipe(
        Effect.andThen(
          Effect.sync(() =>
            process.stderr.write(`consola-host: the ${what} did not stop in time.\n`, () =>
              process.exit(1),
            ),
          ),
        ),
      ),
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  NodeRuntime.runMain(program.pipe(Effect.provideService(Logger.LogToStderr, true)), {
    disableErrorReporting: true,
    teardown: (exit) => {
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
        process.exit(0);
        return;
      }
      process.stderr.write(`consola-host: ${describeFailure(exit.cause)}\n`, () => process.exit(1));
    },
  });
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (isRunnerCommand(argv)) {
    runHostProcess(runnerCommand(argv, process.env, productionProvider), 'runner');
  } else {
    runHostProcess(sessionCommand(argv, ThreadRuntime.layer));
  }
}

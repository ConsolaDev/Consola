// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The wiring reads the command line, the key file and the folders it is given, and hands the automations ring the clock and node:crypto's hash.
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
 * This is the host's only wiring: `runSession` takes the runtime as a parameter, and `main`
 * (which the bin, `main.ts`, calls) passes the production one. A test entry (`testing/replaySession.ts`) runs the same
 * command over a replaying runtime; nothing here can reach a test seam.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import type * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import { type SandboxProvider, type Sandboxes, sandboxesFrom } from '@consola/sandbox';
import { makeAgentSteps } from './adapters/agentSteps.ts';
import { type CellLinkAdapter, makeCellLink } from './adapters/cellLink.ts';
import { makeCellSocket } from './adapters/cellSocket.ts';
import { makeCommandSteps } from './adapters/commandSteps.ts';
import { type DevAccess, makeDevAccess } from './adapters/devPass.ts';
import { PassKeyInvalid, parsePassKey } from './adapters/passVerifier.ts';
import { type HostListening, listenHost } from './adapters/rpcServer.ts';
import { makeSandboxSessions, SHUTDOWN_STOP_TIMEOUT } from './adapters/sandboxSessions.ts';
import { reportSession, sessionStatusOf, writeHostLine } from './adapters/stdoutEvents.ts';
import { type AutomationsRing, createAutomationsRing } from './core/automations/ring.ts';
import { isLoopback } from './core/bind.ts';
import { isIdle } from './core/idle.ts';
import {
  cellUrlProblem,
  HARNESS_API_KEYS,
  harnessesFromEnv,
  type RunnerOffer,
  readRepositories,
  type SandboxSecrets,
  scrubSecrets,
  secretValuesOf,
} from './core/runnerDecisions.ts';
import type { SessionSpec } from './core/sessionSpec.ts';
import type { AgentSteps, CommandSteps } from './core/steps/ports.ts';
import * as ThreadRuntime from './runtime/threadRuntime.ts';

export const DEFAULT_PORT = 7420;
/** Only this machine, unless the caller asks for more: the host never binds wider by itself. */
export const DEFAULT_BIND = '127.0.0.1';

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
  GIT_TOKEN, ANTHROPIC_API_KEY (offers claude), OPENAI_API_KEY (offers codex) and E2B_API_KEY
  (its sandboxes' provider).`;

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
export const temporaryStateDir = Effect.acquireRelease(
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

/**
 * What the program does as it begins to stop, whatever stops it (a signal, a replacement, a
 * failure). Under `runHostProcess` it arms the forced exit, `SHUTDOWN_GRACE` later, so stopping
 * that hangs (a sandbox's provider, say) cannot keep the process alive; anywhere else (a test
 * running the program in its own process) it does nothing.
 */
export const HostStopping = Context.Reference<Effect.Effect<void>>('@consola/host/HostStopping', {
  defaultValue: () => Effect.void,
});

/** Arms what the program does as it begins to stop (`HostStopping`). */
const beginStopping = Effect.gen(function* () {
  const stopping = yield* HostStopping;
  yield* stopping;
});

/** Builds the session's runtime over its state folder: `ThreadRuntime.layer` in production. */
export type RuntimeFor = (
  options: ThreadRuntime.ThreadRuntimeOptions,
) => Layer.Layer<ThreadRuntime.ThreadRuntime>;

/**
 * Runs one session until it is idle: opens its thread on `runtimeFor`'s runtime, serves it, prints
 * `ready` (and, with `--dev`, the pass), then `title` and `status` lines as they change, and
 * `exit` when it is idle. Everything it starts (the server, the thread, the provider session and
 * the CLI it runs) stops when it returns or is interrupted, `HostStopping` first.
 */
export const runSession = (
  args: SessionArgs,
  runtimeFor: RuntimeFor,
): Effect.Effect<
  void,
  StartFailed | PassKeyInvalid | ThreadRuntime.ThreadRuntimeError | ThreadRuntime.ThreadStreamEnded
> =>
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
      dev: access.devPass !== null,
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

    // What `ready` says, read before it is written: a retitle after it is the report's to say.
    const said = { status: 'idle' as const, title: handle.snapshot().thread.title };
    yield* writeHostLine({ type: 'ready', port: listening.port });
    if (access.devPass !== null) {
      yield* writeHostLine({
        type: 'dev-pass',
        pass: access.devPass.pass,
        expiresInSeconds: access.devPass.expiresInSeconds,
      });
    }
    const reporting = yield* reportSession(handle, writeHostLine, said).pipe(Effect.forkScoped);
    // Idle, or a thread whose snapshot would go stale (`ended`): the session fails, exit 1.
    yield* Effect.raceFirst(untilIdle(handle, listening, args.idleMinutes), handle.ended);
    yield* Fiber.interrupt(reporting);
    yield* writeHostLine({ type: 'exit', reason: 'idle' });
  }).pipe(
    // However the session ends (idle, a failure, a signal), the forced exit is armed before
    // anything it started is closed, so a stop that hangs cannot keep the process alive.
    Effect.onExit(() => beginStopping),
    Effect.scoped,
  );

/** `consola-host session …`: `argv` parsed, then the session run over `runtimeFor`. */
export const sessionCommand = (
  argv: ReadonlyArray<string>,
  runtimeFor: RuntimeFor,
): Effect.Effect<
  void,
  | UsageError
  | StartFailed
  | PassKeyInvalid
  | ThreadRuntime.ThreadRuntimeError
  | ThreadRuntime.ThreadStreamEnded
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
  /** The values of `RUNNER_SECRET_VARIABLES`, taken out of whatever it reports or logs. */
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
      secretValues: secretValuesOf(env),
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
 * is configured. A runner with none fails at start, and never falls back to a fake.
 */
export type ProviderFor = (env: RunnerEnv) => Promise<SandboxProvider | null>;

/**
 * Production's provider: E2B (`@consola/sandbox/e2b`), on Consola's account, where the
 * `consola-session` template is built (`sandbox-template/README.md`), with `E2B_API_KEY`. The key
 * is read here and handed to the provider, never left for E2B's SDK to find in the process's
 * environment, so it is one of `RUNNER_SECRET_VARIABLES`: scrubbed from everything the runner
 * says, and never given to a sandbox. Without it, none. E2B's provider is loaded here, as a
 * runner starts: a session's host, the same file, never loads E2B's SDK (`boundary.test.ts`).
 */
export const productionProvider: ProviderFor = async (env) => {
  // As it is, so the value the runner scrubs is the one E2B is given.
  const apiKey = env.E2B_API_KEY ?? '';
  if (apiKey.trim() === '') return null;
  const { E2BProvider } = await import('@consola/sandbox/e2b');
  return new E2BProvider({ apiKey });
};

/** The two ports an automation's steps run through. */
export type StepPorts = { readonly agentSteps: AgentSteps; readonly commandSteps: CommandSteps };

/**
 * The automations ring's step ports, on the runner's own sandboxes (`adapters/agentSteps.ts`,
 * `adapters/commandSteps.ts`, "Step sandboxes" in AGENTS.md), or null when the runner cannot run
 * an automation's steps: stage 1 runs agent steps on claude alone, so without its key
 * (`ANTHROPIC_API_KEY`) the runner runs no automations and its `hello` says so.
 *
 * This is the ring's composition point: another runner (a headless one, a test) hands
 * `runRunner` its own ports instead.
 */
export const productionStepPorts = (
  args: RunnerArgs,
  sandboxes: Sandboxes,
  log: (message: string) => Effect.Effect<void>,
): StepPorts | null => {
  if (args.secrets.apiKeys.claude === undefined) return null;
  const common = { sandboxes, secretValues: args.secretValues, log };
  return {
    agentSteps: makeAgentSteps({ ...common, apiKeys: args.secrets.apiKeys }),
    commandSteps: makeCommandSteps(common),
  };
};

/** How a runner gets its step ports from its sandboxes (`productionStepPorts` in production). */
export type StepPortsFor = (
  args: RunnerArgs,
  sandboxes: Sandboxes,
  log: (message: string) => Effect.Effect<void>,
) => StepPorts | null;

/**
 * Runs the runner until it is stopped: its sessions (`makeSandboxSessions`), its socket to the
 * cell (`makeCellSocket`), and, when it has step ports (`stepPortsFor`), its automations ring
 * (`createAutomationsRing`, over `makeCellLink`), the cell's messages handed to each. On SIGTERM,
 * or once another runner replaced it, every running step fails and its run is recorded, every
 * sandbox is stopped and its end told to the cell while the socket is still open; then the socket
 * closes. However it stops, `HostStopping` comes first. It logs to stderr, scrubbed of its
 * secrets, and never its environment; stdout stays empty.
 */
export const runRunner = (
  args: RunnerArgs,
  provider: SandboxProvider,
  stepPortsFor: StepPortsFor = productionStepPorts,
): Effect.Effect<void, RunnerReplaced> =>
  Effect.gen(function* () {
    const writeLog = (message: string): void => {
      process.stderr.write(`consola-host runner: ${scrubSecrets(message, args.secretValues)}\n`);
    };
    const log = (message: string) => Effect.sync(() => writeLog(message));
    const sandboxes = sandboxesFrom(provider);
    const steps = stepPortsFor(args, sandboxes, log);
    const { socket, sessions, link, ring } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const socket = yield* makeCellSocket({
          url: args.cellUrl,
          secret: args.secret,
          runnerId: args.runnerId,
          offer: args.offer,
          automations: steps !== null,
          log,
        });
        let link: CellLinkAdapter | null = null;
        let ring: AutomationsRing | null = null;
        if (steps !== null) {
          link = makeCellLink({ sendNow: socket.sendNow, log: writeLog });
          ring = createAutomationsRing({
            link,
            agentSteps: steps.agentSteps,
            commandSteps: steps.commandSteps,
            now: () => new Date().toISOString(),
            digest: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
            log: writeLog,
          });
        }
        const sessions = yield* makeSandboxSessions({
          sandboxes,
          offer: args.offer,
          secrets: args.secrets,
          secretValues: args.secretValues,
          idleMinutes: args.idleMinutes,
          maxLifetime: Duration.minutes(args.maxSessionMinutes),
          report: socket.send,
          log,
        });
        return { socket, sessions, link, ring };
      }),
      // Every running step's end and every sandbox's first, said on the open socket; the socket
      // last. The steps' sandboxes stop as their ports see the abort, within the shutdown's bound.
      ({ socket, sessions, link, ring }) =>
        Effect.sync(() => {
          ring?.stop();
          link?.close();
        }).pipe(
          Effect.andThen(
            Effect.all(
              [
                sessions.stopAll,
                ring === null
                  ? Effect.void
                  : Effect.promise(() => ring.settled()).pipe(
                      Effect.timeoutOrElse({
                        duration: SHUTDOWN_STOP_TIMEOUT,
                        orElse: () => log("the automations' steps did not stop in time"),
                      }),
                    ),
              ],
              { concurrency: 'unbounded', discard: true },
            ),
          ),
          Effect.andThen(socket.close),
        ),
    );
    // Added last, so the first to run as the scope closes: the forced exit is armed before any
    // sandbox is asked to stop, on a replacement or a failure as on a signal.
    const stopping = yield* HostStopping;
    yield* Effect.addFinalizer(() => stopping);
    yield* log(
      `runner ${args.runnerId} offers ${args.offer.repositories.join(', ')} with ${args.offer.harnesses.join(', ')}, ${ring === null ? 'and runs no automations (no claude key)' : 'and runs automations'}; dialling ${args.cellUrl}`,
    );
    yield* socket.connect({
      live: sessions.liveNow,
      onMessage: (message) => {
        switch (message.type) {
          case 'session.start':
            return sessions.start(message);
          case 'session.stop':
            // A stop waits for the sandbox; the socket's next message does not.
            return sessions.stop(message.sessionId).pipe(Effect.forkDetach, Effect.asVoid);
          case 'github.event':
          case 'run.answered':
          case 'run.refused':
            if (ring === null) {
              // Its hello says it runs no automations, so the cell sends none of these.
              return log(`the cell sent \`${message.type}\`, which this runner does not act on`);
            }
            return Effect.sync(() => ring.receive(message));
          case 'factories':
          case 'github.token':
          case 'github.token.refused':
            if (link === null) {
              return log(`the cell sent \`${message.type}\`, which this runner does not act on`);
            }
            return Effect.sync(() => link.answer(message));
        }
      },
      onConnected: () =>
        Effect.sync(() => {
          link?.connected();
          ring?.connected();
        }),
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
  stepPortsFor: StepPortsFor = productionStepPorts,
): Effect.Effect<void, UsageError | StartFailed | RunnerReplaced> =>
  Effect.gen(function* () {
    const args = yield* parseRunnerArgs(argv, env);
    const provider = yield* Effect.promise(() => providerFor(env));
    if (provider === null) {
      return yield* new StartFailed({
        problem:
          'No sandbox provider is configured, so the runner has nowhere to start sessions: set E2B_API_KEY to the key of the E2B account the consola-session template is built on.',
      });
    }
    return yield* runRunner(args, provider, stepPortsFor);
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
    Schema.is(RunnerReplaced)(error) ||
    Schema.is(ThreadRuntime.ThreadStreamEnded)(error)
  ) {
    return error.message;
  }
  return Cause.pretty(cause);
};

/**
 * Runs `program` as the host's process. Every Effect log goes to stderr. SIGTERM and SIGINT
 * interrupt it, which stops everything it started; then the process exits 0. It exits 0 when
 * `program` ends, and 1 with a message on stderr when it fails. Stopping, from a signal or once
 * `program` says it began to stop (`HostStopping`), may take `SHUTDOWN_GRACE`: past it the process
 * exits 1, saying the session (or runner) did not stop in time.
 */
export const runHostProcess = <E>(
  program: Effect.Effect<void, E>,
  what: 'session' | 'runner' = 'session',
): void => {
  let armed = false;
  // The process exits from `teardown` either way, so this timer never keeps it alive.
  const armForcedExit = () => {
    if (armed) return;
    armed = true;
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
  process.once('SIGTERM', armForcedExit);
  process.once('SIGINT', armForcedExit);
  NodeRuntime.runMain(
    program.pipe(
      Effect.provideService(Logger.LogToStderr, true),
      Effect.provideService(HostStopping, Effect.sync(armForcedExit)),
    ),
    {
      disableErrorReporting: true,
      teardown: (exit) => {
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
          process.exit(0);
          return;
        }
        process.stderr.write(`consola-host: ${describeFailure(exit.cause)}\n`, () =>
          process.exit(1),
        );
      },
    },
  );
};

/**
 * The host's process for `argv`: the runner, or a session on the production runtime. `main.ts`,
 * the bin, calls it once it has loaded this module, its early signal handlers swapped for
 * `runHostProcess`'s.
 */
export const main = (argv: ReadonlyArray<string>): void => {
  if (isRunnerCommand(argv)) {
    runHostProcess(runnerCommand(argv, process.env, productionProvider), 'runner');
  } else {
    runHostProcess(sessionCommand(argv, ThreadRuntime.layer));
  }
};

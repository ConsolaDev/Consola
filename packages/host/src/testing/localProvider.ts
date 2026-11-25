// @effect-diagnostics nodeBuiltinImport:off - Each sandbox is a folder and processes of this machine.
/**
 * A `SandboxProvider` for tests only, whose sandboxes are this machine: a sandbox is a temporary
 * folder, and the session template's start command (`consola-session-start`) is a process of
 * `replaySession.ts`, the session command over a replayed Claude (the `simple` fixture), with the
 * sandbox's variables over the few a local process needs of the test machine's (`PATH`, its home,
 * its temporary folder: `MACHINE_VARIABLES`), so only fake CLIs are found and none of the runner's
 * own variables (its secret, its keys) reaches the sandbox, as none reaches a provider's. It reads
 * the session's id, pass key and idle minutes from the variables the runner gives a sandbox, as
 * the template's start script does, and listens on a free port of loopback, which `exposePort`
 * answers as `http://127.0.0.1:<port>`.
 *
 * `bin.test.ts` runs a runner on it (`replayRunner.ts`), and so does `@consola/cloud-session-e2e`,
 * against the built cell. It need not pass the whole sandbox contract; `sandboxesFrom` takes its
 * answers.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Command,
  type CreateSandboxOptions,
  type ProviderCommand,
  type ProviderSandbox,
  SandboxError,
  type SandboxProvider,
} from '@consola/sandbox';
import { SESSION_START_ARGV, SESSION_TEMPLATE } from '../core/runnerDecisions.ts';
import {
  CHANGES_FILE,
  STEP_CHECKOUT_ARGV,
  STEP_HOST_ARGV,
  STEP_REPO,
  STEP_WORKSPACE,
} from '../core/steps/stepSandbox.ts';

/**
 * The runner's secret variables (`core/runnerDecisions.ts`), for a test outside this package that
 * starts a runner over this provider: `@consola/cloud-session-e2e` keeps the developer's own out
 * of it.
 */
export { RUNNER_SECRET_VARIABLES } from '../core/runnerDecisions.ts';

const REPLAY_SESSION = join(dirname(fileURLToPath(import.meta.url)), 'replaySession.ts');

/** The replay's own arguments: the fixture, and the mode it was recorded in. */
const REPLAY_FIXTURE = ['simple', 'full-access'];

/**
 * What a local process takes of the test machine's environment: where its programs, its home and
 * its temporary files are, and nothing else. The runner's process holds its secret and every key;
 * a sandbox gets only what the runner gives it (`sandboxEnvFor`), over these.
 */
export const MACHINE_VARIABLES: ReadonlyArray<string> = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
];

/** `MACHINE_VARIABLES` from `machine`, the sandbox's variables over them. */
const localProcessEnv = (
  machine: NodeJS.ProcessEnv,
  sandbox: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of MACHINE_VARIABLES) {
    const value = machine[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...sandbox };
};

/** What the provider started, for a test to check that nothing outlives its sandbox. */
export type LocalSandboxRecord = {
  readonly id: string;
  readonly folder: string;
  /** The pids of every process started in it. */
  readonly pids: number[];
  /** The variables the sandbox was made with. */
  readonly env: Readonly<Record<string, string>>;
  /** Each command started in it: its argv and its own variables. */
  readonly commands: Array<{
    readonly argv: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  }>;
  /** What the step tools' server answered each call `steps.toolCalls` made, in order. */
  readonly toolAnswers: unknown[];
  stopped: boolean;
};

/** One call of a step tool, as an agent would make it through MCP. */
export type LocalToolCall = { readonly name: string; readonly arguments: unknown };

/**
 * How a step's sandbox behaves (`adapters/agentSteps.ts`, `commandSteps.ts`). The checkout script
 * makes the repository's folder, and, asked for a pull request's changes, writes `changes`. The
 * step's host is `replaySession.ts` over `fixture`, recorded in `mode`; before it starts, the real
 * step tools' server (`main.ts step-tools`) takes `toolCalls` against the step's folder, as the
 * agent would during its turn, and `tamper` may then change the folder, as an agent with a shell
 * could. `bash` runs as itself, in the sandbox's folder.
 */
export type LocalStepsOptions = {
  readonly fixture?: string;
  readonly mode?: string;
  readonly toolCalls?: ReadonlyArray<LocalToolCall>;
  readonly tamper?: (stepFolder: string) => void;
  /** The checkout fails, printing this as its `clone-failed` message (with what git said). */
  readonly checkoutFails?: string;
  /** What the checkout writes as a pull request's changes; a line saying they are missing when absent. */
  readonly changes?: string;
};

export type LocalProviderOptions = {
  /** Every sandbox's `stop` never returns and stops nothing, as a provider that hangs would. */
  readonly stopHangsForTests?: boolean;
  /** No sandbox's create ever returns, as a provider whose network call hangs. */
  readonly createHangsForTests?: boolean;
  /** How a step's sandbox behaves. */
  readonly steps?: LocalStepsOptions;
};

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

/**
 * The real step tools' server in `folder`, given `calls` as an MCP client gives them: initialize,
 * then each call, then its stdin closed. Answers each call's result, in order.
 */
const callStepTools = (
  folder: string,
  env: Record<string, string>,
  calls: ReadonlyArray<LocalToolCall>,
  pids: number[],
): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, 'step-tools', '--folder', folder], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) pids.push(child.pid);
    const answers = new Map<number, unknown>();
    let buffered = '';
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffered.slice(0, newline)) as { id?: number; result?: unknown };
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (typeof message.id === 'number' && message.id > 0)
          answers.set(message.id, message.result);
        if (answers.size === calls.length) child.stdin.end();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`The step tools' server exited ${code}: ${stderr}`));
      else resolve(calls.map((_, index) => answers.get(index + 1)));
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    calls.forEach((call, index) =>
      send({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      }),
    );
    if (calls.length === 0) child.stdin.end();
  });

export class LocalProvider implements SandboxProvider {
  readonly sandboxes: LocalSandboxRecord[] = [];
  private readonly options: LocalProviderOptions;
  /** The handle each sandbox was made with, by its id, for `attach` and `stop` by id. */
  private readonly handles = new Map<string, LocalSandbox>();

  constructor(options: LocalProviderOptions = {}) {
    this.options = options;
  }

  async create(options: CreateSandboxOptions): Promise<ProviderSandbox> {
    if (this.options.createHangsForTests === true) return new Promise(() => undefined);
    if (options.template !== SESSION_TEMPLATE) {
      throw new SandboxError('not-found', `There is no template named ${options.template}.`);
    }
    const record: LocalSandboxRecord = {
      id: `local-${this.sandboxes.length + 1}`,
      folder: mkdtempSync(join(tmpdir(), 'consola-local-sandbox-')),
      pids: [],
      env: { ...options.env },
      commands: [],
      toolAnswers: [],
      stopped: false,
    };
    this.sandboxes.push(record);
    const sandbox = new LocalSandbox(
      record,
      { ...options.env },
      this.options.stopHangsForTests === true,
      this.options.steps ?? {},
    );
    this.handles.set(record.id, sandbox);
    return sandbox;
  }

  /** The handle `create` made: a local sandbox's processes are this process's children. */
  async attach(sandboxId: string): Promise<ProviderSandbox> {
    const sandbox = this.handles.get(sandboxId);
    if (sandbox === undefined || sandbox.stopped) {
      throw new SandboxError('not-found', `There is no sandbox ${sandboxId} to attach to.`);
    }
    return sandbox;
  }

  /** Stops it through the handle `create` made; one it never made, or stopped, is nothing. */
  async stop(sandboxId: string): Promise<void> {
    await this.handles.get(sandboxId)?.stop();
  }
}

/** A command still running, and whether the runner ended it (so its end is a signal's, null). */
type Running = {
  readonly child: ChildProcess;
  readonly ended: Promise<number | null>;
  killed: boolean;
};

class LocalSandbox implements ProviderSandbox {
  readonly id: string;
  private readonly record: LocalSandboxRecord;
  private readonly env: Readonly<Record<string, string>>;
  private readonly running = new Set<Running>();
  private readonly stopHangs: boolean;
  private readonly steps: LocalStepsOptions;

  constructor(
    record: LocalSandboxRecord,
    env: Readonly<Record<string, string>>,
    stopHangs: boolean,
    steps: LocalStepsOptions,
  ) {
    this.id = record.id;
    this.record = record;
    this.env = env;
    this.stopHangs = stopHangs;
    this.steps = steps;
  }

  /** A sandbox path in this sandbox's folder: `/workspace/…` where a real sandbox has it. */
  private mapped(value: string): string {
    return value === STEP_WORKSPACE || value.startsWith(`${STEP_WORKSPACE}/`)
      ? this.pathOf(value)
      : value;
  }

  /** The argv a step's command runs as here, after anything it does first. */
  private async stepArgv(
    argv: ReadonlyArray<string>,
    env: Record<string, string>,
  ): Promise<string[] | null> {
    const is = (wanted: ReadonlyArray<string>) =>
      argv.length === wanted.length && argv.every((arg, index) => arg === wanted[index]);
    if (is(STEP_CHECKOUT_ARGV)) {
      const repo = this.pathOf(STEP_REPO);
      if (this.steps.checkoutFails !== undefined) {
        const line = JSON.stringify({
          type: 'exit',
          reason: 'clone-failed',
          message: `${this.steps.checkoutFails} ${env.GIT_TOKEN ?? ''}`.trim(),
        });
        return ['-e', `process.stdout.write(${JSON.stringify(`${line}\n`)}); process.exit(1)`];
      }
      mkdirSync(repo, { recursive: true });
      if (env.CONSOLA_CHECKOUT_BASE_REF !== undefined) {
        const changes = this.pathOf(CHANGES_FILE);
        mkdirSync(dirname(changes), { recursive: true });
        writeFileSync(
          changes,
          this.steps.changes ??
            `The changes of pull request #${env.CONSOLA_CHECKOUT_PULL_REQUEST ?? ''} could not be read: its base branch ${env.CONSOLA_CHECKOUT_BASE_REF} could not be fetched.\n`,
        );
      }
      return ['-e', 'process.exit(0)'];
    }
    if (is(STEP_HOST_ARGV)) {
      const folder = this.mapped(env.CONSOLA_STEP_FOLDER ?? '');
      mkdirSync(folder, { recursive: true });
      mkdirSync(this.pathOf(STEP_REPO), { recursive: true });
      const answers = await callStepTools(
        folder,
        env,
        this.steps.toolCalls ?? [],
        this.record.pids,
      );
      this.record.toolAnswers.push(...answers);
      this.steps.tamper?.(folder);
      const keyFile = this.pathOf('pass-public-key.pem');
      writeFileSync(keyFile, env.CONSOLA_PASS_PUBLIC_KEY ?? '');
      return [
        REPLAY_SESSION,
        this.steps.fixture ?? 'simple',
        this.steps.mode ?? 'full-access',
        'session',
        '--pass-public-key',
        keyFile,
        '--session-id',
        env.CONSOLA_SESSION_ID ?? '',
        '--harness',
        'claude',
        '--port',
        '0',
        '--idle-minutes',
        env.CONSOLA_SESSION_IDLE_MINUTES ?? '10',
      ];
    }
    return null;
  }

  get stopped(): boolean {
    return this.record.stopped;
  }

  private ensureRunning(): void {
    if (this.record.stopped) {
      throw new SandboxError('not-running', `Local sandbox ${this.id} has stopped.`);
    }
  }

  private pathOf(path: string): string {
    return join(this.record.folder, path);
  }

  async start(command: Command): Promise<ProviderCommand> {
    this.ensureRunning();
    const env = localProcessEnv(process.env, { ...this.env, ...command.env });
    this.record.commands.push({ argv: [...command.argv], env: { ...(command.env ?? {}) } });
    const isSessionStart =
      command.argv.length === SESSION_START_ARGV.length &&
      command.argv.every((arg, index) => arg === SESSION_START_ARGV[index]);
    const isPrintenv = command.argv.length === 1 && command.argv[0] === 'printenv';
    const isBash = command.argv[0] === 'bash';
    const keyFile = this.pathOf('pass-public-key.pem');
    if (isSessionStart) writeFileSync(keyFile, env.CONSOLA_PASS_PUBLIC_KEY ?? '');
    const stepArgv = await this.stepArgv(command.argv, env);
    this.ensureRunning();
    // `bash` runs as itself, its folder and the paths its variables name in this sandbox's folder.
    const program = isBash ? '/bin/bash' : process.execPath;
    const cwd = isBash ? this.mapped(command.cwd ?? STEP_WORKSPACE) : this.record.folder;
    if (isBash) mkdirSync(cwd, { recursive: true });
    const processEnv = isBash
      ? Object.fromEntries(Object.entries(env).map(([name, value]) => [name, this.mapped(value)]))
      : env;
    // `printenv` prints the command's variables, a line each, as a sandbox's would. Anything else
    // but the start scripts is not on this template, as in a shell: exit 127.
    const argv = isBash
      ? command.argv.slice(1)
      : stepArgv !== null
        ? stepArgv
        : isSessionStart
          ? [
              REPLAY_SESSION,
              ...REPLAY_FIXTURE,
              'session',
              '--pass-public-key',
              keyFile,
              '--session-id',
              env.CONSOLA_SESSION_ID ?? '',
              '--harness',
              'claude',
              '--port',
              '0',
              '--idle-minutes',
              env.CONSOLA_SESSION_IDLE_MINUTES ?? '10',
            ]
          : isPrintenv
            ? [
                '-e',
                'for (const [name, value] of Object.entries(process.env)) process.stdout.write(`${name}=${value}\\n`);',
              ]
            : [
                '-e',
                `process.stderr.write(${JSON.stringify(`${command.argv[0]}: not found\n`)}); process.exit(127)`,
              ];
    const child = spawn(program, argv, {
      cwd,
      env: processEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) this.record.pids.push(child.pid);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => command.onStdout?.(chunk));
    child.stderr?.on('data', (chunk: string) => command.onStderr?.(chunk));
    let resolveEnded: (code: number | null) => void = () => undefined;
    const entry: Running = {
      child,
      ended: new Promise<number | null>((resolve) => {
        resolveEnded = resolve;
      }),
      killed: false,
    };
    // `close` comes once its output is all read, so every chunk reaches a listener first.
    child.on('close', (code, signal) =>
      resolveEnded(entry.killed || signal !== null ? null : code),
    );
    child.on('error', () => resolveEnded(127));
    this.running.add(entry);
    void entry.ended.then(() => this.running.delete(entry));
    return {
      wait: () => entry.ended,
      kill: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        entry.killed = true;
        child.kill('SIGTERM');
        await entry.ended;
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.ensureRunning();
    try {
      return new Uint8Array(readFileSync(this.pathOf(path)));
    } catch {
      throw new SandboxError('not-found', `There is no file at ${path}.`);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.ensureRunning();
    mkdirSync(dirname(this.pathOf(path)), { recursive: true });
    writeFileSync(this.pathOf(path), content);
  }

  async exposePort(port: number): Promise<string> {
    this.ensureRunning();
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.stopHangs) return new Promise<void>(() => undefined);
    if (this.record.stopped) return;
    this.record.stopped = true;
    // The session host stops on SIGTERM within its own grace, as a sandbox's would be stopped.
    const ending = [...this.running].map(async (entry) => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.killed = true;
        entry.child.kill('SIGTERM');
      }
      await entry.ended;
    });
    await Promise.all(ending);
    rmSync(this.record.folder, { recursive: true, force: true });
  }
}

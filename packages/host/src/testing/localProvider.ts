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
 * `bin.test.ts` runs a runner on it (`replayRunner.ts`), and Task 9's end-to-end test reuses it.
 * It need not pass the whole sandbox contract; `sandboxesFrom` takes its answers.
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
  stopped: boolean;
};

export type LocalProviderOptions = {
  /** Every sandbox's `stop` never returns and stops nothing, as a provider that hangs would. */
  readonly stopHangsForTests?: boolean;
};

export class LocalProvider implements SandboxProvider {
  readonly sandboxes: LocalSandboxRecord[] = [];
  private readonly options: LocalProviderOptions;

  constructor(options: LocalProviderOptions = {}) {
    this.options = options;
  }

  async create(options: CreateSandboxOptions): Promise<ProviderSandbox> {
    if (options.template !== SESSION_TEMPLATE) {
      throw new SandboxError('not-found', `There is no template named ${options.template}.`);
    }
    const record: LocalSandboxRecord = {
      id: `local-${this.sandboxes.length + 1}`,
      folder: mkdtempSync(join(tmpdir(), 'consola-local-sandbox-')),
      pids: [],
      stopped: false,
    };
    this.sandboxes.push(record);
    return new LocalSandbox(record, { ...options.env }, this.options.stopHangsForTests === true);
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

  constructor(
    record: LocalSandboxRecord,
    env: Readonly<Record<string, string>>,
    stopHangs: boolean,
  ) {
    this.id = record.id;
    this.record = record;
    this.env = env;
    this.stopHangs = stopHangs;
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
    const isSessionStart =
      command.argv.length === SESSION_START_ARGV.length &&
      command.argv.every((arg, index) => arg === SESSION_START_ARGV[index]);
    const isPrintenv = command.argv.length === 1 && command.argv[0] === 'printenv';
    const keyFile = this.pathOf('pass-public-key.pem');
    if (isSessionStart) writeFileSync(keyFile, env.CONSOLA_PASS_PUBLIC_KEY ?? '');
    // `printenv` prints the command's variables, a line each, as a sandbox's would. Anything else
    // but the start script is not on this template, as in a shell: exit 127.
    const argv = isSessionStart
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
    const child = spawn(process.execPath, argv, {
      cwd: this.record.folder,
      env,
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

import { Sandbox } from 'e2b';
import type { SandboxOpts } from 'e2b';

/**
 * The few parts of E2B's SDK the provider uses, shaped as the SDK takes them. The provider
 * decides every option it passes, so its tests stand in for this with no network and check
 * exactly what E2B would have been asked; `e2bApi` is the real one, which only adds the key.
 */
export interface E2BApi {
  create(
    template: string,
    options: Pick<SandboxOpts, 'envs' | 'timeoutMs' | 'lifecycle' | 'network'>,
  ): Promise<E2BSandbox>;
  /** `timeoutMs` as E2B's connect takes it: it only ever lengthens a running sandbox's life. */
  connect(sandboxId: string, options: { timeoutMs: number }): Promise<E2BSandbox>;
  getInfo(sandboxId: string): Promise<{ state: 'running' | 'paused' }>;
  /** True when it stopped the sandbox, false when there was none to stop. */
  kill(sandboxId: string): Promise<boolean>;
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
}

/** One E2B sandbox, as the provider uses it. */
export interface E2BSandbox {
  readonly sandboxId: string;
  /** Starts a command in the background, resolving once it runs. */
  startCommand(cmd: string, options: E2BCommandOptions): Promise<E2BCommandHandle>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /** Worked out locally, with no request: `7420-<id>.e2b.app`. */
  getHost(port: number): string;
  kill(): Promise<boolean>;
  isRunning(): Promise<boolean>;
}

export interface E2BCommandOptions {
  /** The executable and its arguments; E2B adds the command line as the last one. */
  readonly shell: readonly string[];
  readonly cwd?: string;
  readonly envs?: Record<string, string>;
  readonly onStdout: (data: string) => void;
  readonly onStderr: (data: string) => void;
  /** False: `sandboxesFrom` keeps the output, when it is to be kept. */
  readonly retainOutput: false;
  /** 0: no limit. E2B's own default ends a command after a minute. */
  readonly timeoutMs: 0;
}

export interface E2BCommandHandle {
  /** Resolves when it exits 0; rejects with a `CommandExitError` for any other exit. */
  wait(): Promise<unknown>;
  /** SIGKILL. True when it killed the command, false when there was none. */
  kill(): Promise<boolean>;
  /** Stops listening, leaving the command as it is. */
  disconnect(): Promise<void>;
}

/** E2B's SDK, with `apiKey` on every request. */
export function e2bApi(apiKey: string): E2BApi {
  const auth = { apiKey };
  return {
    create: async (template, options) =>
      wrap(await Sandbox.create(template, { ...options, ...auth })),
    connect: async (sandboxId, options) =>
      wrap(await Sandbox.connect(sandboxId, { ...options, ...auth })),
    getInfo: (sandboxId) => Sandbox.getInfo(sandboxId, auth),
    kill: (sandboxId) => Sandbox.kill(sandboxId, auth),
    setTimeout: (sandboxId, timeoutMs) => Sandbox.setTimeout(sandboxId, timeoutMs, auth),
  };
}

function wrap(sandbox: Sandbox): E2BSandbox {
  return {
    sandboxId: sandbox.sandboxId,
    startCommand: (cmd, options) =>
      sandbox.commands.run(cmd, { ...options, shell: [...options.shell], background: true }),
    readFile: (path) => sandbox.files.read(path, { format: 'bytes' }),
    writeFile: async (path, content) => {
      await sandbox.files.write(path, content);
    },
    getHost: (port) => sandbox.getHost(port),
    kill: () => sandbox.kill(),
    isRunning: () => sandbox.isRunning(),
  };
}

import { SandboxNotRunningError } from 'e2b';
import type {
  ProviderCommand,
  ProviderKeepAlive,
  ProviderSandbox,
  SandboxProvider,
} from '../../application/ports';
import { SandboxError } from '../../domain/errors';
import type { Command, CreateSandboxOptions } from '../../domain/sandbox';
import { commandLineOf } from './commandLine';
import { e2bApi } from './e2bApi';
import type { E2BApi, E2BCommandHandle, E2BSandbox } from './e2bApi';
import { exitCodeOf, hasStatus, translate } from './errors';

export interface E2BProviderOptions {
  /**
   * Consola's E2B API key, from configuration (`E2B_API_KEY`), handed over where the program
   * wires itself together. It is never committed, and never appears in a message.
   */
  readonly apiKey: string;
}

/**
 * E2B's connect sets a running sandbox's timeout only when the one it is given is longer, and
 * without one it applies E2B's default of five minutes. One second never lengthens a sandbox's
 * life, so attaching leaves its lifetime as it was: a lifetime is a hard maximum.
 */
const ATTACH_TIMEOUT_MS = 1000;

/**
 * Sandboxes on E2B, on Consola's own account. It translates and decides nothing:
 * `sandboxesFrom` has checked every request. A sandbox's lifetime is E2B's timeout, and a
 * sandbox whose timeout runs out is killed, never paused, so a runner that dies leaves nothing
 * running past it. It renews lifetimes (`keepAlive`); pausing and snapshots, which E2B also
 * has, wait for code that needs them.
 */
export class E2BProvider implements SandboxProvider {
  readonly keepAlive: ProviderKeepAlive;
  private readonly api: E2BApi;
  private readonly fail: (error: unknown, gone?: 'not-running' | 'not-found') => SandboxError;

  /** `api` stands in for E2B's SDK in tests; left out, it is the real one. */
  constructor(options: E2BProviderOptions, api?: E2BApi) {
    const apiKey = options?.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new SandboxError('invalid', 'The E2B provider needs an API key (E2B_API_KEY).');
    }
    this.api = api ?? e2bApi(apiKey);
    this.fail = (error, gone) => translate(error, apiKey, gone);
    this.keepAlive = {
      renew: async (sandboxId, lifetimeSeconds) => {
        try {
          await this.api.setTimeout(sandboxId, lifetimeSeconds * 1000);
        } catch (error) {
          throw this.fail(error);
        }
      },
    };
  }

  async create(options: CreateSandboxOptions): Promise<ProviderSandbox> {
    const { template, env, lifetimeSeconds, publicPorts } = options;
    let inner: E2BSandbox;
    try {
      inner = await this.api.create(template, {
        ...(env !== undefined && { envs: { ...env } }),
        ...(lifetimeSeconds !== undefined && { timeoutMs: lifetimeSeconds * 1000 }),
        // E2B kills on timeout today; saying so keeps it that way if its default changes.
        lifecycle: { onTimeout: 'kill' },
        // Locked unless asked: E2B then asks every request to a port for its traffic token in a
        // header. Said either way, so a change of E2B's default changes nothing here.
        network: { allowPublicTraffic: publicPorts === true },
      });
    } catch (error) {
      throw this.fail(error);
    }
    return new E2BSandboxHandle(inner, this.fail);
  }

  async attach(sandboxId: string): Promise<ProviderSandbox> {
    let state: 'running' | 'paused';
    try {
      ({ state } = await this.api.getInfo(sandboxId));
    } catch (error) {
      throw this.unreached(sandboxId, error);
    }
    // Connecting would resume a paused sandbox, for one second: attaching never resumes.
    if (state !== 'running') {
      throw new SandboxError('not-running', `Sandbox ${sandboxId} is paused.`);
    }
    try {
      const inner = await this.api.connect(sandboxId, { timeoutMs: ATTACH_TIMEOUT_MS });
      return new E2BSandboxHandle(inner, this.fail);
    } catch (error) {
      throw this.unreached(sandboxId, error);
    }
  }

  async stop(sandboxId: string): Promise<void> {
    try {
      await this.api.kill(sandboxId);
    } catch (error) {
      // E2B answers 400 for an id that was never a sandbox's: there is nothing to stop.
      if (hasStatus(error, 400)) return;
      throw this.fail(error);
    }
  }

  /** A failure reaching a sandbox by its id. E2B answers 400 for an id that was never one. */
  private unreached(sandboxId: string, error: unknown): SandboxError {
    if (hasStatus(error, 400)) {
      return new SandboxError('not-found', `There is no sandbox ${sandboxId}.`);
    }
    return this.fail(error, 'not-found');
  }
}

/** A command still running in a sandbox, which the sandbox's stop ends. */
interface Running {
  end(): void;
}

class E2BSandboxHandle implements ProviderSandbox {
  readonly id: string;
  /** Set by this handle's own stop: from then on it refuses work without asking E2B. */
  private stopped = false;
  private killed = false;
  private killing: Promise<void> | null = null;
  private readonly running = new Set<Running>();

  constructor(
    private readonly inner: E2BSandbox,
    private readonly fail: (error: unknown) => SandboxError,
  ) {
    this.id = inner.sandboxId;
  }

  async start(command: Command): Promise<ProviderCommand> {
    this.ensureRunning();
    const { shell, cmd } = commandLineOf(command.argv);
    // Once the command has ended, as far as its caller knows, nothing more reaches its listeners.
    let over = false;
    const deliver =
      (listener: ((chunk: string) => void) | undefined) =>
      (data: string): void => {
        if (!over) listener?.(data);
      };
    let handle: E2BCommandHandle;
    try {
      handle = await this.inner.startCommand(cmd, {
        shell,
        ...(command.cwd !== undefined && { cwd: command.cwd }),
        ...(command.env !== undefined && { envs: { ...command.env } }),
        onStdout: deliver(command.onStdout),
        onStderr: deliver(command.onStderr),
        retainOutput: false,
        timeoutMs: 0,
      });
    } catch (error) {
      throw this.fail(error);
    }

    let endWithSandbox = (): void => undefined;
    const sandboxStopped = new Promise<null>((resolve) => {
      endWithSandbox = () => resolve(null);
    });
    const entry: Running = {
      end: () => {
        over = true;
        endWithSandbox();
        handle.disconnect().catch(() => undefined);
      },
    };
    const exited = handle.wait().then(
      () => 0,
      (error: unknown) => this.exitOf(error),
    );
    const result = Promise.race([exited, sandboxStopped]).finally(() => {
      over = true;
      this.running.delete(entry);
    });
    // A command nobody waits for must not leave its failure unhandled; whoever waits sees it.
    result.catch(() => undefined);
    this.running.add(entry);
    // The sandbox may have stopped while the command started.
    if (this.stopped) entry.end();

    return {
      wait: () => result,
      kill: async () => {
        if (over || this.stopped) return;
        try {
          await handle.kill();
        } catch (error) {
          // A command whose sandbox is gone has ended already, and killing it does nothing.
          const failure = this.fail(error);
          if (failure.code !== 'not-running') throw failure;
        }
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.ensureRunning();
    try {
      return new Uint8Array(await this.inner.readFile(path));
    } catch (error) {
      throw this.fail(error);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.ensureRunning();
    try {
      await this.inner.writeFile(path, content);
    } catch (error) {
      throw this.fail(error);
    }
  }

  async exposePort(port: number): Promise<string> {
    // E2B works the address out locally, so only this handle's own note can refuse it.
    this.ensureRunning();
    return `https://${this.inner.getHost(port)}`;
  }

  stop(): Promise<void> {
    this.stopped = true;
    for (const command of this.running) command.end();
    this.running.clear();
    if (this.killed) return Promise.resolve();
    // A kill that fails is forgotten, so the next stop tries again.
    this.killing ??= this.inner.kill().then(
      () => {
        this.killed = true;
      },
      (error: unknown) => {
        this.killing = null;
        const failure = this.fail(error);
        // Gone already, by its timeout or from elsewhere: stopped is what was asked.
        if (failure.code === 'not-running' || failure.code === 'not-found') {
          this.killed = true;
          return;
        }
        throw failure;
      },
    );
    return this.killing;
  }

  private ensureRunning(): void {
    if (this.stopped) throw new SandboxError('not-running', `Sandbox ${this.id} has stopped.`);
  }

  /**
   * How a command that did not exit 0 ended: its exit code, or null when a signal or its
   * sandbox stopping ended it. Anything else is a failure to report.
   */
  private async exitOf(error: unknown): Promise<number | null> {
    const code = exitCodeOf(error);
    if (code !== undefined) return code;
    // This handle's own stop disconnected it: it ended with the sandbox, so ask nothing.
    if (this.stopped || error instanceof SandboxNotRunningError) return null;
    // The stream broke without saying why: it ended with its sandbox when that is gone.
    const running = await this.inner.isRunning().catch(() => undefined);
    if (running === false) return null;
    throw this.fail(error);
  }
}

import { CAPABILITY_ABILITIES, SANDBOX_CAPABILITIES } from '../domain/capabilities';
import type { SandboxCapability } from '../domain/capabilities';
import { asSandboxError, SandboxError } from '../domain/errors';
import {
  commandProblem,
  createOptionsProblem,
  exitCodeProblem,
  exposedUrlProblem,
  lifetimeProblem,
  nameProblem,
  pathProblem,
  portProblem,
  sandboxIdProblem,
  templateProblem,
} from '../domain/rules';
import type { Command, CommandResult, CreateSandboxOptions, ExposedPort } from '../domain/sandbox';
import type { ProviderCommand, ProviderSandbox, SandboxProvider } from './ports';

/** Sandboxes from one provider: what code that runs work in sandboxes holds. */
export interface Sandboxes {
  /** The capabilities the provider has, in `SANDBOX_CAPABILITIES` order. */
  readonly capabilities: readonly SandboxCapability[];
  create(options: CreateSandboxOptions): Promise<Sandbox>;
  /**
   * Creates a sandbox, hands it to `use`, and stops it once `use` settles, whether it returned
   * or threw. When both `use` and the stop fail, it rejects with an `AggregateError` holding
   * the two, so a sandbox left running is never silent.
   */
  withSandbox<T>(options: CreateSandboxOptions, use: (sandbox: Sandbox) => Promise<T>): Promise<T>;
  /**
   * A handle on a running sandbox, by its id, from this process or another: how a runner that
   * restarted reaches the sandboxes it started. Its lifetime stays as it was. Rejects with
   * `not-found` when there is no such sandbox, or it has stopped, and `not-running` when it is
   * paused (resume it with `pausing`).
   */
  attach(sandboxId: string): Promise<Sandbox>;
  /**
   * Stops the sandbox with this id, wherever it was started: how a runner that restarted stops
   * what one that died left running. Stopping one that has stopped, or never was, does nothing.
   * A handle on it in this process is not told, so where there is one, stop through it.
   */
  stop(sandboxId: string): Promise<void>;
  /** Present when the provider can pause and resume sandboxes. */
  readonly pausing?: Pausing;
  /** Present when the provider can save a sandbox as a template. */
  readonly snapshots?: Snapshots;
  /** Present when the provider can renew a sandbox's lifetime. */
  readonly keepAlive?: KeepAlive;
}

/** One running sandbox. Once it has stopped, or is paused, every call but `stop` is refused. */
export interface Sandbox {
  readonly id: string;
  /** Runs `command` to its end. A non-zero exit is a result, never a rejection. */
  run(command: Command): Promise<CommandResult>;
  /** Starts `command` and resolves once it runs, for work that goes on in the background. */
  start(command: Command): Promise<RunningCommand>;
  readFile(path: string): Promise<Uint8Array>;
  /** The file decoded as UTF-8. */
  readTextFile(path: string): Promise<string>;
  /** Writes the file whole (a string as UTF-8), creating missing folders. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  exposePort(port: number): Promise<ExposedPort>;
  /** Stops the sandbox. Calling it again, or while it stops, waits for the same stop. */
  stop(): Promise<void>;
}

export interface RunningCommand {
  /** Settles when the command ends. Asking again returns the same answer. */
  wait(): Promise<CommandResult>;
  /** Ends the command; `wait` then gives a null exit code. Killing one that ended does nothing. */
  kill(): Promise<void>;
}

export interface Pausing {
  /** Pauses `sandbox`. The handle refuses work from then on; `resume` gives a new one. */
  pause(sandbox: Sandbox): Promise<void>;
  /** Resumes a paused sandbox by its id, from this process or another. */
  resume(sandboxId: string): Promise<Sandbox>;
}

export interface Snapshots {
  /** Saves `sandbox`'s files as a template, and returns its name for `create`. */
  snapshot(sandbox: Sandbox): Promise<string>;
  /** Removes a template `snapshot` made, so it costs nothing more. Removing one that is gone does nothing. */
  remove(template: string): Promise<void>;
}

export interface KeepAlive {
  /**
   * Gives `sandbox` `lifetimeSeconds` more from now: it stops on its own that long from now
   * unless renewed again. A runner renews well before that runs out, for as long as it is
   * alive, so a runner that dies takes its sandboxes with it soon after.
   */
  renew(sandbox: Sandbox, lifetimeSeconds: number): Promise<void>;
}

/**
 * Sandboxes from `provider`. Every request is checked against the rules before the provider
 * sees it, and every failure comes back as a `SandboxError`.
 */
export function sandboxesFrom(provider: SandboxProvider): Sandboxes {
  const handles = new WeakMap<Sandbox, GuardedSandbox>();

  /**
   * A handle on `inner`, or, when `problem` says the provider's answer breaks the port, a
   * refusal. A refused sandbox may still be running and costing money, so it is stopped first,
   * as far as it can be: the refusal is what the caller needs to hear.
   */
  const guard = async (inner: ProviderSandbox, problem: string | null): Promise<Sandbox> => {
    if (problem) {
      try {
        await inner?.stop?.();
      } catch {
        // Best effort only: the answer was refused already, and the refusal says why.
      }
      refuseFromProvider(problem);
    }
    const handle = new GuardedSandbox(inner);
    handles.set(handle, handle);
    return handle;
  };
  const idProblem = (inner: ProviderSandbox): string | null =>
    nameProblem("a sandbox's id", inner?.id);

  /** The guarded handle behind `sandbox`, which must be one these sandboxes made. */
  const own = (sandbox: Sandbox): GuardedSandbox => {
    const handle = handles.get(sandbox);
    if (!handle) {
      throw new SandboxError('invalid', 'That sandbox was not made by this provider.');
    }
    return handle;
  };

  const create = async (options: CreateSandboxOptions): Promise<Sandbox> => {
    refuseIf(createOptionsProblem(options));
    const { template, lifetimeSeconds, publicPorts } = options;
    const env = options.env === undefined ? undefined : { ...options.env };
    const inner = await fromProvider(() =>
      provider.create({
        template,
        env,
        ...(lifetimeSeconds !== undefined && { lifetimeSeconds }),
        ...(publicPorts !== undefined && { publicPorts }),
      }),
    );
    return guard(inner, idProblem(inner));
  };

  const attach = async (sandboxId: string): Promise<Sandbox> => {
    refuseIf(sandboxIdProblem('Attaching', sandboxId));
    const inner = await fromProvider(() => provider.attach(sandboxId));
    const problem =
      inner?.id === sandboxId
        ? null
        : `Attaching to ${sandboxId} gave back sandbox ${String(inner?.id)}.`;
    return guard(inner, problem);
  };

  const stop = async (sandboxId: string): Promise<void> => {
    refuseIf(sandboxIdProblem('Stopping a sandbox by its id', sandboxId));
    await fromProvider(() => provider.stop(sandboxId));
  };

  async function withSandbox<T>(
    options: CreateSandboxOptions,
    use: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> {
    const sandbox = await create(options);
    let result: T;
    try {
      result = await use(sandbox);
    } catch (error) {
      try {
        await sandbox.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          `The work in sandbox ${sandbox.id} failed, and stopping the sandbox failed too.`,
        );
      }
      throw error;
    }
    await sandbox.stop();
    return result;
  }

  const { pausing, snapshots, keepAlive } = provider;
  return {
    capabilities: SANDBOX_CAPABILITIES.filter((name) => provider[name] !== undefined),
    create,
    withSandbox,
    attach,
    stop,
    ...(pausing && {
      pausing: {
        async pause(sandbox) {
          const handle = own(sandbox);
          handle.ensureRunning();
          await fromProvider(() => pausing.pause(handle.id));
          handle.markPaused();
        },
        async resume(sandboxId) {
          if (typeof sandboxId !== 'string' || sandboxId.trim() === '') {
            throw new SandboxError('invalid', 'Resuming needs the id of the sandbox to resume.');
          }
          const inner = await fromProvider(() => pausing.resume(sandboxId));
          const problem =
            inner?.id === sandboxId
              ? null
              : `Resuming ${sandboxId} gave back sandbox ${String(inner?.id)}.`;
          return guard(inner, problem);
        },
      } satisfies Pausing,
    }),
    ...(snapshots && {
      snapshots: {
        async snapshot(sandbox) {
          const handle = own(sandbox);
          handle.ensureRunning();
          const template = await fromProvider(() => snapshots.snapshot(handle.id));
          refuseFromProvider(nameProblem("a snapshot's template name", template));
          return template;
        },
        async remove(template) {
          refuseIf(templateProblem(template) && 'Removing a snapshot needs its template name.');
          await fromProvider(() => snapshots.remove(template));
        },
      } satisfies Snapshots,
    }),
    ...(keepAlive && {
      keepAlive: {
        async renew(sandbox, lifetimeSeconds) {
          const handle = own(sandbox);
          refuseIf(lifetimeProblem(lifetimeSeconds));
          handle.ensureRunning();
          await fromProvider(() => keepAlive.renew(handle.id, lifetimeSeconds));
        },
      } satisfies KeepAlive,
    }),
  };
}

/**
 * The capability `capability` of `sandboxes`, for code that cannot go on without it. Rejects
 * with `unsupported` when the provider lacks it.
 */
export function requireCapability<C extends SandboxCapability>(
  sandboxes: Sandboxes,
  capability: C,
): NonNullable<Sandboxes[C]> {
  const member = sandboxes[capability];
  if (member === undefined) {
    throw new SandboxError(
      'unsupported',
      `This sandbox provider cannot ${CAPABILITY_ABILITIES[capability]}.`,
    );
  }
  return member as NonNullable<Sandboxes[C]>;
}

type State = 'running' | 'paused' | 'stopped';

class GuardedSandbox implements Sandbox {
  readonly id: string;
  private state: State = 'running';
  private stopping: Promise<void> | null = null;

  constructor(private readonly inner: ProviderSandbox) {
    this.id = inner.id;
  }

  ensureRunning(): void {
    if (this.state === 'paused') {
      throw new SandboxError('not-running', `Sandbox ${this.id} is paused. Resume it to use it.`);
    }
    if (this.state === 'stopped') {
      throw new SandboxError('not-running', `Sandbox ${this.id} has stopped.`);
    }
  }

  markPaused(): void {
    if (this.state === 'running') this.state = 'paused';
  }

  async run(command: Command): Promise<CommandResult> {
    return (await this.start(command)).wait();
  }

  async start(command: Command): Promise<RunningCommand> {
    refuseIf(commandProblem(command));
    this.ensureRunning();
    const keep = command.keepOutput ?? true;
    const output = { stdout: '', stderr: '' };
    let thrown: { error: unknown } | null = null;
    let started: ProviderCommand | null = null;
    // A command whose listener broke is killed, so its result says so now rather than whenever
    // the command would have ended, which for a session's command may be never. The kill is
    // best effort: the result rejects with what the listener threw either way.
    const killForListener = (): void => {
      started?.kill().catch(() => undefined);
    };
    const listen =
      (stream: 'stdout' | 'stderr', listener: ((chunk: string) => void) | undefined) =>
      (chunk: string): void => {
        if (keep) output[stream] += chunk;
        if (!listener || thrown) return;
        try {
          listener(chunk);
        } catch (error) {
          thrown = { error };
          killForListener();
        }
      };
    started = await fromProvider(() =>
      this.inner.start({
        argv: [...command.argv],
        cwd: command.cwd,
        env: command.env === undefined ? undefined : { ...command.env },
        onStdout: listen('stdout', command.onStdout),
        onStderr: listen('stderr', command.onStderr),
      }),
    );
    // A listener may have thrown before the provider handed the command back.
    if (thrown) killForListener();
    const running = started;
    let result: Promise<CommandResult> | null = null;
    return {
      wait: () => {
        result ??= fromProvider(() => running.wait()).then((exitCode) => {
          if (thrown) throw thrown.error;
          refuseFromProvider(exitCodeProblem(exitCode));
          return { exitCode, stdout: output.stdout, stderr: output.stderr };
        });
        return result;
      },
      // A stopped sandbox has ended its commands already, and a provider asked about one may
      // fail on the sandbox being gone; so killing then does nothing, as killing an ended one does.
      kill: async () => {
        if (this.state === 'stopped') return;
        await fromProvider(() => running.kill());
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    refuseIf(pathProblem(path));
    this.ensureRunning();
    const content = await fromProvider(() => this.inner.readFile(path));
    if (!(content instanceof Uint8Array)) {
      refuseFromProvider(`The provider read ${path} as something other than bytes.`);
    }
    return content;
  }

  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    refuseIf(pathProblem(path));
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      refuseIf('A file is written from a string or bytes.');
    }
    this.ensureRunning();
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await fromProvider(() => this.inner.writeFile(path, bytes));
  }

  async exposePort(port: number): Promise<ExposedPort> {
    refuseIf(portProblem(port));
    this.ensureRunning();
    const url = await fromProvider(() => this.inner.exposePort(port));
    refuseFromProvider(exposedUrlProblem(url));
    return { port, url, host: new URL(url).host };
  }

  stop(): Promise<void> {
    this.state = 'stopped';
    if (!this.stopping) {
      // A stop that fails is forgotten, so the next call tries again: a sandbox left running
      // costs money. The handle still refuses work, since the sandbox may be half stopped.
      this.stopping = fromProvider(() => this.inner.stop()).catch((error: unknown) => {
        this.stopping = null;
        throw error;
      });
    }
    return this.stopping;
  }
}

/** Refuses a request the rules found wrong. */
function refuseIf(problem: string | null | false): void {
  if (problem) throw new SandboxError('invalid', problem);
}

/** Refuses an answer from the provider that breaks the port's promises. */
function refuseFromProvider(problem: string | null): void {
  if (problem) throw new SandboxError('provider', problem);
}

/** Calls the provider, turning whatever it throws into a `SandboxError`. */
async function fromProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw asSandboxError(error);
  }
}

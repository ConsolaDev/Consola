import type { Command, CreateSandboxOptions } from '../domain/sandbox';

/**
 * The port: what a provider implements. Code never calls a provider directly. It goes through
 * `sandboxesFrom`, which checks each request against the rules first, refuses work for a
 * stopped sandbox, stops each sandbox once, collects output and turns every failure into a
 * `SandboxError`. So a provider only translates: it receives requests that are already valid,
 * and maps its SDK's answers and failures onto these types and onto `SandboxError` codes.
 *
 * A provider declares a capability by having its member (`pausing`, `snapshots`), and never
 * exposes its own name or id for code to branch on.
 */
export interface SandboxProvider {
  /**
   * Starts a sandbox from `options.template`, with `options.env` set for every command. Rejects
   * with `not-found` when there is no such template.
   */
  create(options: CreateSandboxOptions): Promise<ProviderSandbox>;
  /** Present when sandboxes can be paused and resumed. */
  readonly pausing?: ProviderPausing;
  /** Present when a sandbox can be saved as a template. */
  readonly snapshots?: ProviderSnapshots;
}

export interface ProviderSandbox {
  /** The provider's id for the sandbox, unique among its sandboxes. */
  readonly id: string;
  /**
   * Starts `command` and resolves once it runs. Its output goes to its listeners as it arrives,
   * and all of it before `wait` settles. Each argument reaches the program verbatim: an SDK
   * that takes a command line must quote every one. A program that does not exist ends with
   * exit code 127, as in a shell.
   */
  start(command: Command): Promise<ProviderCommand>;
  /** The file's bytes. Rejects with `not-found` when there is no such file. */
  readFile(path: string): Promise<Uint8Array>;
  /** Writes the file whole, replacing one that is there and creating missing folders. */
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /** The http or https address the port is reached at from outside the sandbox. */
  exposePort(port: number): Promise<string>;
  /**
   * Ends every command still running in the sandbox (each `wait` settles with null), then the
   * sandbox itself. Stopping a sandbox that has stopped already does nothing. From then on every
   * call on this handle rejects with `not-running`, so a provider keeps its own note that it
   * stopped: some calls (E2B's port address, say) never ask the network. A sandbox stopped from
   * elsewhere (a timeout, another handle) rejects with `not-running` wherever the provider can
   * tell.
   */
  stop(): Promise<void>;
}

export interface ProviderCommand {
  /**
   * Settles when the command has ended and all its output was delivered: with its exit code, or
   * with null when a signal ended it. A non-zero exit resolves; it never rejects for one.
   */
  wait(): Promise<number | null>;
  /** Ends the command, so that `wait` settles with null. Killing one that has ended does nothing. */
  kill(): Promise<void>;
}

export interface ProviderPausing {
  /**
   * Pauses a running sandbox: it keeps its files, takes no work and costs little until resumed.
   * Commands it was running may not survive the pause, and code must not count on them.
   */
  pause(sandboxId: string): Promise<void>;
  /**
   * Resumes a paused sandbox, or reattaches to a running one, by its id. Rejects with
   * `not-found` when there is no such sandbox, or it has stopped.
   */
  resume(sandboxId: string): Promise<ProviderSandbox>;
}

export interface ProviderSnapshots {
  /**
   * Saves a running sandbox's files as a template new sandboxes can start from, and returns its
   * name. The sandbox keeps running.
   */
  snapshot(sandboxId: string): Promise<string>;
  /**
   * Removes a template `snapshot` made, so it costs nothing more; creating from it afterwards
   * rejects with `not-found`. Removing one that is gone does nothing. A template the provider did
   * not make by a snapshot is refused with `invalid`.
   */
  remove(template: string): Promise<void>;
}

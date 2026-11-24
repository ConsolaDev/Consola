/** What a sandbox starts from. */
export interface CreateSandboxOptions {
  /**
   * The template or image the sandbox starts from, in the provider's own naming: an E2B
   * template, a Modal image, or the name a snapshot returned.
   */
  readonly template: string;
  /** Variables every command in the sandbox sees. A command's own `env` goes on top. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * How long the sandbox may live, in whole seconds from its start. Once that runs out the
   * provider stops it, whoever holds it and whatever it runs, unless `keepAlive` renewed it
   * first. It is a hard maximum: nothing else lengthens it, attaching included. It is also what
   * stops a sandbox whose runner died, so work that outlives one call sets it and renews it.
   *
   * When absent, the provider's own default applies: minutes for some (E2B's is 5), no limit
   * for others (the fake's).
   */
  readonly lifetimeSeconds?: number;
  /**
   * Whether every port `exposePort` exposes is reached with no credential of the provider's, by
   * anyone who has its address (a browser's WebSocket included). Off when absent: a provider
   * that can lock its ports keeps them locked, and only a client holding the provider's own
   * credential reaches them. Ask for it only for a sandbox whose listeners guard themselves, and
   * know that it opens every port the sandbox listens on, not only the one exposed.
   */
  readonly publicPorts?: boolean;
}

/** A program to run in a sandbox. */
export interface Command {
  /**
   * The program and its arguments. Each reaches the program exactly as it is: no shell reads
   * them, so nothing in an argument is expanded, split or run. To run a script, name the
   * shell: `['sh', '-c', script]`.
   */
  readonly argv: readonly string[];
  /** The absolute folder it runs in. The provider's default when absent. */
  readonly cwd?: string;
  /** Variables for this command only, on top of the sandbox's own. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Called with the command's output as it arrives, in order. All of it has arrived by the time
   * the command's result does. A listener that throws is not called again: the command is
   * killed, and its result rejects with what the listener threw.
   */
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  /**
   * Whether the result holds the command's output, as it does unless this is false. A command
   * that runs for long and is only listened to, such as a session's, sets false so its output
   * is not kept in memory; its result's stdout and stderr are then empty.
   */
  readonly keepOutput?: boolean;
}

/** How a command ended, and everything it wrote. */
export interface CommandResult {
  /**
   * The code it exited with, or null when it was ended by a signal: by `kill`, or by its
   * sandbox stopping or pausing.
   */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A port in a sandbox, reachable from outside it. */
export interface ExposedPort {
  readonly port: number;
  /**
   * Where it is reached, such as `https://7420-abc.e2b.app`. A WebSocket server on the port is
   * reached at the same address with `wss:` (or `ws:` for `http:`).
   */
  readonly url: string;
  /** The URL's host, with its port when it names one. */
  readonly host: string;
}

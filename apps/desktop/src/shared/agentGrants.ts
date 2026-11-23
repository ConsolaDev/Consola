/**
 * What a step's agent was granted, as Claude's driver compiled it when the
 * attempt launched; replayed by it on every launch of that session.
 *
 * The driver's own compiled form, kept on the session record: nothing
 * outside its driver reads it but `servers` and `skills`, for the words.
 */
export interface ClaudeAgentGrants {
  driverId: 'claude';
  /** As the agent names them: what `init` must show connected, and what the pane and cards say. */
  servers: Array<{ name: string; tools?: string[] }>;
  /** By their folder names in skills/. */
  skills: string[];
  /**
   * `consola` first, then each granted server: stdio by `serverName`, remote
   * and connector by `serverUrl`. Absent when no server is granted.
   */
  allowedMcpServers?: Array<{ serverName: string } | { serverUrl: string }>;
  /** `--strict-mcp-config` stays unless a connector is granted. */
  strict: boolean;
  /** The person's own file, after Consola's in `--mcp-config`, when a user server is granted. */
  accountFile?: string;
  /**
   * `--allowedTools` rules after Consola's: `mcp__<server>__*` or each
   * narrowed tool, then `Skill(consola-step:<name>)`.
   */
  allowedTools: string[];
  /** The step's built plugin dir, when skills are granted. */
  pluginDir?: string;
  /**
   * Beside `pluginDir`: each granted skill's `skillHash` as its run's
   * definition held it. The plugin was built to these, and a launch loads it
   * only while it still holds exactly them (review M1).
   */
  skillHashes?: Record<string, string>;
  /**
   * A write step's environment (slice 3-B): what its agent file names, its
   * isolation, and the variables it passes. Absent on a read-only step's.
   */
  environment?: { name: string; isolation: 'host' | 'sandbox'; envNames: string[] };
  /**
   * A write step's `tools:` (slice 3-B, Call 14). Absent is read-only: slice
   * 2's sessions persist grants without it. A launch whose policy is `edit`
   * or `write` needs grants that say the same.
   */
  tools?: 'edit' | 'write';
  /**
   * A `sandbox` write step's sandbox, as `--settings` carries it, and the
   * Claude version it was compiled on (from the harness's health probe;
   * `unknown` when it could not be read). Absent on `host` and read-only.
   */
  sandbox?: { settings: ClaudeSandboxSettings; cliVersion: string };
  /**
   * A write step's file tools' deny rules (`--disallowedTools`), replayed on
   * every launch: the checkout's `.git` pointer always (Call 9), each deny
   * list entry only where the canary found the file tools read it (Call 22).
   */
  fileDeny?: string[];
}

/**
 * Claude's `sandbox` settings as a write step's one `--settings` holds
 * them (slice 3-B Task 17). Its keys are the CLI's own; `denyWrite` names the
 * checkout's `.git` pointer (Call 9), `denyRead` Consola's deny list (Call
 * 21), `allowRead` the step's plugin folder once the canary showed it works
 * inside a denied folder (row 35). The Unix-socket keys appear only where
 * the canary found the shell could connect to one (Call 23).
 */
export interface ClaudeSandboxSettings {
  enabled: true;
  autoAllowBashIfSandboxed: true;
  allowUnsandboxedCommands: false;
  network: { allowedDomains: string[]; allowUnixSockets?: []; allowAllUnixSockets?: false };
  filesystem: { denyRead: string[]; denyWrite: string[]; allowRead?: string[] };
}

/** A step's grants, tagged by the driver that compiled them. Only Claude's today. */
export type AgentGrants = ClaudeAgentGrants;

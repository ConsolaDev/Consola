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
}

/** A step's grants, tagged by the driver that compiled them. Only Claude's today. */
export type AgentGrants = ClaudeAgentGrants;

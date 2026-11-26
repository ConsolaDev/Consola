import type { AgentRun } from '@consola/runner-protocol';
import type { ModelSelection } from '@t3tools/contracts';

/** What one host runs: a Consola session on one harness, in one folder. */
export type SessionSpec = {
  sessionId: string;
  harness: 'claude' | 'codex' | 'opencode' | 'pi' | 'acp';
  cwd: string;
  modelSelection?: ModelSelection;
  /**
   * An agent run (`--agent-run`): the host sends its prompt itself, and its threads open in t3's
   * `full-access` mode, with the agent run's tools over MCP (`AGENTS.md`, "Agent runs"). Only in a
   * sandbox: `bin.ts` refuses it with `--dev`.
   */
  agentRun?: AgentRun;
};

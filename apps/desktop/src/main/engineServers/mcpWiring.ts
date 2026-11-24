import * as path from 'node:path';
import { nodeMcpClient } from '@consola/automation-engine';
import type { McpClientPort, ServerGroupsFile, StateFile } from '@consola/automation-engine';
import { JsonStateFile } from '../state/JsonStateFile';

/*
 * Where the engine calls MCP servers from on the desktop. It lives apart from
 * `main/automations/`, which `tools/allowBoundary.test.ts` scans as
 * agent-facing (review B2): no code an agent's call reaches may start a
 * server, so nothing there imports this module.
 */

/** The engine's `mcp` and `serverGroups` deps on the desktop. */
export function automationMcpDeps(input: {
  userDataDir: string;
  /** The login environment once its retry settled: `await loginEnvRetry()`, then a copy of `getLoginEnv()`. */
  loginEnv(): Promise<NodeJS.ProcessEnv>;
  /** Test seam. */
  makeClient?: typeof nodeMcpClient;
}): { mcp: McpClientPort; serverGroups: StateFile<ServerGroupsFile> } {
  const makeClient = input.makeClient ?? nodeMcpClient;
  return {
    // A stdio server's environment is the allow-list taken from this, its env: and its secrets (Call 25).
    // The platform is the default, `process.platform`: a Windows desktop offers `http` only (review S11).
    mcp: makeClient({
      baseEnv: async () => ({ ...(await input.loginEnv()) }),
      workRoot: path.join(input.userDataDir, 'mcp-calls'),
    }),
    // Check server's groups, ended at the next start if a quit left one running (Call 12).
    serverGroups: new JsonStateFile<ServerGroupsFile>(
      path.join(input.userDataDir, 'mcp-server-groups.json'),
    ),
  };
}

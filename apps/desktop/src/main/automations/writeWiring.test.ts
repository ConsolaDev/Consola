import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeWrites, type AgentRequirements } from '@consola/automation-engine';
import type { StepsAutomation } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { SANDBOX_CHECKED_ON_CLAUDE } from '../../shared/sandboxCheck';
import {
  FILE_TOOLS_DENY_CHECKED,
  FILE_TOOLS_LINKS_CHECKED,
  HOST_EDIT_CHECKED,
} from '../drivers/claudeWriteAgent';

/*
 * What main wires for write steps (slice 3-B Task 18), read from its one
 * construction and its handlers: guards the service's and the port's own
 * tests cannot reach, since they build them with fakes. No unit test drives
 * an IPC handler here, so each row pins the check where it must sit.
 */

const ipc = fs.readFileSync(path.resolve(__dirname, '../ipc-handlers.ts'), 'utf8');

/** `ipc` from the first `from` to the first `to` after it. */
function between(from: string, to: string): string {
  const start = ipc.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = ipc.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return ipc.slice(start, end);
}

describe("main's wiring of write steps", () => {
  it('builds the runner with its run-owned port and says its launch holds a write agent (Call 2)', () => {
    const deps = between('new AutomationService({', '\n  });');
    expect(deps).toMatch(/\n {4}runCheckout,\n/);
    expect(deps).toMatch(/\n {4}writeAgents: true,\n/);
    expect(ipc.match(/runOwnedCheckoutPort\(/g)).toHaveLength(1);
  });

  it("compiles a write agent against this machine: at apply without waiting, at launch with its CLI's version", () => {
    expect(between('agentHarness: (workspaceId, agent) =>', 'listHarnesses:')).toMatch(
      /host: \(harness\) => writeAgentHostNow\(writeHostDeps, harness\),/,
    );
    expect(between('launchAgent: (request) =>', 'resumeAgent:')).toMatch(
      /writeAgentHost: \(harness\) => writeAgentHost\(writeHostDeps, harness\),/,
    );
    expect(ipc.match(/new HarnessVersions\(/g)).toHaveLength(1);
  });

  it("starts nothing in a run's checkout whose git folder changed: TERMINAL_CREATE, TERMINAL_RESTART and a shell ask first (review NB1)", () => {
    const create = between('ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE', 'return manager.ensure(');
    expect(create).toMatch(/runCheckoutSpawnRefusal\(record, worktrees\.worktreeRoot\)/);
    expect(create).toMatch(/if \(runCheckoutRefusal\) throw new Error\(runCheckoutRefusal\);/);
    // After any rebuild: the check sits below it.
    expect(create.indexOf('runCheckoutSpawnRefusal')).toBeGreaterThan(
      create.indexOf('rebuildForLaunch'),
    );
    const restart = between('ipcMain.on(IPC_CHANNELS.TERMINAL_RESTART', 'restartClaude(');
    expect(restart).toMatch(/runCheckoutSpawnRefusal\(located\.session, worktrees\.worktreeRoot\)/);
    expect(restart.indexOf('runCheckoutSpawnRefusal')).toBeGreaterThan(
      restart.indexOf('rebuildForLaunch'),
    );
    const shell = between('const shellCwd = async', 'return cwd;');
    expect(shell).toMatch(/runCheckoutSpawnRefusal\(located\.session, worktrees\.worktreeRoot\)/);
    expect(shell.indexOf('runCheckoutSpawnRefusal')).toBeGreaterThan(
      shell.indexOf('ensureCheckout'),
    );
  });

  it("asks a step's run before its full-tools continuation, and moves an item's out of the automation checkout (Task 20)", () => {
    const wired = between('launcher.continuation = {', '\n  };');
    expect(wired).toMatch(
      /\n {4}refusal: \(runId, stepId\) => automations\.continuationRefusal\(runId, stepId\),\n/,
    );
    expect(wired).toMatch(
      /\n {4}checkoutOf: \(runId\) => runStore\.get\(runId\)\?\.checkout \?\? null,\n/,
    );
    expect(wired).toMatch(/worktrees\.continuationWorktreePathFor\(item, source\.id\)/);
    expect(wired).toMatch(/await worktrees\.addContinuationWorktree\(clone, dir, commit\);/);
    // Wired before the fork's handler is.
    expect(ipc.indexOf('launcher.continuation = {')).toBeLessThan(
      ipc.indexOf('IPC_CHANNELS.WORKSPACE_SESSION_FORK,'),
    );
  });

  it("passes the approval card the canary's three verdicts, its CLI's version, and a run definition's writes (Task 21)", () => {
    const deps = between('new AutomationService({', '\n  });');
    expect(deps).toMatch(/\n {4}sandboxCheckedOn: SANDBOX_CHECKED_ON_CLAUDE,\n/);
    expect(deps).toMatch(/\n {4}fileToolsChecked: FILE_TOOLS_DENY_CHECKED,\n/);
    // Canary row 50 (the 3-B code review's F6): whether the file tools follow a link out of the checkout.
    expect(deps).toMatch(/\n {4}fileToolLinksChecked: FILE_TOOLS_LINKS_CHECKED,\n/);
    expect(deps).toMatch(/\n {4}hostEditChecked: HOST_EDIT_CHECKED,\n/);
    expect(between('agentHarness: (workspaceId, agent) =>', 'listHarnesses:')).toMatch(
      /cliVersion: \(harness\) => \{\n {10}const fields = launchFieldsFor\(harness\);\n {10}const known = harnessVersions\.peek\(fields\);/,
    );
    const handler = between('IPC_CHANNELS.AUTOMATIONS_GET_RUN_DEFINITION,', '\n  );');
    expect(handler).toMatch(
      /const writes = automations\.writesFor\(\n {8}definition\.automation,\n {8}definition\.agents,/,
    );
    expect(handler).not.toMatch(/harnessVersions\.get\(/);
  });

  it("an edit agent on host is worded by HOST_EDIT_CHECKED, as main passes it (the re-check's Minor)", () => {
    const words = (hostEditChecked: boolean) =>
      describeWrites(EDIT_ON_HOST.automation, EDIT_ON_HOST.agents, {
        checkedOn: SANDBOX_CHECKED_ON_CLAUDE,
        running: {},
        hostEditChecked,
        fileToolsChecked: FILE_TOOLS_DENY_CHECKED,
        fileToolLinksChecked: FILE_TOOLS_LINKS_CHECKED,
      })!.agents[0].sentences[0];
    expect(
      words(HOST_EDIT_CHECKED).startsWith(
        HOST_EDIT_CHECKED
          ? "Changes files only in this run's checkout (no shell)."
          : "Changes files in this run's checkout (no shell); that it can change nothing else is not yet checked on host.",
      ),
    ).toBe(true);
    expect(words(!HOST_EDIT_CHECKED)).not.toBe(words(HOST_EDIT_CHECKED));
  });

  it("opens a run's checkout only through openRunCheckout, with the real-path check and shell.openPath, and removes the handler at teardown (Task 22)", () => {
    const handler = between('IPC_CHANNELS.AUTOMATIONS_OPEN_RUN_CHECKOUT,', '\n  );');
    expect(handler).toMatch(/openRunCheckout\(/);
    expect(handler).toMatch(/isManagedPath: \(dir\) => worktrees\.isManagedPath\(dir\)/);
    expect(handler).toMatch(/openPath: \(dir\) => shell\.openPath\(dir\)/);
    expect(ipc.match(/IPC_CHANNELS\.AUTOMATIONS_OPEN_RUN_CHECKOUT/g)).toHaveLength(2);
    expect(ipc).toMatch(/ipcMain\.removeHandler\(IPC_CHANNELS\.AUTOMATIONS_OPEN_RUN_CHECKOUT\)/);
    // Registered through the guarded wall, as every handler here is.
    expect(ipc).toMatch(/import \{ guardedIpc as ipcMain \} from '\.\/guardedIpc';/);
    const preload = fs.readFileSync(path.resolve(__dirname, '../../preload/preload.ts'), 'utf8');
    expect(preload).toMatch(
      /openRunCheckout: \(runId\) =>\s+ipcRenderer\.invoke\(IPC_CHANNELS\.AUTOMATIONS_OPEN_RUN_CHECKOUT, runId\)/,
    );
  });
});

/** An entry whose one step runs an `edit` agent on `host`. */
const EDIT_ON_HOST = (() => {
  const automation = {
    name: 'edit',
    checkout: { repo: 'sprocket/catalog-portal', branch: 'fix/{{item.key}}' },
    steps: [{ id: 'change', kind: 'agent', agent: 'changer' }],
  } as unknown as StepsAutomation;
  const agents: Record<string, AgentRequirements> = {
    changer: {
      name: 'changer',
      hash: 'h',
      body: 'Change it.',
      mcpServers: [],
      skills: [],
      tools: 'edit',
      environment: { name: 'open', isolation: 'host', network: [], env: [], hash: 'e' },
    },
  };
  return { automation, agents };
})();

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

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
});

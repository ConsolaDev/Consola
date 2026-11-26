import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAgentWorkspace, launchAgentWorkspace } from './helpers/agentWorkspace';
import type { AgentWorkspace } from './helpers/agentWorkspace';
import { startFixtureServer } from './helpers/fixtureServer';
import type { FixtureServer } from './helpers/fixtureServer';
import { connectAgent } from './helpers/sessionMcp';
import type { AgentClient } from './helpers/sessionMcp';
import { openTab } from './helpers/toolAnswers';

/**
 * An agent's connection to a page stays open between its calls, so the
 * ordinary way a page goes is with the connection still on it: its window
 * closes, the window moves to another workspace, or the workspace is
 * deleted. Each must end the connection cleanly, with nothing thrown in main
 * (a destroyed page throws on what is read from it, and an event handler's
 * throw would leave the page half let go of, or a workspace delete cut short).
 *
 * The agent is a client on the session's real MCP endpoint; its snapshot
 * opens the connection. Main's uncaught errors and its warnings are recorded
 * from before the teardown, and an uncaught error is kept from becoming
 * Electron's error box.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

const SESSION = 'Teardown session';

interface MainGlobals {
  __consolaTest: { browserAgent: { driver: { connectedTabs(): string[] } } };
  __teardownTrouble?: string[];
}

/** The tabs an agent's connection is open on, from main (`PageDriver`). */
function connectedTabs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    (globalThis as unknown as MainGlobals).__consolaTest.browserAgent.driver.connectedTabs(),
  );
}

/** From now on, records what main throws unhandled, and what it warns or errors about. */
async function recordTrouble(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const main = globalThis as unknown as MainGlobals;
    if (main.__teardownTrouble) return;
    const trouble: string[] = [];
    main.__teardownTrouble = trouble;
    process.on('uncaughtException', (error) => trouble.push(`uncaught: ${error.message}`));
    for (const level of ['warn', 'error'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        trouble.push(`${level}: ${args.map(String).join(' ')}`);
        original(...args);
      };
    }
  });
}

function trouble(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as MainGlobals).__teardownTrouble ?? []);
}

/** What would say a page was read after it was destroyed, or a teardown step failed. */
const BROKEN = /destroyed|failed:|uncaught/i;

test.describe('an agent connected to a page', () => {
  let workspace: AgentWorkspace;
  let app: ElectronApplication;
  let agent: AgentClient;

  test.beforeEach(async () => {
    workspace = await launchAgentWorkspace('Teardown', [SESSION]);
    app = workspace.app;
    agent = await connectAgent(app, workspace.sessions[SESSION]);
    const tabId = await openTab(agent, fixtures.url('/a.html'));
    const read = await agent.call('consola_browser_snapshot', { tabId });
    expect(read.isError, read.text).toBe(false);
    // The connection stays open after the call.
    expect(await connectedTabs(app)).toEqual([tabId]);
    await recordTrouble(app);
  });

  test.afterEach(async () => {
    await agent?.close().catch(() => undefined);
    await closeAgentWorkspace(workspace);
  });

  test('lets go of it cleanly when its window closes', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => connectedTabs(app)).toEqual([]);
    // Give anything that would throw late its chance.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await trouble(app)).filter((line) => BROKEN.test(line))).toEqual([]);
  });

  test('lets go of it cleanly when its window moves to another workspace', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-teardown-elsewhere-'));
    try {
      await workspace.page.evaluate(
        (root) =>
          window.workspaceAPI.createWorkspace('Elsewhere', root, false, 'browser-agent-stub'),
        elsewhere,
      );
      await workspace.page
        .getByRole('navigation', { name: 'Workspaces', exact: true })
        .getByRole('button', { name: /Elsewhere/ })
        .click();
      await expect.poll(() => connectedTabs(app)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await trouble(app)).filter((line) => BROKEN.test(line))).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('lets go of it cleanly when its workspace is deleted, and the delete goes through', async () => {
    await workspace.page.evaluate(
      (id) => window.workspaceAPI.deleteWorkspace(id),
      workspace.workspaceId,
    );
    await expect.poll(() => connectedTabs(app)).toEqual([]);
    const left = await workspace.page.evaluate(() => window.workspaceAPI.getSnapshot());
    expect(left.workspaces.map((each) => each.id)).not.toContain(workspace.workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await trouble(app)).filter((line) => BROKEN.test(line))).toEqual([]);
  });
});

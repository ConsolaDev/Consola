import { expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProfileDir, launchElectron, removeProfile } from './electron';
import { keepOffScreen, type ScreenGuard } from './screenGuard';
import { sessionEndpoint } from './sessionMcp';

/**
 * A workspace whose sessions have agents: the app launched hidden, kept from
 * putting anything on the person's screen (`screenGuard`), with one workspace
 * of sessions on a stub harness that never prompts, each session's pane
 * mounted once so its MCP endpoint exists (`TERMINAL_CREATE`). The last
 * session named is the one the window shows.
 */

export interface AgentWorkspace {
  app: ElectronApplication;
  page: Page;
  screen: ScreenGuard;
  /** The folder the workspace is on, holding the stub harness. */
  root: string;
  /** The profile directory passed to the app (main adds its " Test" suffix). */
  userDataDir: string;
  workspaceId: string;
  /** Session ids by name. */
  sessions: Record<string, string>;
}

/**
 * Launches the app as every end-to-end spec does (hidden and unfocusable
 * unless `CONSOLA_E2E_HEADED` is set), guarded before any page exists.
 */
export async function launchGuarded(
  userDataDir?: string,
): Promise<{ app: ElectronApplication; page: Page; screen: ScreenGuard; userDataDir: string }> {
  const launched = await launchElectron({ userDataDir });
  const screen = await closingOnFailure(launched.app, () => keepOffScreen(launched.app));
  return { ...launched, screen };
}

/**
 * What `work` gives; if it fails, the app is closed before the failure goes
 * on, since a setup that throws leaves nothing for an `afterAll` to close.
 */
export async function closingOnFailure<T>(
  app: ElectronApplication,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

/** One workspace on `root` with the named sessions, on a stub harness that never prompts. */
export async function seedWorkspace(
  page: Page,
  root: string,
  workspace: string,
  sessionNames: string[],
): Promise<{ workspaceId: string; sessions: Record<string, string> }> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub, workspace, sessionNames }) => {
      await window.harnessStateAPI.addHarness({
        id: 'browser-agent-stub',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const created = await window.workspaceAPI.createWorkspace(
        workspace,
        root,
        false,
        'browser-agent-stub',
      );
      const sessions: Record<string, string> = {};
      for (const [index, name] of sessionNames.entries()) {
        const session = await window.workspaceAPI.createSession(created.id, {
          name,
          nameIsUserSet: true,
          workspaceId: created.id,
          instanceId: `browser-agent-${index}`,
          harnessId: 'browser-agent-stub',
          scopeId: created.scopes[0].id,
        });
        sessions[name] = session!.id;
      }
      return { workspaceId: created.id, sessions };
    },
    { root, stub, workspace, sessionNames },
  );
}

/**
 * Shows a session in the window, which mounts its pane and so creates its
 * terminal; returns once main has written the session's endpoint.
 */
export async function openSession(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  session: { name: string; id: string },
): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: new RegExp(workspace) })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: session.name }).click();
  await sessionEndpoint(app, session.id);
}

/**
 * The app launched hidden and guarded, with one workspace of the named
 * sessions, each session's pane mounted in turn; the window shows the last.
 */
export async function launchAgentWorkspace(
  workspace: string,
  sessionNames: string[],
): Promise<AgentWorkspace> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-agent-'));
  const userDataDir = createProfileDir();
  try {
    const { app, page, screen } = await launchGuarded(userDataDir);
    const seeded = await closingOnFailure(app, async () => {
      const made = await seedWorkspace(page, root, workspace, sessionNames);
      for (const name of sessionNames) {
        await openSession(app, page, workspace, { name, id: made.sessions[name] });
      }
      return made;
    });
    return { app, page, screen, root, userDataDir, ...seeded };
  } catch (error) {
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function closeAgentWorkspace(workspace: AgentWorkspace | undefined): Promise<void> {
  if (!workspace) return;
  await workspace.app.close();
  removeProfile(workspace.userDataDir);
  fs.rmSync(workspace.root, { recursive: true, force: true });
}

const globe = (page: Page) => page.getByRole('button', { name: /^(Show|Hide) browser/ });
const panel = (page: Page) => page.getByTestId('browser-panel');

/** The person opens the session's browser panel, which shows its active tab. */
export async function showBrowser(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) await globe(page).click();
  await expect(panel(page)).toBeVisible();
}

/** Runs a script in the page at `urlPrefix`, from main (not the agent's connection); its value. */
export function inPage<T>(app: ElectronApplication, urlPrefix: string, script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getType() === 'webview' && contents.getURL().startsWith(args.prefix),
        );
      if (!guest) throw new Error(`no page at ${args.prefix}`);
      return guest.executeJavaScript(args.script);
    },
    { prefix: urlPrefix, script },
  ) as Promise<T>;
}

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

/**
 * The Assistant's approval tray: what it asked for waits beside it, and is
 * approved there.
 *
 * The request is seeded into the run history between two launches rather
 * than asked for over MCP, since the Assistant's terminal runs the real
 * `claude`. Everything after that — the tray, the row, approving — is the app.
 */

let app: ElectronApplication;
let page: Page;
let base: string;
let profile: string;

test.beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-assistant-approvals-'));
  profile = createProfileDir();
});

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
});

async function launch() {
  ({ app, page } = await launchElectron({
    userDataDir: profile,
    env: { CONSOLA_FACTORY_DIR: path.join(base, 'factories') },
  }));
}

function railButton(name: string) {
  return page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
}

async function openWorkspace(name: string) {
  await railButton(name).click();
  await expect(railButton(name)).toHaveAttribute('aria-current', 'true');
}

async function sessionNames(workspaceId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const { workspaces } = await window.workspaceAPI.getSnapshot();
    return workspaces.find((workspace) => workspace.id === id)!.sessions.map((session) => session.name);
  }, workspaceId);
}

test('approving the Assistant’s request from its tray', async () => {
  await launch();
  const scopePath = path.join(base, 'sprocket');
  fs.mkdirSync(scopePath, { recursive: true });
  const workspaceId = await page.evaluate(
    (scope) => window.workspaceAPI.createWorkspace('sprocket', scope, false).then((workspace) => workspace.id),
    scopePath
  );
  const sessionId = await page.evaluate(async (id) => {
    const { workspaces } = await window.workspaceAPI.getSnapshot();
    const workspace = workspaces.find((candidate) => candidate.id === id)!;
    const session = await window.workspaceAPI.createSession(id, {
      name: 'old review',
      workspaceId: id,
      instanceId: `workspace-${id}-session-old-review`,
      harnessId: workspace.defaultHarnessId,
      scopeId: workspace.scopes[0]!.id,
    });
    return session!.id;
  }, workspaceId);
  await openWorkspace('sprocket');
  await page.getByRole('button', { name: /Assistant/ }).click();
  await expect(page.locator('.workspace-view-header')).toContainText('✦ Assistant');
  const assistantId = await page.evaluate(async (id) => {
    const { workspaces } = await window.workspaceAPI.getSnapshot();
    return workspaces.find((workspace) => workspace.id === id)!.sessions.find((s) => s.kind === 'assistant')!.id;
  }, workspaceId);
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  await app.close();

  // What `consola_delete_session` leaves waiting when the Assistant calls it.
  const at = new Date().toISOString();
  const ref = 'consola#delete_session';
  fs.writeFileSync(
    path.join(userData, 'automation-runs.json'),
    JSON.stringify({
      version: 1,
      lastFired: {},
      runs: [
        {
          id: 'req-1',
          runner: 'local',
          source: 'manual',
          automationId: ref,
          actionName: ref,
          actionVersion: 'seeded',
          mode: 'confirm',
          trigger: { kind: 'manual', at, by: 'agent', actorId: assistantId },
          status: 'needs-approval',
          summary: 'Would delete "old review". Asked by "Assistant".',
          approval: { args: { session_id: sessionId } },
          attribution: { automationId: ref, actionName: ref, triggerKind: 'manual', workspaceId, actorId: assistantId },
          createdAt: at,
          updatedAt: at,
        },
      ],
    })
  );

  await launch();
  await openWorkspace('sprocket');
  // The workspace remembers the Assistant, so its header's buttons are on screen too.
  const row = page.locator('.assistant-nav-item');
  await expect(row).toContainText('1 waiting');

  await row.click();
  const tray = page.getByRole('complementary', { name: 'Waiting for your approval' });
  await expect(tray).toContainText('Delete session');
  await expect(tray).toContainText('Would delete "old review".');

  // Hidden, it leaves its count in the header and comes back from there.
  await tray.getByRole('button', { name: 'Hide' }).click();
  await expect(tray).toHaveCount(0);
  const chip = page.getByRole('button', { name: 'Show 1 waiting for your approval' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(tray).toBeVisible();

  await tray.getByRole('button', { name: 'Approve' }).click();
  await expect(tray).toHaveCount(0);
  await expect.poll(() => sessionNames(workspaceId)).not.toContain('old review');
  await expect(row).not.toContainText('waiting');
});

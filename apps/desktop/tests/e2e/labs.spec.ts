import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron, settingsChord } from './helpers/electron';

/**
 * Labs, end to end: Automations shows only on a computer that turns it on in
 * `~/.consola/labs.json`. A test run never reads that file; it says what the
 * file would through `CONSOLA_E2E_LABS`, and with nothing said every lab is on.
 *
 * Each launch seeds a `Sprocket` workspace whose remembered view is the
 * Automations dashboard, as a computer that showed it once would have left it.
 */

const WORKSPACE_ID = 'ws-labs-e2e';

function seed(userDataDir: string, scopeDir: string): void {
  // main/index.ts appends ' Test' to the profile dir under NODE_ENV=test.
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 7,
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: 'Sprocket',
          defaultHarnessId: 'default',
          scopes: [
            {
              id: 'scope-app',
              name: 'catalog-portal',
              path: scopeDir,
              isGitRepo: false,
              createdAt: now,
            },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(effective, 'view-memory.json'),
    JSON.stringify({
      views: { [WORKSPACE_ID]: { activeSessionId: null, overlay: 'automations' } },
    }),
  );
}

async function launch(labs?: string): Promise<{
  app: ElectronApplication;
  page: Page;
  cleanup: () => Promise<void>;
}> {
  const userDataDir = createProfileDir();
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-labs-'));
  seed(userDataDir, scopeDir);
  const { app, page } = await launchElectron({
    userDataDir,
    env: labs === undefined ? {} : { CONSOLA_E2E_LABS: labs },
  });
  const cleanup = async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(scopeDir, { recursive: true, force: true });
  };
  return { app, page, cleanup };
}

/** Hold the seeded workspace in this window, landing on what it remembers. */
async function holdSprocket(page: Page): Promise<void> {
  const button = page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /^Sprocket/ });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

function automationsRow(page: Page) {
  return page.locator('.home-navigation').getByRole('button', { name: /^Automations/ });
}

function dashboard(page: Page) {
  return page.getByRole('region', { name: 'Automations', exact: true });
}

/** The Settings dialog's list of sections, opened with the Settings chord. */
async function settingsSections(page: Page) {
  await page.keyboard.press(settingsChord());
  const modal = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(modal).toBeVisible();
  return modal.getByRole('navigation', { name: 'Settings sections', exact: true });
}

test('a computer that has not turned Automations on sees none of it', async () => {
  const { page, cleanup } = await launch('{}');
  try {
    await holdSprocket(page);
    // The remembered dashboard gives way to the workspace itself: its
    // sidebar, with the scope picker first.
    await expect(page.locator('.home-navigation > .sidebar-scope-divider')).toBeVisible();
    await expect(dashboard(page)).toHaveCount(0);
    await expect(automationsRow(page)).toHaveCount(0);

    const sections = await settingsSections(page);
    await expect(sections.getByRole('button', { name: 'Scopes', exact: true })).toBeVisible();
    await expect(sections.getByRole('button', { name: 'Secrets', exact: true })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('a computer that turned Automations on sees its row, its dashboard and Secrets', async () => {
  const { page, cleanup } = await launch('{"automations": true}');
  try {
    await holdSprocket(page);
    await expect(dashboard(page)).toBeVisible();
    await expect(automationsRow(page)).toBeVisible();

    const sections = await settingsSections(page);
    await expect(sections.getByRole('button', { name: 'Secrets', exact: true })).toBeVisible();
  } finally {
    await cleanup();
  }
});

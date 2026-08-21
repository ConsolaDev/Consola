import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * Fan-out, end to end: two stub sessions land in a fresh group and the
 * sidebar shows the group with its derived count.
 */

function makeFixture(): { containerDir: string; stubPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-fanout-'));
  const containerDir = path.join(root, 'repos');
  fs.mkdirSync(path.join(containerDir, 'repo-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(containerDir, 'repo-b', '.git'), { recursive: true });

  // \342\235\257 is UTF-8 for ❯ — the composer-ready pattern matches it, so
  // each stub session settles as 'ready' and the badge shows a plain total.
  const stubPath = path.join(root, 'stub-cli.sh');
  fs.writeFileSync(stubPath, "#!/bin/sh\nprintf '\\342\\235\\257 '\nsleep 300\n", {
    mode: 0o755,
  });
  return { containerDir, stubPath };
}

test('fan-out of two stub sessions shows a group with counts', async () => {
  test.setTimeout(90_000);

  const { containerDir, stubPath } = makeFixture();
  const { app, page } = await launchElectron();

  try {
    // Seed a harness whose binary is the stub, and a workspace whose single
    // scope is the container folder. (If Phase 0 changed createWorkspace's
    // signature, adapt the call — the intent is exactly that workspace.)
    await page.evaluate(
      ([binaryPath]) =>
        window.harnessStateAPI.addHarness({
          id: 'stub',
          driverId: 'claude',
          name: 'Stub',
          accentColor: '#4f5bd5',
          binaryPath,
        }),
      [stubPath] as const
    );
    await page.evaluate(
      ([name, folder]) => window.workspaceAPI.createWorkspace(name, folder, false, 'stub'),
      ['fleet', containerDir] as const
    );

    // Point this window at the workspace through the real switcher UI.
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /fleet/ }).click();

    // + New -> Fan-out... (exact: a sidebar scope row also has a "New session
    // in fleet" button, and Playwright's default name match is substring.)
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Fan-out…' }).click();

    // The default scope is the workspace's folder; its child repos appear.
    await page.getByRole('checkbox', { name: 'repo-a' }).check();
    await page.getByRole('checkbox', { name: 'repo-b' }).check();
    await page.getByLabel('Group name').fill('bump-deps');
    await page.getByLabel(/Prompt/).fill('Say hello in each repo.');
    await page.getByRole('button', { name: /Create group · 2 sessions/ }).click();

    // The dialog closes; the sidebar shows the group with both members.
    await expect(page.getByText('bump-deps')).toBeVisible();
    await expect(page.locator('.sidebar').getByText('repo-a')).toBeVisible();
    await expect(page.locator('.sidebar').getByText('repo-b')).toBeVisible();
    // The derived badge: two members, none needing attention.
    await expect(page.locator('.group-nav-count')).toHaveText('2', { timeout: 15_000 });
  } finally {
    await app.close();
  }
});

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';

test('session shells retain state across hiding and switching, and restart independently', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-shell-'));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  const { app, page } = await launchElectron();
  let survivingPid: number | undefined;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const seeded = await page.evaluate(
      async ({ root, checkout, stub }) => {
        await window.harnessStateAPI.addHarness({
          id: 'shell-test',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Shell test',
          root,
          false,
          'shell-test',
        );
        const a = await window.workspaceAPI.createSession(workspace.id, {
          name: 'Session A',
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId: 'shell-a',
          harnessId: 'shell-test',
          scopeId: workspace.scopes[0].id,
          cwd: checkout,
        });
        await window.workspaceAPI.createSession(workspace.id, {
          name: 'Session B',
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId: 'shell-b',
          harnessId: 'shell-test',
          scopeId: workspace.scopes[0].id,
        });
        return { workspaceId: workspace.id, sessionId: a!.id };
      },
      { root, checkout, stub },
    );
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Shell test/ })
      .click();
    await page.locator('.session-nav-item').filter({ hasText: 'Session A' }).click();
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    const conversation = page.locator('[data-conversation-terminal] .terminal-surface textarea');
    // The header's shortcut, not the Terminal tab in the side panel's bar.
    const terminalButton = page.getByRole('button', { name: 'Terminal', exact: true });
    const shell = page.getByTestId('session-shell');
    await conversation.focus();
    await page.keyboard.press('Control+Backquote');
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
    // The person opened it, so it takes the keyboard.
    await expect(shell.locator('textarea')).toBeFocused();
    // Closing its tab, the only one, hides the side panel with it.
    await page.getByRole('button', { name: 'Close Terminal tab', exact: true }).click();
    await expect(shell).toHaveCount(0);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await terminalButton.click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await shell.locator('textarea').fill('');
    await shell
      .locator('textarea')
      .pressSequentially('export CONSOLA_SHELL_TEST=retained; printf "<%s>\\n" "$PWD"');
    await page.keyboard.press('Enter');
    const snapshot = (id: string) =>
      page.evaluate((instanceId) => window.shellAPI.attach({ instanceId, cols: 80, rows: 24 }), id);
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain(`<${checkout}>`);
    // Start delayed output and hide the view before it completes.
    await page.evaluate(() =>
      window.shellAPI.input('shell-a', 'sleep 1; printf "<%s>\\n" "$CONSOLA_SHELL_TEST"\r'),
    );
    // With the Terminal tab in front, the chord hides the side panel.
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('<retained>');
    await page.locator('.session-nav-item').filter({ hasText: 'Session B' }).click();
    // The panel is hidden, so arriving starts no shell for B.
    await expect(page.locator('[data-conversation-terminal]')).toBeVisible();
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    await terminalButton.click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${root}`);
    await page.evaluate(() =>
      window.shellAPI.input('shell-b', 'printf "<%s>\\n" "${CONSOLA_SHELL_TEST-unset}"\r'),
    );
    await expect.poll(async () => (await snapshot('shell-b')).replay).toContain('<unset>');
    // The Terminal tab is still in front, so A's shell comes back by itself;
    // nobody asked for it this time, so the keyboard stays the conversation's.
    // Both terminals attach on the way, in either order, so the shell taking
    // the keyboard and the conversation taking it back would end the same:
    // every focus the shell gets is recorded instead.
    await page.evaluate(() => {
      const record = globalThis as { shellFocuses?: number };
      record.shellFocuses = 0;
      document.addEventListener('focusin', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-testid="session-shell"]')) record.shellFocuses! += 1;
      });
    });
    await page.locator('.session-nav-item').filter({ hasText: 'Session A' }).click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await expect(conversation).toBeFocused();
    const shellFocuses = () =>
      page.evaluate(() => (globalThis as { shellFocuses?: number }).shellFocuses);
    expect(await shellFocuses()).toBe(0);
    // A click on the shell still gives it the keyboard, and is recorded.
    await shell.locator('.terminal-surface').click();
    await expect(shell.locator('textarea')).toBeFocused();
    expect(await shellFocuses()).toBeGreaterThan(0);
    await page.evaluate(() => window.terminalAPI.destroy('shell-a'));
    await page.evaluate(() =>
      window.shellAPI.input('shell-a', 'printf "still-%s\\n" "$CONSOLA_SHELL_TEST"\r'),
    );
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('still-retained');
    await page.screenshot({ path: 'tests/e2e/screenshots/session-shell.png' });
    await page.evaluate(() => window.shellAPI.input('shell-a', 'exit\r'));
    await expect(shell.getByRole('button', { name: 'New shell' })).toBeVisible();
    await shell.getByRole('button', { name: 'New shell' }).click();
    await expect(shell.getByText('Shell exited', { exact: true })).toHaveCount(0);
    // The person asked for a new shell, so it takes the keyboard.
    await expect(shell.locator('textarea')).toBeFocused();
    await page.evaluate(() =>
      window.shellAPI.input('shell-a', 'printf "fresh-%s\\n" "${CONSOLA_SHELL_TEST-unset}"\r'),
    );
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('fresh-unset');
    const pidFile = path.join(root, 'shell-a.pid');
    const otherPidFile = path.join(root, 'shell-b.pid');
    await page.evaluate(
      ({ pidFile, otherPidFile }) => {
        window.shellAPI.input('shell-a', `printf '%s' "$$" > '${pidFile}'\r`);
        window.shellAPI.input('shell-b', `printf '%s' "$$" > '${otherPidFile}'\r`);
      },
      { pidFile, otherPidFile },
    );
    await expect.poll(() => fs.existsSync(pidFile) && fs.existsSync(otherPidFile)).toBe(true);
    const deletedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    survivingPid = Number(fs.readFileSync(otherPidFile, 'utf8'));
    expect(alive(deletedPid)).toBe(true);
    await page.evaluate(
      ({ workspaceId, sessionId }) => window.workspaceAPI.deleteSession(workspaceId, sessionId),
      seeded,
    );
    await expect(snapshot('shell-a')).rejects.toThrow('Session no longer exists');
    await expect.poll(() => alive(deletedPid)).toBe(false);
    expect(alive(survivingPid)).toBe(true);
  } finally {
    await app.close();
    if (survivingPid) await expect.poll(() => alive(survivingPid!)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const seeded = await page.evaluate(async ({ root, checkout, stub }) => {
      await window.harnessStateAPI.addHarness({ id: 'shell-test', driverId: 'claude', name: 'Stub', binaryPath: stub, accentColor: '#555555' });
      const workspace = await window.workspaceAPI.createWorkspace('Shell test', root, false, 'shell-test');
      const a = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Session A', nameIsUserSet: true, workspaceId: workspace.id,
        instanceId: 'shell-a', harnessId: 'shell-test', scopeId: workspace.scopes[0].id, cwd: checkout,
      });
      await window.workspaceAPI.createSession(workspace.id, {
        name: 'Session B', nameIsUserSet: true, workspaceId: workspace.id,
        instanceId: 'shell-b', harnessId: 'shell-test', scopeId: workspace.scopes[0].id,
      });
      return { workspaceId: workspace.id, sessionId: a!.id };
    }, { root, checkout, stub });
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Shell test/ }).click();
    await page.locator('.session-nav-item').filter({ hasText: 'Session A' }).click();
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    await page.locator('.terminal-surface textarea').focus();
    await page.keyboard.press('Control+Backquote');
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await expect(page.locator('.path-display-actions button').last()).toHaveAttribute('aria-label', 'Hide terminal');
    const shell = page.getByTestId('session-shell');
    await shell.getByRole('button', { name: 'Collapse terminal' }).click();
    await expect(shell).toHaveCount(0);
    await page.getByRole('button', { name: 'Show terminal', exact: true }).click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await shell.locator('textarea').fill('');
    await shell.locator('textarea').pressSequentially('export CONSOLA_SHELL_TEST=retained; printf "<%s>\\n" "$PWD"');
    await page.keyboard.press('Enter');
    const snapshot = (id: string) => page.evaluate(instanceId => window.shellAPI.attach({ instanceId, cols: 80, rows: 24 }), id);
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain(`<${checkout}>`);
    // Start delayed output and hide the view before it completes.
    await page.evaluate(() => window.shellAPI.input('shell-a', 'sleep 1; printf "<%s>\\n" "$CONSOLA_SHELL_TEST"\r'));
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('<retained>');
    await page.locator('.session-nav-item').filter({ hasText: 'Session B' }).click();
    await page.getByRole('button', { name: /^(Show|Hide) terminal$/ }).click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${root}`);
    await page.evaluate(() => window.shellAPI.input('shell-b', 'printf "<%s>\\n" "${CONSOLA_SHELL_TEST-unset}"\r'));
    await expect.poll(async () => (await snapshot('shell-b')).replay).toContain('<unset>');
    await page.locator('.session-nav-item').filter({ hasText: 'Session A' }).click();
    await expect(page.getByTestId('session-shell')).toHaveCount(0);
    await page.getByRole('button', { name: /^(Show|Hide) terminal$/ }).click();
    await expect(page.locator('.shell-directory')).toHaveText(`Started in: ${checkout}`);
    await page.evaluate(() => window.terminalAPI.destroy('shell-a'));
    await page.evaluate(() => window.shellAPI.input('shell-a', 'printf "still-%s\\n" "$CONSOLA_SHELL_TEST"\r'));
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('still-retained');
    await page.screenshot({ path: 'tests/e2e/screenshots/session-shell.png' });
    await page.evaluate(() => window.shellAPI.input('shell-a', 'exit\r'));
    await expect(shell.getByRole('button', { name: 'New shell' })).toBeVisible();
    await shell.getByRole('button', { name: 'New shell' }).click();
    await expect(shell.getByText('Shell exited', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.shellAPI.input('shell-a', 'printf "fresh-%s\\n" "${CONSOLA_SHELL_TEST-unset}"\r'));
    await expect.poll(async () => (await snapshot('shell-a')).replay).toContain('fresh-unset');
    const pidFile = path.join(root, 'shell-a.pid');
    const otherPidFile = path.join(root, 'shell-b.pid');
    await page.evaluate(({ pidFile, otherPidFile }) => {
      window.shellAPI.input('shell-a', `printf '%s' "$$" > '${pidFile}'\r`);
      window.shellAPI.input('shell-b', `printf '%s' "$$" > '${otherPidFile}'\r`);
    }, { pidFile, otherPidFile });
    await expect.poll(() => fs.existsSync(pidFile) && fs.existsSync(otherPidFile)).toBe(true);
    const deletedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    survivingPid = Number(fs.readFileSync(otherPidFile, 'utf8'));
    expect(alive(deletedPid)).toBe(true);
    await page.evaluate(({ workspaceId, sessionId }) => window.workspaceAPI.deleteSession(workspaceId, sessionId), seeded);
    await expect(snapshot('shell-a')).rejects.toThrow('Session no longer exists');
    await expect.poll(() => alive(deletedPid)).toBe(false);
    expect(alive(survivingPid)).toBe(true);
  } finally {
    await app.close();
    if (survivingPid) await expect.poll(() => alive(survivingPid!)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

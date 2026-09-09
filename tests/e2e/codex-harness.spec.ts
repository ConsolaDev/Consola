import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron, settingsChord } from './helpers/electron';

test('adds a Codex harness in settings, launches a prompt, and resumes after an app restart', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-codex-e2e-'));
  const codexHome = path.join(root, 'profile');
  fs.mkdirSync(codexHome);
  const userDataDir = createProfileDir();
  let running = await launchElectron({ userDataDir });
  const launches = () => {
    const file = path.join(codexHome, 'launches.jsonl');
    return fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      : [];
  };
  try {
    const { page } = running;
    await page.keyboard.press(settingsChord());
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Harnesses', exact: true }).click();
    await settings.getByRole('button', { name: 'Add harness', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: 'Add harness', exact: true });
    await wizard.getByRole('button', { name: /Codex/ }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Name', { exact: true }).fill('Codex test');
    await expect(wizard.getByLabel('Instance ID')).toHaveValue('codex-test');
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(wizard.getByLabel('Binary path')).toHaveAttribute('placeholder', 'codex');
    await wizard.getByLabel('Binary path').fill(path.resolve('tests/fixtures/codex.cjs'));
    await wizard.getByLabel('CODEX_HOME path').fill(codexHome);
    await wizard.getByRole('button', { name: 'Add harness', exact: true }).click();
    await expect(settings.getByText('Authenticated as ChatGPT')).toBeVisible();
    await settings.getByRole('button', { name: 'Edit Codex test' }).click();
    const editor = page.getByRole('dialog', { name: /Edit harness/ });
    await expect(editor.getByLabel('CODEX_HOME path')).toHaveValue(codexHome);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();

    await page.evaluate(folder => window.workspaceAPI.createWorkspace('Codex workspace', folder, false, 'codex-test'), root);
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /Codex workspace/ }).click();
    await expect(page.locator('.new-session-header').getByRole('button', { name: 'Codex test' })).toBeVisible();
    const composer = page.locator('.new-session-view textarea');
    await composer.fill('Explain the project');
    await composer.press('Enter');
    await expect.poll(() => launches().length).toBe(1);
    const first = launches()[0];
    expect(first.args[0]).toBe('resume');
    expect(first.args.slice(-2)).toEqual(['--', 'Explain the project']);
    expect(first.home).toBe(codexHome);
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();

    await running.app.close();
    running = await launchElectron({ userDataDir });
    // Restore through the sidebar as well as the persisted workspace view.
    await running.page.getByRole('button', { name: /^Switch workspace/ }).click();
    await running.page.getByRole('menuitem', { name: /Codex workspace/ }).click();
    await running.page.locator('.sidebar').getByText('New Session', { exact: true }).click();
    await expect.poll(() => launches().length).toBe(2);
    expect(launches()[1].args.slice(0, 2)).toEqual(first.args.slice(0, 2));
    expect(launches()[1].args).not.toContain('Explain the project');
  } finally {
    await running.app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});

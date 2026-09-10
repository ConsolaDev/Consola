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
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Codex workspace/ }).click();
    await expect(page.getByRole('button', { name: 'Choose agent', exact: true })).toHaveText('Codex test');
    await expect(page.getByRole('button', { name: 'Choose model' })).toBeEnabled();
    await page.getByRole('button', { name: 'Choose model' }).click();
    await page.getByRole('menuitem', { name: 'fixture-model-b', exact: true }).click();
    const composer = page.locator('.new-session-view textarea');
    await composer.fill('Explain the project');
    await composer.press('Enter');
    await expect.poll(() => launches().length).toBe(1);
    const first = launches()[0];
    expect(first.args[0]).toBe('resume');
    expect(first.args).toContain('--model');
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('fixture-model-b');
    expect(first.args.slice(-2)).toEqual(['--', 'Explain the project']);
    expect(first.home).toBe(codexHome);
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();

    // A tab can change conversations without restarting its PTY.
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();
    await page.keyboard.type('/new');
    await page.keyboard.press('Enter');
    const activePath = path.join(codexHome, 'active-thread');
    await expect.poll(() => fs.existsSync(activePath)).toBe(true);
    const activeThread = fs.readFileSync(activePath, 'utf8');
    expect(activeThread).not.toBe(first.args[1]);
    await expect.poll(() => {
      const mappings = path.join(codexHome, 'consola', 'sessions');
      return fs.readdirSync(mappings).filter(file => file.endsWith('.json'))
        .map(file => JSON.parse(fs.readFileSync(path.join(mappings, file), 'utf8')).threadId);
    }).toContain(activeThread);

    await running.app.close();
    running = await launchElectron({ userDataDir });
    // Restore through the sidebar as well as the persisted workspace view.
    await running.page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Codex workspace/ }).click();
    await running.page.locator('.sidebar').getByText('New Session', { exact: true }).click();
    await expect.poll(() => launches().length).toBe(2);
    expect(launches()[1].args.slice(0, 2)).toEqual(['resume', activeThread]);
    expect(launches()[1].args).not.toContain('Explain the project');
  } finally {
    await running.app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBuiltInHarness } from '../../src/shared/harness';
import { createProfileDir, launchElectron, settingsChord } from './helpers/electron';

test('adds an Antigravity harness in settings, launches a configured session, and resumes after an app restart', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-antigravity-e2e-'));
  const fakeHome = path.join(root, 'home');
  const agyDataDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(agyDataDir, { recursive: true });
  const userDataDir = createProfileDir();
  const env = { HOME: fakeHome, CONSOLA_AGY_FIXTURE_DIR: agyDataDir };

  let running = await launchElectron({ userDataDir, env });
  const launches = () => {
    const file = path.join(agyDataDir, 'launches.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { args: string[]; conversationId: string })
      : [];
  };

  try {
    const { page } = running;
    await page.keyboard.press(settingsChord());
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Harnesses', exact: true }).click();
    await settings.getByRole('button', { name: 'Add harness', exact: true }).click();

    const wizard = page.getByRole('dialog', { name: 'Add harness', exact: true });
    await wizard.getByRole('button', { name: /Antigravity/ }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Name', { exact: true }).fill('Antigravity test');
    await expect(wizard.getByLabel('Instance ID')).toHaveValue('antigravity-test');
    await wizard.getByRole('button', { name: 'Next' }).click();

    await expect(wizard.getByLabel('Binary path')).toHaveAttribute('placeholder', 'agy');
    await expect(wizard.getByLabel('Launch arguments')).toHaveAttribute(
      'placeholder',
      'e.g. --mode plan',
    );
    await expect(wizard.getByText(/~\/\.gemini\/antigravity-cli/)).toBeVisible();
    await wizard.getByLabel('Binary path').fill(path.resolve('tests/fixtures/antigravity.cjs'));
    await wizard.getByRole('button', { name: 'Add harness', exact: true }).click();

    await expect(settings.getByText('Authenticated as Google')).toBeVisible();
    await settings.getByRole('button', { name: 'Edit Antigravity test' }).click();
    const editor = page.getByRole('dialog', { name: /Edit harness/ });
    await expect(editor.getByLabel('Binary path')).toHaveValue(
      path.resolve('tests/fixtures/antigravity.cjs'),
    );
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();

    await page.evaluate(
      (folder) =>
        window.workspaceAPI.createWorkspace(
          'Antigravity workspace',
          folder,
          false,
          'antigravity-test',
        ),
      root,
    );
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Antigravity workspace/ })
      .click();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN',
    );
    await expect(page.getByLabel('Agent', { exact: true })).toContainText('Antigravity test');
    await expect(page.getByLabel('Model', { exact: true })).toBeEnabled();
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option', { name: 'Gemini 4 Neon (XHigh)', exact: true }).click();
    await page.getByRole('button', { name: 'Create session' }).click();

    await expect.poll(() => launches().length).toBe(1);
    const first = launches()[0];
    expect(first.args).not.toContain('--conversation');
    expect(first.args).toContain('--model');
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('gemini-4-neon-xhigh');
    expect(first.args).toContain('--settings');
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();

    // Verify scrollback scrolling moves through conversation output.
    const slider = page.locator(
      '.terminal-surface .xterm-scrollable-element > .scrollbar.vertical > .slider',
    );
    const sliderTop = () =>
      slider.evaluate((element) => Number.parseFloat((element as HTMLElement).style.top));
    await expect.poll(sliderTop).toBeGreaterThan(0);
    const bottom = await sliderTop();
    await page.locator('.terminal-surface .xterm-screen').hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(sliderTop).toBeLessThan(bottom);
    await page.mouse.wheel(0, 10_000);
    await expect.poll(sliderTop).toBe(bottom);

    // A tab can switch conversations via /new without restarting its PTY.
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();
    await page.keyboard.type('/new');
    await page.keyboard.press('Enter');
    const activePath = path.join(agyDataDir, 'active-conversation');
    await expect.poll(() => fs.existsSync(activePath)).toBe(true);
    const activeConversation = fs.readFileSync(activePath, 'utf8');
    expect(activeConversation).not.toBe(first.conversationId);

    await expect
      .poll(() => {
        const mappings = path.join(agyDataDir, 'consola', 'sessions');
        if (!fs.existsSync(mappings)) return [];
        return fs
          .readdirSync(mappings)
          .filter((file) => file.endsWith('.json'))
          .map(
            (file) => JSON.parse(fs.readFileSync(path.join(mappings, file), 'utf8')).conversationId,
          );
      })
      .toContain(activeConversation);

    await running.app.close();
    running = await launchElectron({ userDataDir, env });
    await running.page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Antigravity workspace/ })
      .click();
    await running.page.locator('.sidebar').getByText('New Session', { exact: true }).click();
    await expect.poll(() => launches().length).toBe(2);
    expect(launches()[1].args.slice(0, 2)).toEqual(['--conversation', activeConversation]);
  } finally {
    await running.app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});

test('hands a Claude conversation to Antigravity from the Switch harness menu', async () => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-antigravity-switch-e2e-'));
  const fakeHome = path.join(root, 'home');
  const agyDataDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
  const claudeProfile = path.join(root, 'claude-profile');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(agyDataDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  const conversationId = 'cccccccc-1111-4111-8111-111111111111';
  const project = path.join(claudeProfile, 'projects', '-tmp-repo');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, `${conversationId}.jsonl`),
    [
      {
        type: 'user',
        timestamp: '2026-11-17T20:00:00Z',
        message: { role: 'user', content: 'Audit the cache invalidation path' },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-17T20:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found a stale key on workspace switch.' }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  const userDataDir = createProfileDir();
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });

  const builtIn = { ...createBuiltInHarness(), enabled: false };
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({
      version: 1,
      harnesses: [
        builtIn,
        {
          ...builtIn,
          id: 'claude-local',
          name: 'Claude local',
          isBuiltIn: false,
          enabled: true,
          configDir: claudeProfile,
          binaryPath: '/usr/bin/true',
        },
        {
          ...builtIn,
          id: 'antigravity-test',
          driverId: 'antigravity',
          name: 'Antigravity test',
          isBuiltIn: false,
          enabled: true,
          archived: false,
          binaryPath: path.resolve('tests/fixtures/antigravity.cjs'),
        },
      ],
    }),
  );

  const now = Date.now();
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 7,
      workspaces: [
        {
          id: 'ws-agy-switch-e2e',
          name: 'Antigravity Switch',
          defaultHarnessId: 'claude-local',
          scopes: [
            { id: 'scope-repo', name: 'repo', path: repo, isGitRepo: false, createdAt: now },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            {
              id: 's1',
              name: 'Audit cache invalidation',
              workspaceId: 'ws-agy-switch-e2e',
              instanceId: 'inst-s1',
              claudeSessionId: conversationId,
              hasStarted: true,
              harnessId: 'claude-local',
              model: 'opus',
              scopeId: 'scope-repo',
              kind: 'interactive',
              createdAt: now,
              lastActiveAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  );

  const env = { HOME: fakeHome, CONSOLA_AGY_FIXTURE_DIR: agyDataDir };
  const running = await launchElectron({ userDataDir, env });
  const launches = () => {
    const file = path.join(agyDataDir, 'launches.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { args: string[]; conversationId: string })
      : [];
  };

  try {
    const { page } = running;
    const row = () => page.locator('.session-nav-item').filter({ hasText: /cache invalidation/i });

    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Antigravity Switch', exact: true })
      .click();
    await row().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Switch harness…', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Switch harness', exact: true });
    await expect(dialog).toContainText('It runs on Claude local now.');
    await expect(dialog.getByRole('radio', { name: /Antigravity test/ })).toBeChecked();
    await expect(dialog).toContainText('reads a transcript of this one');
    await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(() => launches().length).toBe(1);
    const first = launches()[0];
    const promptFlag = first.args.indexOf('--prompt-interactive');
    expect(promptFlag).toBeGreaterThan(-1);
    const prompt = first.args[promptFlag + 1];
    expect(prompt).toMatch(/A transcript of it is saved at .*handoffs/);

    const session = await page.evaluate(
      async () =>
        (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.find(
          (candidate) => candidate.id === 's1',
        )!,
    );
    expect(session).toMatchObject({
      harnessId: 'antigravity-test',
      hasStarted: true,
      nameIsUserSet: true,
    });
    expect(session.model).toBeUndefined();
    expect(session.priorConversations).toEqual([
      expect.objectContaining({
        harnessId: 'claude-local',
        claudeSessionId: conversationId,
        carried: 'handoff',
      }),
    ]);
    const handoff = fs.readFileSync(session.priorConversations![0].handoffPath!, 'utf8');
    expect(handoff).toContain('Audit the cache invalidation path');
    expect(handoff).toContain('Found a stale key on workspace switch.');
    expect(prompt).toContain(session.priorConversations![0].handoffPath!);

    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
    await expect(row().locator('[data-harness-type="antigravity"]')).toHaveCount(1);
    await row().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Switch harness…', exact: true }).click();
    const back = page.getByRole('dialog', { name: 'Switch harness', exact: true });
    await expect(back).toContainText('It runs on Antigravity test now.');
    await expect(back.getByRole('radio', { name: /Claude local/ })).toBeChecked();
  } finally {
    await running.app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});

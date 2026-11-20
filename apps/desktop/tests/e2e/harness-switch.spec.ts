import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

const WORKSPACE_NAME = 'Switching';
const CONVERSATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let root: string;

/**
 * A Claude session that already has a conversation, and an enabled Codex
 * harness (the offline fixture) to hand it to. The transcript is written
 * where the built-in harness's config directory keeps it; nothing here runs
 * a real CLI.
 */
function seed(profileDir: string): { codexHome: string } {
  const effective = `${profileDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const claudeProfile = path.join(root, 'claude-profile');
  const codexHome = path.join(root, 'codex-profile');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  const project = path.join(claudeProfile, 'projects', '-tmp-repo');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, `${CONVERSATION_ID}.jsonl`),
    [
      {
        type: 'user',
        timestamp: '2026-11-17T20:00:00Z',
        message: { role: 'user', content: 'Make the login test reliable' },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-17T20:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The race is in the session fixture.' }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  // The built-in harness pins nothing — it would read and run the ambient
  // Claude — so the conversation lives on a harness of its own, whose
  // "CLI" exits at once if the pane starts it.
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
          id: 'codex-test',
          driverId: 'codex',
          name: 'Codex test',
          isBuiltIn: false,
          enabled: true,
          archived: false,
          configDir: codexHome,
          binaryPath: path.resolve('tests/fixtures/codex.cjs'),
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
          id: 'ws-switch-e2e',
          name: WORKSPACE_NAME,
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
              name: 'Fix flaky login test',
              workspaceId: 'ws-switch-e2e',
              instanceId: 'inst-s1',
              claudeSessionId: CONVERSATION_ID,
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
  return { codexHome };
}

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('hands a Claude conversation to Codex from the session menu, in the same tab', async () => {
  test.setTimeout(60_000);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-switch-e2e-'));
  userDataDir = createProfileDir();
  const { codexHome } = seed(userDataDir);
  ({ app, page } = await launchElectron({ userDataDir }));
  const launches = () => {
    const file = path.join(codexHome, 'launches.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { args: string[] })
      : [];
  };

  // The row soon takes its name from the transcript's opening prompt, and a handoff keeps that name.
  const row = () => page.locator('.session-nav-item').filter({ hasText: /login test/ });

  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true })
    .click();
  await row().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Switch harness…', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Switch harness', exact: true });
  await expect(dialog).toContainText('It runs on Claude local now.');
  const codex = dialog.getByRole('radio', { name: /Codex test/ });
  await expect(codex).toBeChecked();
  await expect(dialog).toContainText('reads a transcript of this one');
  await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Codex starts on a fresh conversation whose opening prompt points at the handoff.
  await expect.poll(() => launches().length).toBe(1);
  const prompt = launches()[0].args.at(-1)!;
  expect(prompt).toMatch(/A transcript of it is saved at .*handoffs/);

  // The record moved with it: same session, new harness and conversation, the old one remembered.
  const session = await page.evaluate(
    async () =>
      (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.find(
        (candidate) => candidate.id === 's1',
      )!,
  );
  expect(session).toMatchObject({ harnessId: 'codex-test', hasStarted: true, nameIsUserSet: true });
  expect(session.model).toBeUndefined();
  expect(session.claudeSessionId).not.toBe(CONVERSATION_ID);
  expect(session.priorConversations).toEqual([
    expect.objectContaining({
      harnessId: 'claude-local',
      claudeSessionId: CONVERSATION_ID,
      carried: 'handoff',
    }),
  ]);
  const handoff = fs.readFileSync(session.priorConversations![0].handoffPath!, 'utf8');
  expect(handoff).toContain('Make the login test reliable');
  expect(handoff).toContain('The race is in the session fixture.');
  expect(prompt).toContain(session.priorConversations![0].handoffPath!);

  // It is the tab on screen now, and going back is a handoff the other way.
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
  await expect(row()).toContainText('Make the login test reliable');
  await expect(row().locator('[data-harness-type="codex"]')).toHaveCount(1);
  await row().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Switch harness…', exact: true }).click();
  const back = page.getByRole('dialog', { name: 'Switch harness', exact: true });
  await expect(back).toContainText('It runs on Codex test now.');
  await expect(back.getByRole('radio', { name: /Claude local/ })).toBeChecked();
  await expect(back).toContainText('Starts a new conversation on Claude local');
});

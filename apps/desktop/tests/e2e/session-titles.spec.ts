import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';
import type { Session, Workspace } from '../../src/shared/workspace';

const WORKSPACE_NAME = 'Titles';
const BUMP_DEPS_CONVERSATION = 'aaaaaaaa-1111-4111-8111-111111111111';
const OLD_NAME_CONVERSATION = 'bbbbbbbb-2222-4222-8222-222222222222';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let root: string;
/** The fixture harness's config directory: its transcripts, fixture.json and title-calls.jsonl. */
let claudeProfile: string;

/** What the fixture CLI does, read by each process it starts (`tests/fixtures/claude-titles.cjs`). */
interface FixtureSettings {
  firstPrompt?: string;
  title: string;
  titleDelayMs?: number;
  /** A resumed conversation prints like a running turn for this long after it launches. */
  resumeWorkMs?: number;
}

function writeFixture(settings: FixtureSettings): void {
  fs.writeFileSync(path.join(claudeProfile, 'fixture.json'), JSON.stringify(settings));
}

/** Every title call the fixture answered, oldest first. */
function readTitleCalls(): { argv: string[]; stdin: string; cwd: string }[] {
  const file = path.join(claudeProfile, 'title-calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** The session called `name` as main last wrote it to disk. */
function storedSession(name: string): Session | undefined {
  const file = path.join(`${userDataDir} Test`, 'workspaces.json');
  const { workspaces } = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaces: Workspace[] };
  return workspaces.flatMap((workspace) => workspace.sessions).find((s) => s.name === name);
}

/** A sidebar row, by the name it renders. */
const rowFor = (target: Page, name: string) =>
  target.locator('.session-nav-item').filter({ hasText: name });

/**
 * Counts, from here on, every time a terminal asks for focus while a rename
 * field is open. A session's terminal takes focus once it has started, which
 * is after the first click of a double-click opened it.
 */
async function countFocusThefts(target: Page): Promise<void> {
  await target.evaluate(() => {
    const counter = window as unknown as { focusThefts: number };
    counter.focusThefts = 0;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (
        this.classList.contains('xterm-helper-textarea') &&
        document.querySelector('.session-rename-input')
      ) {
        counter.focusThefts += 1;
      }
      focus.call(this, options);
    };
  });
}

const focusThefts = (target: Page) =>
  target.evaluate(() => (window as unknown as { focusThefts: number }).focusThefts);

/**
 * A workspace whose sessions run on the offline fixture CLI, which also
 * writes every title. `Bump deps` has run before; `Old name` has a
 * conversation to regenerate a title from.
 */
function seed(profileDir: string): void {
  const effective = `${profileDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const project = path.join(claudeProfile, 'projects', '-tmp-repo');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, `${OLD_NAME_CONVERSATION}.jsonl`),
    [
      {
        type: 'user',
        timestamp: '2026-11-17T20:00:00Z',
        sessionId: OLD_NAME_CONVERSATION,
        message: { role: 'user', content: 'Why does the nightly export skip archived invoices?' },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-17T20:01:00Z',
        sessionId: OLD_NAME_CONVERSATION,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The export query filters on status = active.' }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  // The built-in harness pins nothing, so it would run the ambient Claude.
  const builtIn = { ...createBuiltInHarness(), enabled: false };
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({
      version: 1,
      harnesses: [
        builtIn,
        {
          ...builtIn,
          id: 'claude-fixture',
          name: 'Claude fixture',
          isBuiltIn: false,
          enabled: true,
          configDir: claudeProfile,
          binaryPath: path.resolve('tests/fixtures/claude-titles.cjs'),
        },
      ],
    }),
  );

  const now = Date.now();
  const session = (id: string, name: string, claudeSessionId: string) => ({
    id,
    name,
    workspaceId: 'ws-titles-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId,
    hasStarted: true,
    harnessId: 'claude-fixture',
    scopeId: 'scope-repo',
    kind: 'interactive',
    createdAt: now,
    lastActiveAt: now,
  });
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 7,
      workspaces: [
        {
          id: 'ws-titles-e2e',
          name: WORKSPACE_NAME,
          defaultHarnessId: 'claude-fixture',
          scopes: [
            { id: 'scope-repo', name: 'repo', path: repo, isGitRepo: false, createdAt: now },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('s-bump', 'Bump deps', BUMP_DEPS_CONVERSATION),
            session('s-old', 'Old name', OLD_NAME_CONVERSATION),
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  );
}

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-titles-e2e-'));
  claudeProfile = path.join(root, 'claude-profile');
  fs.mkdirSync(claudeProfile, { recursive: true });
  userDataDir = createProfileDir();
  seed(userDataDir);
  ({ app, page } = await launchElectron({ userDataDir }));
  const workspace = page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await workspace.click();
  await expect(workspace).toHaveAttribute('aria-current', 'true');
});

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  // A fixture CLI may still be writing its profile as the app closes.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('a new session is named from its first message, then titled, with its pane closed', async () => {
  writeFixture({
    firstPrompt: 'Make the checkout page remember the last used payment method across devices',
    title: 'Remember Payment Method',
    titleDelayMs: 1500,
  });
  await page.getByRole('button', { name: 'New session' }).first().click();
  await rowFor(page, 'New Session').waitFor();
  await rowFor(page, 'Bump deps').click(); // the new pane unmounts
  await expect(page.locator('.workspace-view-header .workspace-view-session')).toHaveText(
    'Bump deps',
  );
  await expect(rowFor(page, 'Make the checkout page remember the last used paym…')).toBeVisible({
    timeout: 10_000,
  });
  await expect(rowFor(page, 'Remember Payment Method')).toBeVisible({ timeout: 10_000 });
  const calls = readTitleCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].cwd).toBe(os.homedir());
  expect(calls[0].argv).toEqual(
    expect.arrayContaining(['--no-session-persistence', '--model', 'haiku']),
  );
  expect(calls[0].stdin).toContain('User message:\nMake the checkout page');
  // A generated name is not the person's own.
  expect(storedSession('Remember Payment Method')).not.toHaveProperty('nameIsUserSet', true);
});

test('double-clicking a row renames it, and survives its terminal taking focus', async () => {
  // Bump deps has run before, and its CLI starts working as soon as it is
  // launched: the first click of the double-click does that.
  writeFixture({ title: 'Unused', resumeWorkMs: 8_000 });
  await countFocusThefts(page);
  await rowFor(page, 'Bump deps').dblclick();
  const input = page.locator('.session-nav-item .session-rename-input');
  await expect(input).toBeFocused();

  // The terminal mounts and asks for focus while the field is open...
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
  await expect.poll(() => focusThefts(page)).toBeGreaterThan(0);
  // ...and the CLI starts working, which sends a row to the Working shelf: a
  // row mounted afresh there would have lost the field.
  await expect(page.getByRole('button', { name: /^Bump deps — working/ })).toHaveCount(1);
  await expect(input).toBeFocused();

  // Real keystrokes, so they go wherever focus really is.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Dependency refresh');
  await page.keyboard.press('Enter');
  await expect(rowFor(page, 'Dependency refresh')).toBeVisible();
  await expect.poll(() => storedSession('Dependency refresh')?.nameIsUserSet).toBe(true);
});

test('F2 on a focused row renames it; Escape cancels and an empty name is refused', async () => {
  const input = page.locator('.session-nav-item .session-rename-input');
  // Focused, not clicked: nothing opens, so no terminal is involved.
  await rowFor(page, 'Bump deps').focus();

  // Escape throws the draft away and hands focus back to the row.
  await page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Bump deps');
  await page.keyboard.type('Thrown away');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(rowFor(page, 'Bump deps')).toBeFocused();
  expect(storedSession('Bump deps')).not.toHaveProperty('nameIsUserSet', true);

  // An empty name is refused, and the name stays.
  await page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: 'A session needs a name.' })).toBeVisible();
  await expect(input).toHaveCount(0);
  await expect(rowFor(page, 'Bump deps')).toBeFocused();
  expect(storedSession('Bump deps')).not.toHaveProperty('nameIsUserSet', true);

  // Typing a name and pressing Enter saves it as the person's own.
  await page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await page.keyboard.type('Keyboard rename');
  await page.keyboard.press('Enter');
  await expect(rowFor(page, 'Keyboard rename')).toBeVisible();
  await expect(rowFor(page, 'Keyboard rename')).toBeFocused();
  await expect.poll(() => storedSession('Keyboard rename')?.nameIsUserSet).toBe(true);
  expect(storedSession('Bump deps')).toBeUndefined();
});

test('double-clicking the header name renames the open session', async () => {
  await rowFor(page, 'Bump deps').click();
  await page.locator('.workspace-view-header .workspace-view-session').dblclick();
  const input = page.getByLabel('Session name');
  await input.fill('Header rename');
  await input.press('Enter');
  await expect(page.locator('.workspace-view-session')).toHaveText('Header rename');
  await expect(rowFor(page, 'Header rename')).toBeVisible();
  await expect.poll(() => storedSession('Header rename')?.nameIsUserSet).toBe(true);
});

test('Regenerate title replaces the name from the whole conversation', async () => {
  writeFixture({ title: 'Regenerated Fixture Title' });
  await rowFor(page, 'Old name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Regenerate title' }).click();
  await expect(rowFor(page, 'Regenerated Fixture Title')).toBeVisible({ timeout: 10_000 });
  const stdin = readTitleCalls().at(-1)!.stdin;
  expect(stdin).toContain('The previous title was "Old name".');
  // The whole conversation: what the person asked and what the agent said.
  expect(stdin).toContain('USER: Why does the nightly export skip archived invoices?');
  expect(stdin).toContain('ASSISTANT: The export query filters on status = active.');
});

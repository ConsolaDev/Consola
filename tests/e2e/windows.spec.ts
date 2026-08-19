import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectron, newWindowChord } from './helpers/electron';

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  ({ app, page } = await launchElectron());
});

test.afterEach(async () => {
  await app.close();
});

/** Create a workspace without going through the native folder picker. */
async function seedWorkspace(target: Page, name: string, folder: string): Promise<string> {
  return target.evaluate(
    ([workspaceName, workspacePath]) =>
      window.workspaceAPI
        .createWorkspace(workspaceName, workspacePath, false)
        .then((workspace) => workspace.id),
    [name, folder] as const
  );
}

/**
 * The switcher trigger's accessible name is always "Switch workspace" (plus a
 * suffix when another workspace wants attention) -- it never names the held
 * workspace. What names the held workspace is the trigger's own *text*, which
 * this locator's caller reads separately: the workspace's name when this
 * window holds one, "Select workspace" when it holds none.
 */
function switcherTrigger(target: Page) {
  return target.getByRole('button', { name: /^Switch workspace/ });
}

test('the new-window chord opens a second window', async () => {
  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  expect(app.windows()).toHaveLength(2);
});

test('a workspace created in one window appears in the other', async () => {
  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  await seedWorkspace(page, 'alpha', '/tmp/alpha');

  // Radix does not mount the dropdown's content into the DOM until it opens,
  // so the workspace name is not in the tree until the switcher is open.
  // Asserting through the real path -- main's broadcast, the renderer's
  // store, the rendered list -- is the point of this test; querying main
  // directly (workspaceAPI.getSnapshot()) would pass even if the broadcast
  // never reached the renderer.
  await second.getByRole('button', { name: /^Switch workspace/ }).click();

  await expect
    .poll(() => second.getByRole('menuitem', { name: /alpha/ }).count())
    .toBeGreaterThan(0);
});

test('a workspace open in one window is focused, not duplicated, from another', async () => {
  const workspaceId = await seedWorkspace(page, 'alpha', '/tmp/alpha');

  // Activated through the real UI, not the raw IPC call `seedWorkspace` uses
  // for creation: `windowAPI.activateWorkspace` only updates main's registry.
  // The renderer's own idea of which workspace it holds -- what the trigger
  // renders -- only updates inside the store's setActiveWorkspace action,
  // which a click reaches and a raw evaluate() call does not (confirmed by
  // hand: an identical raw call here left the trigger reading "Select
  // workspace" despite main returning 'took'). A UI-side assertion needs a
  // UI-side cause.
  await switcherTrigger(page).click();
  await page.getByRole('menuitem', { name: /alpha/ }).click();
  await expect(switcherTrigger(page)).toHaveText('alpha');

  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  // The verdict is main's opinion; the two assertions below it are the fact.
  // A regression that quietly double-assigned the workspace while still
  // returning this same string would pass on the verdict alone.
  const verdict = await second.evaluate(
    (id) => window.windowAPI.activateWorkspace(id),
    workspaceId
  );
  expect(verdict).toBe('focused-elsewhere');
  expect(app.windows()).toHaveLength(2);

  // Window 1 is still the holder -- requesting it from elsewhere must not
  // have evicted it.
  await expect(switcherTrigger(page)).toHaveText('alpha');

  // Window 2 did not also become a holder. This attempt goes through the
  // same real UI path as window 1's did above (not a second raw IPC call),
  // so the assertion actually exercises the renderer's own
  // `if (verdict === 'took')` gate rather than trusting that a call which
  // never reaches it left nothing to update.
  await switcherTrigger(second).click();
  await second.getByRole('menuitem', { name: /alpha/ }).click();
  await expect(switcherTrigger(second)).toHaveText('Select workspace');
});

test('workspaces survive a relaunch through the state file, not localStorage', async () => {
  const { app: first, page: firstPage, userDataDir } = await launchElectron();
  await seedWorkspace(firstPage, 'persisted', '/tmp/persisted');
  await first.close();

  const { app: second, page: secondPage } = await launchElectron({ userDataDir });
  const names = await secondPage.evaluate(() =>
    window.workspaceAPI.getSnapshot().then((snapshot) => snapshot.workspaces.map((w) => w.name))
  );
  await second.close();

  expect(names).toContain('persisted');
});

test('closing a window leaves its session running', async () => {
  const workspaceId = await seedWorkspace(page, 'alpha', process.cwd());
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), workspaceId);

  const instanceId = `workspace-${workspaceId}-session-e2e`;
  await page.evaluate(
    ([instance, cwd]) =>
      window.terminalAPI.create({
        instanceId: instance,
        cwd,
        claudeSessionId: '22222222-2222-4222-8222-222222222222',
        resume: false,
        cols: 80,
        rows: 24,
      }),
    [instanceId, process.cwd()] as const
  );

  // `claude` takes a beat after spawn to write its first bytes (confirmed by
  // hand: reattaching in the very same window reads back empty for the first
  // ~800ms and then fills in). Poll here, still in window 1, until real
  // output has actually landed -- an environmental timing window, not a
  // loosened assertion: the check is still exactly `replay.length > 0`. This
  // establishes the baseline the discriminator below depends on: that the
  // buffer is non-empty going into the window switch.
  await expect
    .poll(
      async () => {
        const snapshot = await page.evaluate(
          ([instance, cwd]) =>
            window.terminalAPI.create({
              instanceId: instance,
              cwd,
              claudeSessionId: '22222222-2222-4222-8222-222222222222',
              resume: true,
              cols: 80,
              rows: 24,
            }),
          [instanceId, process.cwd()] as const
        );
        return snapshot.replay.length;
      },
      { timeout: 15000 }
    )
    .toBeGreaterThan(0);

  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  await page.close();

  // The discriminator. `TerminalManager.ensure()` is synchronous: for an
  // EXISTING terminal it returns the already-accumulated buffer immediately;
  // for a terminal it has to construct fresh, it calls `start()` and returns
  // `getReplayBuffer()` in the same tick, before the newly spawned process has
  // written anything. A surviving PTY therefore yields a non-empty buffer on
  // this very first reattach call; a terminal a regression tore down and
  // restarted when window 1 closed yields an empty buffer that would only
  // fill in later, same as the poll above measured on the original spawn.
  //
  // Deliberately NOT wrapped in expect.poll: polling here would wait out
  // exactly the startup gap that tells a restarted terminal apart from a
  // surviving one, and this assertion would pass either way -- which is to
  // say it would stop testing what this test is named for.
  const snapshot = await second.evaluate(
    ([instance, cwd]) =>
      window.terminalAPI.create({
        instanceId: instance,
        cwd,
        claudeSessionId: '22222222-2222-4222-8222-222222222222',
        resume: true,
        cols: 80,
        rows: 24,
      }),
    [instanceId, process.cwd()] as const
  );

  expect(snapshot.replay.length).toBeGreaterThan(0);
});

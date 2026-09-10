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

function workspaceButton(target: Page) {
  return target.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'alpha', exact: true });
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

  // The rail reflects main's broadcast without opening a picker.
  await expect(workspaceButton(second)).toBeVisible();
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
  await workspaceButton(page).click();
  await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');

  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  // The verdict is main's opinion; the two assertions below it are the fact.
  // A regression that quietly double-assigned the workspace while still
  // returning this same string would pass on the verdict alone.
  const result = await second.evaluate(
    (id) => window.windowAPI.activateWorkspace(id),
    workspaceId
  );
  expect(result.verdict).toBe('focused-elsewhere');
  expect(app.windows()).toHaveLength(2);

  // Window 1 is still the holder -- requesting it from elsewhere must not
  // have evicted it.
  await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');

  // Window 2 did not also become a holder. This attempt goes through the
  // same real UI path as window 1's did above (not a second raw IPC call),
  // so the assertion actually exercises the renderer's own
  // `if (verdict === 'took')` gate rather than trusting that a call which
  // never reaches it left nothing to update.
  await workspaceButton(second).click();
  await expect(workspaceButton(second)).not.toHaveAttribute('aria-current', 'true');
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

/**
 * Create a session through the real API, in the workspace's own first scope.
 *
 * A session must name a scope that exists — `createSession` refuses quietly
 * otherwise — and the scope id is minted by main when the workspace is
 * created, so it has to be read back rather than guessed.
 */
async function seedSession(target: Page, workspaceId: string, name: string): Promise<string> {
  return target.evaluate(
    async ([id, sessionName]) => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      const workspace = workspaces.find((candidate) => candidate.id === id)!;
      const session = await window.workspaceAPI.createSession(id, {
        name: sessionName,
        workspaceId: id,
        instanceId: `workspace-${id}-session-${sessionName.replace(/\s/g, '-')}`,
        harnessId: workspace.defaultHarnessId,
        scopeId: workspace.scopes[0]!.id,
      });
      return session!.id;
    },
    [workspaceId, name] as const
  );
}

test('a workspace reopens on the session it was left on, not the blank composer', async () => {
  const alpha = await seedWorkspace(page, 'alpha', '/tmp/alpha');
  const beta = await seedWorkspace(page, 'beta', '/tmp/beta');
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), alpha);
  const sessionId = await seedSession(page, alpha, 'left here');

  // Driven through the real IPC surface rather than the sidebar: selecting a
  // session in the UI mounts its pane and spawns a CLI, which this test has no
  // reason to pay for. What it does exercise is the whole path that matters --
  // renderer report, main's registry lookup, the view memory, and the resolved
  // view coming back on the next claim.
  const back = await page.evaluate(
    async ([held, other, session]) => {
      window.windowAPI.setView(session, false);
      await window.windowAPI.activateWorkspace(other);
      return window.windowAPI.activateWorkspace(held);
    },
    [alpha, beta, sessionId] as const
  );

  expect(back).toEqual({
    verdict: 'took',
    view: { activeSessionId: sessionId, isInboxOpen: false },
  });
});

test('a workspace remembers being left on the blank composer', async () => {
  const alpha = await seedWorkspace(page, 'alpha', '/tmp/alpha');
  const beta = await seedWorkspace(page, 'beta', '/tmp/beta');
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), alpha);
  const sessionId = await seedSession(page, alpha, 'backed out of');

  const back = await page.evaluate(
    async ([held, other, session]) => {
      window.windowAPI.setView(session, false);
      // Deliberately backing out, the way the New Session shortcut does.
      window.windowAPI.setView(null, false);
      await window.windowAPI.activateWorkspace(other);
      return window.windowAPI.activateWorkspace(held);
    },
    [alpha, beta, sessionId] as const
  );

  // Not resurrected: choosing the composer is a state worth returning to.
  expect(back).toEqual({
    verdict: 'took',
    view: { activeSessionId: null, isInboxOpen: false },
  });
});

test('a workspace whose remembered session was deleted falls back to the composer', async () => {
  const workspaceId = await seedWorkspace(page, 'alpha', '/tmp/alpha');
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), workspaceId);
  const sessionId = await seedSession(page, workspaceId, 'doomed');

  const result = await page.evaluate(
    async ([id, session]) => {
      window.windowAPI.setView(session, false);
      await window.workspaceAPI.deleteSession(id, session);
      // Back out to Home and claim it again, so the view is resolved fresh.
      await window.windowAPI.activateWorkspace(null);
      return window.windowAPI.activateWorkspace(id);
    },
    [workspaceId, sessionId] as const
  );

  // Never a substitute session: mounting one would spawn a CLI nobody asked for.
  expect(result).toEqual({
    verdict: 'took',
    view: { activeSessionId: null, isInboxOpen: false },
  });
});

test('the remembered session survives a relaunch', async () => {
  const { app: first, page: firstPage, userDataDir } = await launchElectron();
  const workspaceId = await seedWorkspace(firstPage, 'persisted', '/tmp/persisted');
  await firstPage.evaluate((id) => window.windowAPI.activateWorkspace(id), workspaceId);
  const sessionId = await seedSession(firstPage, workspaceId, 'still here');
  await firstPage.evaluate((session) => window.windowAPI.setView(session, false), sessionId);
  await first.close();

  const { app: second, page: secondPage } = await launchElectron({ userDataDir });
  const restored = await secondPage.evaluate(
    (id) => window.windowAPI.activateWorkspace(id),
    workspaceId
  );
  await second.close();

  // Written on the click, not at quit: this is the record of where the user
  // was, and a force-quit is exactly when it has to have survived.
  expect(restored).toEqual({
    verdict: 'took',
    view: { activeSessionId: sessionId, isInboxOpen: false },
  });
});

test('a view reported against a workspace this window no longer holds is refused', async () => {
  const alpha = await seedWorkspace(page, 'alpha', '/tmp/alpha');
  const beta = await seedWorkspace(page, 'beta', '/tmp/beta');
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), alpha);
  const alphaSession = await seedSession(page, alpha, 'in alpha');

  const betaView = await page.evaluate(
    async ([held, other, strayFromOther]) => {
      // Establish something worth losing in the workspace being switched to.
      await window.windowAPI.activateWorkspace(held);
      window.windowAPI.setView(held, { activeSessionId: null, isInboxOpen: false });

      // The shape of a click that raced a switch: composed against the old
      // workspace, arriving after the window has taken the new one.
      window.windowAPI.setView(other, {
        activeSessionId: strayFromOther,
        isInboxOpen: false,
      });

      await window.windowAPI.activateWorkspace(null);
      return window.windowAPI.activateWorkspace(held);
    },
    [beta, alpha, alphaSession] as const
  );

  // Filed under beta, the stray id would resolve to null on read and beta
  // would silently lose the view it legitimately had.
  expect(betaView).toEqual({
    verdict: 'took',
    view: { activeSessionId: null, isInboxOpen: false },
  });
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';
import {
  SESSION_DRAG_TYPE,
  homeScopeType,
} from '../../src/renderer/components/Sidebar/sessionDrag';

/**
 * Dragging a session row into a group and back out again, guarded at the one
 * point where it silently broke: the window-level drop guard runs after the
 * React tree and used to overwrite the target's `dropEffect` with `none`, which
 * makes Chromium refuse the drop without ever firing `drop` — no error, and
 * nothing on screen to say why.
 *
 * A native drag is out of reach here, as file-drop.spec.ts notes, and a
 * synthetic `drop` would prove nothing: the veto happens between `dragover` and
 * `drop`, so a hand-dispatched drop lands even when the real gesture cannot.
 * What decides the real gesture is the `dropEffect` standing at the end of the
 * `dragover`, so that is what these pin.
 *
 * The drag types come from the source rather than being spelled out again: they
 * are the whole contract between the row and the target, and a copy here would
 * keep passing after a rename broke the app.
 */

/**
 * Every write to `dropEffect` during a `dragover` on `selector`, in order.
 *
 * Shadowed rather than read back: Chromium ignores writes to `dropEffect`
 * outside a real drag session, so reading it would report `none` whether or not
 * anything had touched it — which is a false confirmation, not a measurement.
 */
async function dropEffectWrites(
  page: Page,
  selector: string,
  entries: [string, string][]
): Promise<string[]> {
  return page.evaluate(
    ([target, types]) => {
      const row = document.querySelector(target as string);
      if (!row) throw new Error(`no ${target} on screen`);
      // The row's own handler is under test, so the event starts below it, the
      // way it would under a pointer resting on the name.
      const from = row.firstElementChild ?? row;

      const transfer = new DataTransfer();
      for (const [type, value] of types as [string, string][]) {
        transfer.setData(type, value);
      }
      transfer.effectAllowed = 'move';

      const recorded: string[] = [];
      let stored = 'none';
      Object.defineProperty(transfer, 'dropEffect', {
        configurable: true,
        get: () => stored,
        set: (value: string) => {
          recorded.push(value);
          stored = value;
        },
      });

      from.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
      return recorded;
    },
    [selector, entries] as const
  );
}

function makeFixture(): { containerDir: string; elsewhereDir: string; stubPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-session-drag-'));
  const containerDir = path.join(root, 'repos');
  fs.mkdirSync(path.join(containerDir, 'repo-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(containerDir, 'repo-b', '.git'), { recursive: true });

  // A second scope, so the test can watch a row that must never light up.
  const elsewhereDir = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhereDir, { recursive: true });

  const stubPath = path.join(root, 'stub-cli.sh');
  fs.writeFileSync(stubPath, "#!/bin/sh\nprintf '\\342\\235\\257 '\nsleep 300\n", {
    mode: 0o755,
  });
  return { containerDir, elsewhereDir, stubPath };
}

/** A workspace with two scopes and a real group holding two sessions. */
async function seedGroupedWorkspace(page: Page, fixture: ReturnType<typeof makeFixture>) {
  await page.evaluate(
    ([binaryPath]) =>
      window.harnessStateAPI.addHarness({
        id: 'stub',
        driverId: 'claude',
        name: 'Stub',
        accentColor: '#4f5bd5',
        binaryPath,
      }),
    [fixture.stubPath] as const
  );
  await page.evaluate(
    ([name, folder]) => window.workspaceAPI.createWorkspace(name, folder, false, 'stub'),
    ['fleet', fixture.containerDir] as const
  );

  await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /fleet/ }).click();

  // A real group, built the way the app builds one.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fan-out…' }).click();
  await page.getByRole('checkbox', { name: 'repo-a' }).check();
  await page.getByRole('checkbox', { name: 'repo-b' }).check();
  await page.getByLabel('Group name').fill('bump-deps');
  await page.getByLabel(/Prompt/).fill('Say hello in each repo.');
  await page.getByRole('button', { name: /Create group · 2 sessions/ }).click();
  await expect(page.locator('.group-nav-header')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(
    ([folder]) =>
      window.workspaceAPI
        .getSnapshot()
        .then((snapshot) =>
          window.workspaceAPI.addScope(
            snapshot.workspaces.find((candidate) => candidate.name === 'fleet')!.id,
            { name: 'elsewhere', path: folder as string, isGitRepo: false }
          )
        ),
    [fixture.elsewhereDir] as const
  );

  const scopes = await page.evaluate(async () => {
    const snapshot = await window.workspaceAPI.getSnapshot();
    const workspace = snapshot.workspaces.find((candidate) => candidate.name === 'fleet')!;
    const member = workspace.sessions.find((session) => session.groupId !== undefined)!;
    return {
      homeScopeId: member.scopeId,
      otherScopeId: workspace.scopes.find((scope) => scope.id !== member.scopeId)!.id,
    };
  });

  await expect(page.locator('.sidebar-scope-filter')).toBeVisible();
  return scopes;
}

test('a group header keeps the move dropEffect it sets, so the drop is not vetoed', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    await seedGroupedWorkspace(page, fixture);

    const writes = await dropEffectWrites(page, '.group-nav-header', [
      [SESSION_DRAG_TYPE, 'some-ungrouped-session'],
    ]);

    // The header claims the drag; nothing downstream may take it back.
    expect(writes).toEqual(['move']);
  } finally {
    await app.close();
  }
});

test('Ungrouped takes a grouped session from any scope under All, only its own when filtered, and the scope row takes no drop', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    const { homeScopeId, otherScopeId } = await seedGroupedWorkspace(page, fixture);
    const fromElsewhere: [string, string][] = [
      [SESSION_DRAG_TYPE, 'a-grouped-session'],
      // Valueless, exactly as the row sets it: the meaning is in the name.
      [homeScopeType(otherScopeId), ''],
    ];
    const ungroupedHeader = '.sidebar-ungrouped .sidebar-section-header';

    // Under All every session is listed, and leaving a group never changes a
    // scope, so Ungrouped takes a grouped session from any scope.
    expect(await dropEffectWrites(page, ungroupedHeader, fromElsewhere)).toEqual(['move']);

    // Filtered to the home scope, a session from elsewhere would land as a
    // row the list then hides. The lone `none` is the window guard vetoing a
    // drag no target claimed.
    const home = await page.evaluate(async (id) => {
      const snapshot = await window.workspaceAPI.getSnapshot();
      return snapshot.workspaces.flatMap(workspace => workspace.scopes).find(scope => scope.id === id)!.name;
    }, homeScopeId);
    await page.getByRole('button', { name: 'Filter sessions by scope', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(home) }).click();
    expect(await dropEffectWrites(page, ungroupedHeader, fromElsewhere)).toEqual(['none']);

    // The scope row is a filter, not a place: it takes nothing.
    expect(await dropEffectWrites(page, '.sidebar-scope-filter', fromElsewhere)).toEqual(['none']);
  } finally {
    await app.close();
  }
});

/** A workspace with the repos container as its scope and "elsewhere" as a second one, no group yet. */
async function seedTwoScopes(page: Page, fixture: ReturnType<typeof makeFixture>) {
  await page.evaluate(
    ([binaryPath]) =>
      window.harnessStateAPI.addHarness({ id: 'stub', driverId: 'claude', name: 'Stub', accentColor: '#4f5bd5', binaryPath }),
    [fixture.stubPath] as const
  );
  const ids = await page.evaluate(async ([folder, elsewhere]) => {
    const workspace = await window.workspaceAPI.createWorkspace('fleet', folder as string, false, 'stub');
    const other = await window.workspaceAPI.addScope(workspace.id, { name: 'elsewhere', path: elsewhere as string, isGitRepo: false });
    return { homeId: workspace.scopes[0].id, otherId: other.id };
  }, [fixture.containerDir, fixture.elsewhereDir] as const);
  await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /fleet/ }).click();
  await expect(page.locator('.sidebar-scope-filter')).toBeVisible();
  return ids;
}

/** Start a session in "elsewhere" from ▾, which opens it. */
async function openSessionElsewhere(page: Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'elsewhere', exact: true }).click();
  await expect(page.locator('.session-nav-item.active')).toBeVisible();
}

async function openFanOut(page: Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fan-out…' }).click();
}

test('a fan-out starts in the open session\'s scope under All', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    const { otherId } = await seedTwoScopes(page, fixture);
    await openSessionElsewhere(page);
    await openFanOut(page);
    // The same rule as +: the open session's scope, not the primary one.
    await expect(page.getByLabel('Scope', { exact: true })).toHaveValue(otherId);
  } finally {
    await app.close();
  }
});

test('a fan-out into another scope widens a filtered list to All, so its sessions are not hidden', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    const { homeId } = await seedTwoScopes(page, fixture);
    await openSessionElsewhere(page);
    await page.getByRole('button', { name: 'Filter sessions by scope', exact: true }).click();
    await page.getByRole('menuitem', { name: /elsewhere/ }).click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('elsewhere');

    await openFanOut(page);
    await page.getByLabel('Scope', { exact: true }).selectOption(homeId);
    await page.getByRole('checkbox', { name: 'repo-a' }).check();
    await page.getByLabel('Group name').fill('bump-deps');
    await page.getByLabel(/Prompt/).fill('Say hello.');
    await page.getByRole('button', { name: /Create group/ }).click();

    await expect(page.locator('.group-nav-header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

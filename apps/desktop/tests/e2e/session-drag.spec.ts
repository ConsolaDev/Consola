import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';
import { SESSION_DRAG_TYPE } from '../../src/renderer/components/Sidebar/sessionDrag';

/**
 * Dragging a session row onto a label chip, guarded at the one
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
  entries: Array<[string, string]>,
): Promise<string[]> {
  return page.evaluate(
    ([target, types]) => {
      const row = document.querySelector(target as string);
      if (!row) throw new Error(`no ${target} on screen`);
      // The row's own handler is under test, so the event starts below it, the
      // way it would under a pointer resting on the name.
      const from = row.firstElementChild ?? row;

      const transfer = new DataTransfer();
      for (const [type, value] of types as Array<[string, string]>) {
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
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      return recorded;
    },
    [selector, entries] as const,
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

/** A workspace with two scopes and two fan-out sessions, and an active label chip to drop on. */
async function seedLabelledWorkspace(page: Page, fixture: ReturnType<typeof makeFixture>) {
  await page.evaluate(
    ([binaryPath]) =>
      window.harnessStateAPI.addHarness({
        id: 'stub',
        driverId: 'claude',
        name: 'Stub',
        accentColor: '#4f5bd5',
        binaryPath,
      }),
    [fixture.stubPath] as const,
  );
  await page.evaluate(
    ([name, folder]) => window.workspaceAPI.createWorkspace(name, folder, false, 'stub'),
    ['fleet', fixture.containerDir] as const,
  );

  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /fleet/ })
    .click();

  // Two sessions, built the way the app builds a fan-out.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fan-out…' }).click();
  await page.getByRole('checkbox', { name: 'repo-a' }).check();
  await page.getByRole('checkbox', { name: 'repo-b' }).check();
  await page.getByLabel('Group name').fill('bump-deps');
  await page.getByLabel(/Prompt/).fill('Say hello in each repo.');
  await page.getByRole('button', { name: /Create group · 2 sessions/ }).click();
  await expect(page.locator('.session-nav-item')).toHaveCount(2, { timeout: 15_000 });

  await page.evaluate(
    ([folder]) =>
      window.workspaceAPI
        .getSnapshot()
        .then((snapshot) =>
          window.workspaceAPI.addScope(
            snapshot.workspaces.find((candidate) => candidate.name === 'fleet')!.id,
            { name: 'elsewhere', path: folder as string, isGitRepo: false },
          ),
        ),
    [fixture.elsewhereDir] as const,
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

  // A label chip appears while a label is chosen: make one and choose it, as a person would.
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await page.getByRole('textbox', { name: 'New label' }).fill('urgent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Remove filter urgent' })).toBeVisible();
  return scopes;
}

const LABEL_CHIP = '.sidebar-filter-chip';

test('a label chip keeps the move dropEffect it sets, so the drop is not vetoed', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    await seedLabelledWorkspace(page, fixture);

    const writes = await dropEffectWrites(page, LABEL_CHIP, [[SESSION_DRAG_TYPE, 'some-session']]);

    // The chip claims the drag; nothing downstream may take it back.
    expect(writes).toEqual(['move']);
  } finally {
    await app.close();
  }
});

test('a label chip takes only a session row, and the scope control takes no drop', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    await seedLabelledWorkspace(page, fixture);

    // Anything that is not one of our rows is nobody's: the lone `none` is the
    // window guard vetoing a drag no target claimed.
    expect(await dropEffectWrites(page, LABEL_CHIP, [['text/plain', 'x']])).toEqual(['none']);

    // The scope is a filter, not a place: it takes nothing, a session row included.
    expect(
      await dropEffectWrites(page, '.sidebar-scope-filter', [[SESSION_DRAG_TYPE, 'a-session']]),
    ).toEqual(['none']);
  } finally {
    await app.close();
  }
});

test('dropping a session on a label chip gives it that label', async () => {
  test.setTimeout(90_000);
  const fixture = makeFixture();
  const { app, page } = await launchElectron();

  try {
    await seedLabelledWorkspace(page, fixture);
    const read = () =>
      page.evaluate(async () => {
        const workspace = (await window.workspaceAPI.getSnapshot()).workspaces.find(
          (candidate) => candidate.name === 'fleet',
        )!;
        const label = workspace.labels.find((candidate) => candidate.name === 'urgent')!;
        return {
          label: label.id,
          session: workspace.sessions[0].id,
          tagged: workspace.sessions.filter((s) => s.labelIds?.includes(label.id)).length,
        };
      });
    const before = await read();
    expect(before.tagged).toBe(0);

    // A synthetic drop proves the assignment; the dragover tests above prove the gesture is not vetoed.
    await page.evaluate(
      ([selector, type, id]) => {
        const transfer = new DataTransfer();
        transfer.setData(type, id);
        document
          .querySelector(selector)!
          .dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
      },
      [LABEL_CHIP, SESSION_DRAG_TYPE, before.session] as const,
    );

    await expect.poll(async () => (await read()).tagged).toBe(1);
  } finally {
    await app.close();
  }
});

/** A workspace with the repos container as its scope and "elsewhere" as a second one, no group yet. */
async function seedTwoScopes(page: Page, fixture: ReturnType<typeof makeFixture>) {
  await page.evaluate(
    ([binaryPath]) =>
      window.harnessStateAPI.addHarness({
        id: 'stub',
        driverId: 'claude',
        name: 'Stub',
        accentColor: '#4f5bd5',
        binaryPath,
      }),
    [fixture.stubPath] as const,
  );
  const ids = await page.evaluate(
    async ([folder, elsewhere]) => {
      const workspace = await window.workspaceAPI.createWorkspace(
        'fleet',
        folder as string,
        false,
        'stub',
      );
      const other = await window.workspaceAPI.addScope(workspace.id, {
        name: 'elsewhere',
        path: elsewhere as string,
        isGitRepo: false,
      });
      return { homeId: workspace.scopes[0].id, otherId: other.id };
    },
    [fixture.containerDir, fixture.elsewhereDir] as const,
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /fleet/ })
    .click();
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

test("a fan-out starts in the open session's scope under All", async () => {
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
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: /elsewhere/ }).click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('elsewhere');

    await openFanOut(page);
    await page.getByLabel('Scope', { exact: true }).selectOption(homeId);
    await page.getByRole('checkbox', { name: 'repo-a' }).check();
    await page.getByLabel('Group name').fill('bump-deps');
    await page.getByLabel(/Prompt/).fill('Say hello.');
    await page.getByRole('button', { name: /Create group/ }).click();

    // Both rows are listed: the elsewhere session and the fan-out member.
    await expect(page.locator('.session-nav-item')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
  } finally {
    await app.close();
  }
});

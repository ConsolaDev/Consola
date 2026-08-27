import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';
import { SESSION_DRAG_TYPE } from '../../src/renderer/components/Sidebar/sessionDrag';

/**
 * Dragging a session row onto a group header, guarded at the one point where
 * it silently broke: the window-level drop guard runs after the
 * React tree and used to overwrite the target's `dropEffect` with `none`, which
 * makes Chromium refuse the drop without ever firing `drop` — no error, and
 * nothing on screen to say why.
 *
 * A native drag is out of reach here, as file-drop.spec.ts notes, and a
 * synthetic `drop` would prove nothing: the veto happens between `dragover` and
 * `drop`, so a hand-dispatched drop lands even when the real gesture cannot.
 * What decides the real gesture is the `dropEffect` standing at the end of the
 * `dragover`, so that is what this pins.
 *
 * The drag type comes from the source rather than being spelled out again: it
 * is the whole contract between the row and the target, and a copy here would
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

function makeFixture(): { containerDir: string; stubPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-session-drag-'));
  const containerDir = path.join(root, 'repos');
  fs.mkdirSync(path.join(containerDir, 'repo-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(containerDir, 'repo-b', '.git'), { recursive: true });

  const stubPath = path.join(root, 'stub-cli.sh');
  fs.writeFileSync(stubPath, "#!/bin/sh\nprintf '\\342\\235\\257 '\nsleep 300\n", {
    mode: 0o755,
  });
  return { containerDir, stubPath };
}

/** A workspace whose single scope holds a real group of two sessions. */
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

  await page.getByRole('button', { name: /^Switch workspace/ }).click();
  await page.getByRole('menuitem', { name: /fleet/ }).click();

  // A real group, built the way the app builds one.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fan-out…' }).click();
  await page.getByRole('checkbox', { name: 'repo-a' }).check();
  await page.getByRole('checkbox', { name: 'repo-b' }).check();
  await page.getByLabel('Group name').fill('bump-deps');
  await page.getByLabel(/Prompt/).fill('Say hello in each repo.');
  await page.getByRole('button', { name: /Create group · 2 sessions/ }).click();
  await expect(page.locator('.group-nav-header')).toBeVisible({ timeout: 15_000 });
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

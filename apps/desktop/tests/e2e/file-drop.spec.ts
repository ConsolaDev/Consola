import { test, expect } from '@playwright/test';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * Dropping a file on a session terminal pastes its path as an `@mention`, and
 * the only way the renderer can learn that path is `webUtils.getPathForFile`
 * in the preload script. Nothing else in the suite exercises it, and the
 * failure mode is silent: `Electron`'s older `File.path` simply became
 * `undefined` when it was removed, so every drop turned into "that drag
 * carries no file on disk" with no error anywhere. Hence a test that pins the
 * lookup itself rather than the drag, which Chromium cannot synthesise.
 */
test.describe('Dropped file paths', () => {
  test('resolves the real on-disk path of a file that came from disk', async () => {
    const { app, page } = await launchElectron();
    const onDisk = path.join(process.cwd(), 'package.json');

    // A native drag is out of reach, but a file input produces the same kind
    // of disk-backed `File` the drop handler receives.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'e2e-file-input';
      document.body.appendChild(input);
    });
    await page.setInputFiles('#e2e-file-input', onDisk);

    const resolved = await page.evaluate(() => {
      const input = document.getElementById('e2e-file-input') as HTMLInputElement;
      return window.terminalAPI.pathForFile(input.files![0]);
    });

    expect(resolved).toBe(onDisk);
    await app.close();
  });

  test('returns an empty path for a drag carrying no file on disk', async () => {
    const { app, page } = await launchElectron();

    // What `readDroppedPaths` filters on: an image dragged out of a browser
    // has no path to hand Claude, and the user gets the notice instead.
    const resolved = await page.evaluate(() =>
      window.terminalAPI.pathForFile(new File(['x'], 'x.txt', { type: 'text/plain' }))
    );

    expect(resolved).toBe('');
    await app.close();
  });
});

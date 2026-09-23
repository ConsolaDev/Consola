import { test, expect } from '@playwright/test';
import { launchElectron, settingsChord } from './helpers/electron';

test('update bridge, settings and background download notice', async () => {
  const { app, page } = await launchElectron();
  try {
    await expect.poll(() => page.evaluate(() => window.appUpdateAPI?.getState())).toMatchObject({ status: 'disabled' });
    await page.keyboard.press(settingsChord());
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible();
    await expect(page.getByText('Automatic updates are available in the distributed macOS app.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app-update:changed', {
        status: 'downloading', currentVersion: '1.0.0', version: '1.1.0', progress: 42,
      });
    });
    await expect(page.getByText('Downloading Consola 1.1.0… 42%')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app-update:changed', {
        status: 'ready', currentVersion: '1.0.0', version: '1.1.0', progress: 100,
      });
    });
    await expect(page.getByRole('button', { name: 'Restart and install', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

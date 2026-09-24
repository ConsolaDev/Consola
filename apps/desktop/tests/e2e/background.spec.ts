import { expect, test } from '@playwright/test';
import { launchElectron, newWindowChord } from './helpers/electron';

test('background windows stay hidden and unfocused after input and focus requests', async () => {
  test.skip(process.env.CONSOLA_E2E_HEADED === '1', 'Background-mode contract');
  const { app, page } = await launchElectron();
  try {
    const opened = app.waitForEvent('window');
    await page.keyboard.press(newWindowChord());
    const second = await opened;
    await second.waitForLoadState('domcontentloaded');

    const state = await app.evaluate(({ BrowserWindow, app }) => {
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) window.focus();
      return {
        windows: windows.map(window => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          focusable: window.isFocusable(),
        })),
        dockVisible: app.dock?.isVisible() ?? false,
      };
    });
    expect(state.windows).toEqual([
      { visible: false, focused: false, focusable: false },
      { visible: false, focused: false, focusable: false },
    ]);
    expect(state.dockVisible).toBe(false);
    // Hidden renderers must still paint for failure screenshots and traces.
    expect((await second.screenshot()).byteLength).toBeGreaterThan(1000);
  } finally {
    await app.close();
  }
});

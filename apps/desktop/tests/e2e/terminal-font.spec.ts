import { test, expect } from '@playwright/test';
import { launchElectron } from './helpers/electron';

// xterm's WebGL renderer sets its glyph canvas's font to
// `${italic} ${weight} ${size}px ${family}`, which starts with a space for
// every upright glyph. Electron 43.8.10 rejected a font string with leading
// whitespace and left the canvas at its default 10px sans-serif, so every
// session drew tiny proportional glyphs spread across a monospace grid.
// Electron 43.8.11 fixed it (electron/electron#55777); this keeps an Electron
// bump from bringing it back unnoticed.
test('a canvas accepts the font string xterm builds for upright glyphs', async () => {
  const { app, page } = await launchElectron();
  try {
    const font = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.font = ' 500 28px Menlo';
      return ctx.font;
    });
    expect(font).toBe('500 28px Menlo');
  } finally {
    await app.close();
  }
});

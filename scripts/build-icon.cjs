#!/usr/bin/env node
// macOS: regenerate the Dock icon from the same SVG served by the renderer.
// Requires Playwright's Chromium (npx playwright install chromium).
// Or use an installed Chrome: PLAYWRIGHT_CHANNEL=chrome npm run build:icon.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.join(__dirname, '..');
  const svg = await fs.readFile(path.join(root, 'src/renderer/public/icon.svg'), 'utf8');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'consola-icon-'));
  let browser;
  try {
    const iconset = path.join(temporary, 'Consola.iconset');
    await fs.mkdir(iconset);
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        await page.setViewportSize({ width: size * scale, height: size * scale });
        const file = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
        await page.screenshot({ path: file, omitBackground: true });
        if (size === 512 && scale === 2) {
          await fs.copyFile(file, path.join(root, 'build/icon.png'));
        }
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build/icon.icns')]);
    console.log('Generated build/icon.icns and build/icon.png from icon.svg');
  } finally {
    await browser?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

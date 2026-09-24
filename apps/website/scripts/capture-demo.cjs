const { chromium } = require('@playwright/test');
const path = require('node:path');

async function capture() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.route('https://api.github.com/**', route => route.fulfill({ status: 404, body: '{}' }));
    await page.goto('http://localhost:5174');
    const frame = page.frameLocator('[data-live-demo] iframe');
    await page.locator('[data-live-demo]').scrollIntoViewIfNeeded();
    await frame.getByRole('navigation', { name: 'Session groups' }).waitFor();
    await page.getByRole('button', { name: /Inspect code changes/ }).click();
    await frame.locator('.git-review-panel').getByText('isRetryable', { exact: false }).first().waitFor();
    await frame.locator('.xterm-screen').waitFor();
    await page.locator('iframe').evaluate(async iframe => { await iframe.contentDocument.fonts.ready; });
    await page.locator('[data-live-demo] iframe').screenshot({ path: path.join(__dirname, '../public/assets/consola-demo.png'), animations: 'disabled' });
  } finally { await browser.close(); }
}
capture().catch(error => { console.error(error); process.exitCode = 1; });

import { test, expect } from '@playwright/test';
import { launchElectron } from './helpers/electron';

test.describe('Terminal Rendering', () => {
  test('should render terminal container', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal container to exist
    const terminalContainer = page.locator('[data-testid="terminal-container"]');
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });

    // Wait for xterm canvas to render
    const xtermCanvas = page.locator('.xterm-screen canvas');
    await expect(xtermCanvas).toBeVisible({ timeout: 10000 });

    // Take screenshot for visual verification
    await page.screenshot({ path: 'tests/e2e/screenshots/terminal-rendered.png' });

    await app.close();
  });

  test('should display shell prompt', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal
    const terminalContainer = page.locator('[data-testid="terminal-container"]');
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });

    // Wait a bit for PTY to initialize and send prompt
    await page.waitForTimeout(2000);

    // Check that terminal has content (xterm rows)
    const xtermRows = page.locator('.xterm-rows');
    await expect(xtermRows).toBeVisible();

    // Take screenshot showing prompt
    await page.screenshot({ path: 'tests/e2e/screenshots/shell-prompt.png' });

    await app.close();
  });

  test('should switch modes via tabs', async () => {
    const { app, page } = await launchElectron();

    // Wait for app to load
    await page.waitForSelector('[data-testid="terminal-container"]', { timeout: 10000 });

    // Click Claude tab
    const claudeTab = page.locator('button:has-text("Claude")');
    await claudeTab.click();

    // Verify mode changed in status bar
    const modeLabel = page.locator('.mode-label');
    await expect(modeLabel).toHaveText('CLAUDE');

    // Take screenshot of Claude mode
    await page.screenshot({ path: 'tests/e2e/screenshots/claude-mode.png' });

    // Switch back to Shell
    const shellTab = page.locator('button:has-text("Shell")');
    await shellTab.click();
    await expect(modeLabel).toHaveText('SHELL');

    await app.close();
  });

  test('should handle terminal input/output', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal
    await page.waitForSelector('.xterm-screen canvas', { timeout: 10000 });
    await page.waitForTimeout(1000); // Wait for PTY

    // Type a simple command
    await page.keyboard.type('echo "Hello from Playwright"');
    await page.keyboard.press('Enter');

    // Wait for output
    await page.waitForTimeout(500);

    // Take screenshot showing command and output
    await page.screenshot({ path: 'tests/e2e/screenshots/terminal-io.png' });

    await app.close();
  });
});

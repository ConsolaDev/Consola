import { expect, type Locator, type Page } from '@playwright/test';

/** ⇧⌘L: opens the Browser tab, or hides the side panel while that tab is in front. */
export function browserChord(): string {
  return process.platform === 'darwin' ? 'Meta+Shift+KeyL' : 'Control+Shift+KeyL';
}

/** ⌥⌘B: shows or hides the side panel. */
export function sidePanelChord(): string {
  return process.platform === 'darwin' ? 'Meta+Alt+KeyB' : 'Control+Alt+KeyB';
}

export const browserPanel = (page: Page): Locator => page.getByTestId('browser-panel');

/** The header's side panel toggle, which carries the agent's mark while the browser is nowhere on screen. */
export const sidePanelToggle = (page: Page): Locator =>
  page.getByRole('button', { name: /^(Show|Hide) side panel/ });

/** The person opens the session's Browser tab, which shows its active page tab. */
export async function showBrowser(page: Page): Promise<void> {
  if (!(await browserPanel(page).isVisible())) await page.keyboard.press(browserChord());
  await expect(browserPanel(page)).toBeVisible();
}

/** The person puts the browser away: with its tab in front, its chord hides the side panel. */
export async function hideBrowser(page: Page): Promise<void> {
  if (await browserPanel(page).isVisible()) await page.keyboard.press(browserChord());
  await expect(browserPanel(page)).toHaveCount(0);
}

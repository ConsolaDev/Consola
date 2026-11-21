import { expect, type Locator, type Page } from '@playwright/test';

/** ⌥⌘J: shows or hides the info panel. */
export function infoPanelChord(): string {
  return process.platform === 'darwin' ? 'Meta+Alt+KeyJ' : 'Control+Alt+KeyJ';
}

/** The info panel beside the session's conversation. */
export const infoPanel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Session info' });

/** One of the info panel's sections, by its heading. */
export function infoSection(page: Page, title: string): Locator {
  return infoPanel(page).getByRole('region', { name: title, exact: true });
}

/**
 * For a test that is not about the info panel: hides it, so the conversation
 * and the side panel have its width back. Call it once a session is on
 * screen. Hidden by its chord, which leaves the keyboard where it is, and for
 * every session: whether it shows is not a session's.
 */
export async function hideInfoPanel(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(Show|Hide) info panel$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'true') {
    await page.keyboard.press(infoPanelChord());
  }
  await expect(infoPanel(page)).toHaveCount(0);
}

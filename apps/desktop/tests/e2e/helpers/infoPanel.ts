import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

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
 * For a test about the info panel beside the side panel: a window wide enough
 * that the info panel stays when the side panel opens. On the default
 * 1000×700 window it steps aside for the side panel (`INFO_PANEL_ROOM_PX`).
 */
export async function roomForBothPanels(app: ElectronApplication, page: Page): Promise<void> {
  const appWindow = await app.browserWindow(page);
  await appWindow.evaluate((browserWindow) => browserWindow.setContentSize(1400, 800));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1400);
}

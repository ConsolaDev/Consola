/**
 * Settings' pages, as the address names them: `#/settings/<page>`, a page id being lowercase
 * letters, digits and single dashes, like a section's. Whatever follows the page id, after a `/`
 * or a `?`, is the page's own. `#/settings` alone, or a page this build does not have, opens the
 * first page. An id never changes once a link may hold it: cloud-global sends a person back to
 * `#/settings/connections` after a GitHub Connect.
 */

/**
 * What the address names in a section's place to open Settings, which is no section: a dialog
 * over the section that was open.
 */
export const SETTINGS_SECTION_ID = 'settings';

const SETTINGS_PAGE_HASH = /^#\/settings\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[/?].*)?$/s;

/** The settings page a hash names (`#/settings/connections`), or null when it names none. */
export function settingsPageIdOfHash(hash: string): string | null {
  return SETTINGS_PAGE_HASH.exec(hash)?.[1] ?? null;
}

/** The hash that opens the settings page `id`. */
export function hashOfSettingsPage(id: string): string {
  return `#/${SETTINGS_SECTION_ID}/${id}`;
}

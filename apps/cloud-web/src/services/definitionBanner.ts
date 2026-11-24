/*
 * Whether the person hid the banner over a factory's definition for good, in this browser's
 * storage. Only a convenience: storage that is missing or refused (a private window, blocked site
 * data) reads as not hidden and keeps nothing, so the banner shows again, and nothing else
 * changes.
 */

const KEY = 'consola-cloud.definition-banner-hidden';

/** Whether the person hid the banner in this browser. */
export function isDefinitionBannerHidden(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Hides the banner in this browser, when storage takes it. */
export function hideDefinitionBanner(): void {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    // Only a convenience: the banner shows again next time.
  }
}

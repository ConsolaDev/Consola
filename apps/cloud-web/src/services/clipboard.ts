/** The one thing the page asks of the system clipboard. */
export type Clipboard = { writeText: (text: string) => Promise<void> };

/**
 * Puts `text` on the clipboard. False when the browser has no clipboard to give the page (an
 * insecure origin) or refuses the write (no permission, the page not focused), so a screen can
 * say so instead of claiming it copied.
 */
export async function copyText(
  text: string,
  clipboard: Clipboard | null = globalThis.navigator?.clipboard ?? null,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

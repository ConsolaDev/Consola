/**
 * Copies of page text that share nothing with the string they came from.
 *
 * V8 cuts a string (`slice`, `substring`) by pointing into the original, so
 * a couple of thousand characters cut from a page's 20 MB string keep all
 * 20 MB alive for as long as the cut is kept. A page decides how long what
 * it logs is, so what main keeps of it for later (a console error, a
 * dialog's message) is cut and then copied here, and holds only itself.
 */

/**
 * The same text as a string of its own. Written out as UTF-16 and read back,
 * so every code unit, a lone surrogate included, is as it was.
 */
export function ownCopy(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

/**
 * The first `max` code units of `text`, one fewer rather than split a
 * character made of two, as a string of its own (`ownCopy`).
 */
export function cutCopy(text: string, max: number): string {
  let end = Math.min(text.length, Math.max(0, max));
  if (end < text.length && end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd8_00 && last <= 0xdb_ff) end -= 1;
  }
  return ownCopy(text.slice(0, end));
}

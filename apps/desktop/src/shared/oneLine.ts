/**
 * How an agent CLI's own text is shaped before Consola shows or records it.
 *
 * That text is the agent's, from an agent that may have read someone else's
 * pull request, so it never reaches Consola's terminal or a record whole: an
 * escape sequence in it could repaint the pane, and a thousand lines of it
 * would bury the one that says what went wrong.
 */

/**
 * The escape sequences a terminal acts on: OSC, DCS, SOS, PM and APC strings
 * (to BEL or ESC \), CSI (`ESC [`, parameters, intermediates, a final byte),
 * then any other `ESC`, its intermediates and its final byte (`ESC =`,
 * `ESC ( B`). A string with no terminator loses only its introducer.
 */
const ESCAPE_SEQUENCE =
  /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;

/** C0 and C1 control characters, and DEL. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/** What ends a line: a newline, a carriage return, or a Unicode line or paragraph separator. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** Terminal escape sequences (CSI, OSC and the other strings, two-byte ESC x) removed. */
export function stripEscapes(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, '');
}

/** One line of text with escapes and control characters removed, a tab becoming a space. */
export function withoutControls(line: string): string {
  return stripEscapes(line).replace(/\t/g, ' ').replace(CONTROL_CHARACTERS, '');
}

/**
 * `text` cut at `max` characters, with `…` when anything was cut. Never in
 * the middle of a character outside the Basic Multilingual Plane.
 */
export function cutAt(text: string, max: number, mark = '…'): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}${mark}`;
}

/**
 * The CLI's text as Consola shows or records it: the first non-empty line, escape sequences
 * and C0/C1 control characters removed (a tab becomes a space), trimmed, and cut at `max`
 * characters with `…`. '' when nothing is left.
 */
export function oneLine(text: string, max = 300): string {
  for (const line of stripEscapes(text).split(LINE_BREAK)) {
    const shaped = withoutControls(line).trim();
    if (shaped) return cutAt(shaped, max);
  }
  return '';
}

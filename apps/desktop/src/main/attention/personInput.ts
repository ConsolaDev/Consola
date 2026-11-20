/**
 * What the person's keys say, read from what xterm sends for them.
 *
 * Only the `TERMINAL_INPUT` channel carries keys, but it also carries what
 * the terminal answers on its own (focus changes, cursor reports, mouse
 * events). Neither of those is the person answering anything.
 */

/** A paste between bracketed-paste markers: text, never a key press, whatever it holds. */
const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;

/** Replies and reports the terminal sends by itself. */
const TERMINAL_REPORTS: readonly RegExp[] = [
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\[\d+;\d+R/g, // cursor position report
  /\x1b\[[?>=]?[\d;]*c/g, // device attributes
  /\x1b\[\??[\d;]*\$y/g, // mode report
  /\x1b\[\d*n/g, // device status report
  /\x1b\[<\d+;\d+;\d+[Mm]/g, // SGR mouse
  /\x1b\[\d+;\d+;\d+M/g, // urxvt mouse
  /\x1b\[M[\s\S]{3}/g, // X10 mouse
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, // OSC replies (colour queries)
  /\x1bP[\s\S]*?\x1b\\/g, // DCS replies
];

/**
 * Whether this input submits something: Enter, outside a paste. Shift+Enter
 * arrives as ESC CR (a newline in the composer, see `terminalKeys.ts`), so a
 * CR right after ESC is not one.
 */
export function pressesEnter(data: string): boolean {
  const typed = data.replace(BRACKETED_PASTE, '');
  for (let i = 0; i < typed.length; i++) {
    if (typed[i] === '\r' && typed[i - 1] !== '\x1b') return true;
  }
  return false;
}

/** Whether anything in this input is the person pressing a key, rather than the terminal reporting. */
export function isPersonKey(data: string): boolean {
  let rest = data;
  for (const report of TERMINAL_REPORTS) rest = rest.replace(report, '');
  return rest.length > 0;
}

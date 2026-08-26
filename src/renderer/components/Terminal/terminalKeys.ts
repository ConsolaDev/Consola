/**
 * ESC + CR — what a terminal sends for Meta+Enter, and what the CLI reads as
 * "insert a newline" rather than "submit".
 *
 * This is the sequence `claude /terminal-setup` installs elsewhere: in VS Code
 * it binds `shift+enter` to `sendSequence` with exactly these two bytes. The
 * terminals that support Shift+Enter without any setup do it through the kitty
 * keyboard protocol, which reports the key distinctly; xterm.js implements no
 * such protocol, so translating the key here is the equivalent move.
 */
const NEWLINE_SEQUENCE = '\x1b\r';

/**
 * The bytes a key event should send instead of xterm's own, or null to let
 * xterm decide.
 *
 * Only Shift+Enter needs redirecting. xterm resolves Enter as
 * `altKey ? ESC+CR : CR` without ever consulting shift, so Shift+Enter reaches
 * the CLI as a plain submit — while Option+Enter already produces the newline
 * sequence on its own and is deliberately left alone.
 *
 * Answers for every event type, not just keydown: xterm asks its custom handler
 * again on keypress, and a handler that only claimed the keydown would let the
 * carriage return through there instead.
 */
export function terminalKeyOverride(event: KeyboardEvent): string | null {
    if (event.key !== 'Enter') return null;
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
    return NEWLINE_SEQUENCE;
}

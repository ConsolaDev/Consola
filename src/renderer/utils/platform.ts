/**
 * Which platform the renderer is running on.
 *
 * Centralised because the same `navigator.platform` sniff was hand-rolled in
 * four separate files, each free to drift from the others. Evaluated once at
 * module load: the platform cannot change while the window is open.
 */
export const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/** The modifier that means "application shortcut" on this platform. */
export function hasPlatformModifier(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * The command palette chord: Cmd+K on macOS, Ctrl+Shift+P everywhere else.
 *
 * The split is not cosmetic. xterm only turns a key into PTY bytes for a bare
 * Ctrl+letter — `ctrlKey && !shiftKey && !altKey && !metaKey` — so Ctrl+K would
 * reach Claude as U+000B (kill-to-end-of-line) before this listener ever saw
 * it. Cmd carries `metaKey` and Ctrl+Shift+P carries `shiftKey`, so neither
 * chord produces a keypress the terminal would forward.
 */
export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  if (isMac) {
    return (
      event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'k'
    );
  }
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'p'
  );
}

/** How the palette chord is written in menus and hint text. */
export const COMMAND_PALETTE_SHORTCUT_LABEL = isMac ? '⌘K' : 'Ctrl+Shift+P';

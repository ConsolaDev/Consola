export const SHELL_SHORTCUT_LABEL = 'Ctrl+`';

/** Use the physical key as well so the chord works on non-US layouts. */
export function isShellShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    (event.code === 'Backquote' || event.key === '`');
}

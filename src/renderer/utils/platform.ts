import type { PaletteScope } from '../components/CommandPalette/types';

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

/**
 * Chords that open the palette already narrowed to one section.
 *
 * The two platforms cannot share letters. `Ctrl+Shift+P` is already the
 * palette off macOS, and the same rule as above still binds every entry
 * there: a bare Ctrl+letter becomes PTY bytes before this listener runs, so
 * each non-mac chord carries Shift. Actions get no chord on purpose — the
 * palette opens with them at the top, and `>` is one keystroke away.
 */
const SCOPE_SHORTCUTS: ReadonlyArray<{
  scope: PaletteScope;
  key: string;
  shift: boolean;
  label: string;
}> = isMac
  ? [
      { scope: 'sessions', key: 'p', shift: false, label: '⌘P' },
      { scope: 'workspaces', key: 'p', shift: true, label: '⇧⌘P' },
      { scope: 'files', key: 'o', shift: true, label: '⇧⌘O' },
    ]
  : [
      { scope: 'sessions', key: 's', shift: true, label: 'Ctrl+Shift+S' },
      { scope: 'workspaces', key: 'w', shift: true, label: 'Ctrl+Shift+W' },
      { scope: 'files', key: 'o', shift: true, label: 'Ctrl+Shift+O' },
    ];

/** The scope a key event asks for, or null if it is not one of these chords. */
export function matchScopeShortcut(event: KeyboardEvent): PaletteScope | null {
  const hasPlatformModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!hasPlatformModifier || event.altKey) return null;

  const key = event.key.toLowerCase();
  const match = SCOPE_SHORTCUTS.find(
    (entry) => entry.key === key && entry.shift === event.shiftKey
  );
  return match?.scope ?? null;
}

/** How each scope chord is written, for the palette's section headers. */
export const SCOPE_SHORTCUT_LABELS: Partial<Record<PaletteScope, string>> = Object.fromEntries(
  SCOPE_SHORTCUTS.map((entry) => [entry.scope, entry.label])
);

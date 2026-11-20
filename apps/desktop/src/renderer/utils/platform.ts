import type { PaletteScope } from '../components/CommandPalette/types';
import {
  BROWSER_SHORTCUT_LABELS,
  isBrowserShortcut as isBrowser,
  isCommandPaletteShortcut as isCommandPalette,
  isSidebarShortcut as isSidebar,
  matchScopeShortcut as matchScope,
  matchWorkspaceShortcut as matchWorkspace,
  scopeShortcutLabels,
  type KeyChord,
  type ShortcutPlatform,
} from '../../shared/shortcuts';

/**
 * Which platform the renderer is running on.
 *
 * Centralised because the same `navigator.platform` sniff was hand-rolled in
 * four separate files, each free to drift from the others. Evaluated once at
 * module load: the platform cannot change while the window is open.
 */
export const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/** `isMac` in the form the shared matchers take. */
export const PLATFORM: ShortcutPlatform = isMac ? 'mac' : 'other';

/** The modifier that means "application shortcut" on this platform. */
export function hasPlatformModifier(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** What a key event is, in the shape `shared/shortcuts` matches over. */
export function chordOf(event: KeyboardEvent): KeyChord {
  return {
    key: event.key,
    code: event.code,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    isComposing: event.isComposing,
  };
}

/** The matchers live in `shared/shortcuts` because main answers the same questions for pages. */
export function matchWorkspaceShortcut(event: KeyboardEvent): number | null {
  return matchWorkspace(chordOf(event), PLATFORM);
}

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return isCommandPalette(chordOf(event), PLATFORM);
}

export function isSidebarShortcut(event: KeyboardEvent): boolean {
  return isSidebar(chordOf(event));
}

/** Shows or hides the browser panel. */
export function isBrowserShortcut(event: KeyboardEvent): boolean {
  return isBrowser(chordOf(event), PLATFORM);
}

export const BROWSER_SHORTCUT_LABEL = BROWSER_SHORTCUT_LABELS[PLATFORM];

/**
 * The Working shelf chord: Cmd+Shift+B on macOS, Ctrl+Shift+B elsewhere.
 *
 * Shift on both for the usual reason (a bare Ctrl+B is a PTY byte); on macOS
 * Cmd+B alone is left free for the terminal's own use.
 */
export function isWorkingShelfShortcut(event: KeyboardEvent): boolean {
  const isB = event.key.toLowerCase() === 'b';
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && event.shiftKey && !event.altKey && isB;
}

export const WORKING_SHELF_SHORTCUT_LABEL = isMac ? '⇧⌘B' : 'Ctrl+Shift+B';

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
/** The scope a key event asks for, or null if it is not one of these chords. */
export function matchScopeShortcut(event: KeyboardEvent): PaletteScope | null {
  return matchScope(chordOf(event), PLATFORM);
}

/** How each scope chord is written, for the palette's section headers. */
export const SCOPE_SHORTCUT_LABELS: Partial<Record<PaletteScope, string>> =
  scopeShortcutLabels(PLATFORM);

/**
 * The key chords the app binds, over a minimal key shape so the renderer's
 * `KeyboardEvent` and main's guest `Input` can both be asked the same question.
 *
 * Main needs them because a focused `<webview>` swallows keys: the renderer's
 * window never hears a chord pressed while a page has focus, so main matches
 * the chords the app owns and forwards them. No DOM or Node imports.
 */

/** What a key press is, whichever process saw it. */
export interface KeyChord {
  key: string;
  /** The physical key (`Digit1`, `Backquote`), for layouts where `key` differs. */
  code?: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  isComposing?: boolean;
}

/**
 * macOS binds app chords to Cmd; everywhere else they take Ctrl. A bare
 * Ctrl+letter becomes PTY bytes before the window's listener runs, which is why
 * several chords below carry Shift off macOS.
 */
export type ShortcutPlatform = 'mac' | 'other';

export function shortcutPlatformOf(platform: string): ShortcutPlatform {
  return platform === 'darwin' ? 'mac' : 'other';
}

/** The platform's application modifier held, and the other one not. */
function hasPrimary(chord: KeyChord, platform: ShortcutPlatform): boolean {
  return platform === 'mac' ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
}

/** Cmd/Ctrl + 1–9 follows the workspace rail's order. */
export function matchWorkspaceShortcut(chord: KeyChord, platform: ShortcutPlatform): number | null {
  if (!hasPrimary(chord, platform) || chord.alt || chord.shift || chord.isComposing) return null;
  const digit = /^Digit[1-9]$/.test(chord.code ?? '') ? (chord.code as string).slice(5) : chord.key;
  return /^[1-9]$/.test(digit) ? Number(digit) - 1 : null;
}

/**
 * The command palette chord: Cmd+K on macOS, Ctrl+Shift+P everywhere else.
 *
 * The split is not cosmetic. xterm only turns a key into PTY bytes for a bare
 * Ctrl+letter, so Ctrl+K would reach Claude as U+000B (kill-to-end-of-line)
 * before the listener ever saw it. Cmd carries `meta` and Ctrl+Shift+P carries
 * `shift`, so neither chord produces a keypress the terminal would forward.
 */
export function isCommandPaletteShortcut(chord: KeyChord, platform: ShortcutPlatform): boolean {
  if (chord.alt) return false;
  if (platform === 'mac') {
    return chord.meta && !chord.ctrl && !chord.shift && chord.key.toLowerCase() === 'k';
  }
  return chord.ctrl && chord.shift && !chord.meta && chord.key.toLowerCase() === 'p';
}

export type ScopeShortcut = 'sessions' | 'workspaces' | 'files';

const SCOPE_SHORTCUTS: Record<
  ShortcutPlatform,
  ReadonlyArray<{ scope: ScopeShortcut; key: string; shift: boolean; label: string }>
> = {
  mac: [
    { scope: 'sessions', key: 'p', shift: false, label: '⌘P' },
    { scope: 'workspaces', key: 'p', shift: true, label: '⇧⌘P' },
    { scope: 'files', key: 'o', shift: true, label: '⇧⌘O' },
  ],
  other: [
    { scope: 'sessions', key: 's', shift: true, label: 'Ctrl+Shift+S' },
    { scope: 'workspaces', key: 'w', shift: true, label: 'Ctrl+Shift+W' },
    { scope: 'files', key: 'o', shift: true, label: 'Ctrl+Shift+O' },
  ],
};

/** The scope a key press asks the palette to open on, or null if it is not one of these chords. */
export function matchScopeShortcut(
  chord: KeyChord,
  platform: ShortcutPlatform,
): ScopeShortcut | null {
  if (!hasPrimary(chord, platform) || chord.alt) return null;
  const key = chord.key.toLowerCase();
  const match = SCOPE_SHORTCUTS[platform].find(
    (entry) => entry.key === key && entry.shift === chord.shift,
  );
  return match?.scope ?? null;
}

/** How each scope chord is written, for the palette's section headers. */
export function scopeShortcutLabels(
  platform: ShortcutPlatform,
): Partial<Record<ScopeShortcut, string>> {
  return Object.fromEntries(SCOPE_SHORTCUTS[platform].map((entry) => [entry.scope, entry.label]));
}

/** Cmd/Ctrl + \ shows or hides the sidebar. */
export function isSidebarShortcut(chord: KeyChord, platform: ShortcutPlatform): boolean {
  return hasPrimary(chord, platform) && !chord.alt && chord.key === '\\';
}

/** Ctrl+` shows or hides the session's terminal, on every platform. */
export function isShellShortcut(chord: KeyChord): boolean {
  return (
    chord.ctrl &&
    !chord.meta &&
    !chord.alt &&
    !chord.shift &&
    (chord.code === 'Backquote' || chord.key === '`')
  );
}

/**
 * Shows or hides the browser panel: Shift+Cmd+L on macOS, Ctrl+Shift+L
 * elsewhere. Shift keeps it clear of a bare Ctrl+L (a PTY byte) and of Cmd+L,
 * which a page in the panel uses for its address bar.
 */
export function isBrowserShortcut(chord: KeyChord, platform: ShortcutPlatform): boolean {
  return (
    hasPrimary(chord, platform) && chord.shift && !chord.alt && chord.key.toLowerCase() === 'l'
  );
}

export const BROWSER_SHORTCUT_LABELS: Record<ShortcutPlatform, string> = {
  mac: '⇧⌘L',
  other: 'Ctrl+Shift+L',
};

/** What a chord pressed inside a page asks the browser panel to do. */
export type BrowserFocusedAction =
  | 'focus-address'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

/**
 * The browser's own chords, as a person would press them in a page: ⌘L, ⌘R,
 * ⇧⌘R, ⌘[, ⌘], ⌘F, ⌘+, ⌘-, ⌘0 (Ctrl elsewhere). They only mean something
 * while a page has focus, which is why the renderer never binds them itself.
 */
export function matchBrowserFocusedShortcut(
  chord: KeyChord,
  platform: ShortcutPlatform,
): BrowserFocusedAction | null {
  if (!hasPrimary(chord, platform) || chord.alt || chord.isComposing) return null;
  const key = chord.key.toLowerCase();
  const code = chord.code;
  if (key === 'l' && !chord.shift) return 'focus-address';
  if (key === 'r') return chord.shift ? 'hard-reload' : 'reload';
  if (chord.shift) {
    // Zoom in is Cmd+Shift+= on a US layout, which reports `+`.
    return key === '+' ? 'zoom-in' : null;
  }
  if (key === '[' || code === 'BracketLeft') return 'back';
  if (key === ']' || code === 'BracketRight') return 'forward';
  if (key === 'f') return 'find';
  if (key === '=' || key === '+') return 'zoom-in';
  if (key === '-' || code === 'Minus') return 'zoom-out';
  if (key === '0' || code === 'Digit0') return 'zoom-reset';
  return null;
}

/** An app chord, or a browser chord, pressed while a page had focus. */
export type ForwardedShortcut =
  | { kind: 'command-palette' }
  | { kind: 'scoped-palette'; scope: ScopeShortcut }
  | { kind: 'workspace'; index: number }
  | { kind: 'sidebar' }
  | { kind: 'terminal' }
  | { kind: 'browser' }
  | { kind: BrowserFocusedAction };

/**
 * Which chord, if any, main should take from a page and send to the window.
 *
 * App chords come first so the toggle (⇧⌘L) wins over focus-address (⌘L) and
 * nothing else about a page's own keys is ever claimed: copy, paste, typing and
 * every chord not listed here stay with the page.
 */
export function forwardedShortcutFor(
  chord: KeyChord,
  platform: ShortcutPlatform,
): ForwardedShortcut | null {
  const workspace = matchWorkspaceShortcut(chord, platform);
  if (workspace !== null) return { kind: 'workspace', index: workspace };
  if (isCommandPaletteShortcut(chord, platform)) return { kind: 'command-palette' };
  const scope = matchScopeShortcut(chord, platform);
  if (scope) return { kind: 'scoped-palette', scope };
  if (isSidebarShortcut(chord, platform)) return { kind: 'sidebar' };
  if (isShellShortcut(chord)) return { kind: 'terminal' };
  if (isBrowserShortcut(chord, platform)) return { kind: 'browser' };
  const action = matchBrowserFocusedShortcut(chord, platform);
  return action ? { kind: action } : null;
}

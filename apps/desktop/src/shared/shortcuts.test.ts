import { describe, expect, it } from 'vitest';
import {
  BROWSER_SHORTCUT_LABELS,
  forwardedShortcutFor,
  isBrowserShortcut,
  isCloseShortcut,
  INFO_PANEL_SHORTCUT_LABELS,
  isCommandPaletteShortcut,
  isInfoPanelShortcut,
  isOpenInShortcut,
  isShellShortcut,
  isSidebarShortcut,
  isSidePanelShortcut,
  matchBrowserFocusedShortcut,
  matchScopeShortcut,
  matchWorkspaceShortcut,
  OPEN_IN_SHORTCUT_LABELS,
  SIDE_PANEL_SHORTCUT_LABELS,
} from './shortcuts';
import type { KeyChord } from './shortcuts';

function chord(key: string, mods: Partial<KeyChord> = {}): KeyChord {
  return { key, meta: false, ctrl: false, shift: false, alt: false, ...mods };
}
const cmd = (key: string, mods: Partial<KeyChord> = {}) => chord(key, { meta: true, ...mods });
const ctrl = (key: string, mods: Partial<KeyChord> = {}) => chord(key, { ctrl: true, ...mods });

describe('workspace chords', () => {
  it('maps the platform modifier plus 1-9 to a zero-based index', () => {
    expect(matchWorkspaceShortcut(cmd('3'), 'mac')).toBe(2);
    expect(matchWorkspaceShortcut(ctrl('9'), 'other')).toBe(8);
  });

  it('ignores the other platform modifier, extra modifiers, zero and composition', () => {
    expect(matchWorkspaceShortcut(ctrl('3'), 'mac')).toBeNull();
    expect(matchWorkspaceShortcut(cmd('3'), 'other')).toBeNull();
    expect(matchWorkspaceShortcut(cmd('3', { shift: true }), 'mac')).toBeNull();
    expect(matchWorkspaceShortcut(cmd('0'), 'mac')).toBeNull();
    expect(matchWorkspaceShortcut(cmd('3', { isComposing: true }), 'mac')).toBeNull();
  });

  it('reads the physical digit so shifted layouts still match', () => {
    expect(matchWorkspaceShortcut(cmd('&', { code: 'Digit1' }), 'mac')).toBe(0);
  });
});

describe('palette chords', () => {
  it('is Cmd+K on macOS and Ctrl+Shift+P elsewhere', () => {
    expect(isCommandPaletteShortcut(cmd('k'), 'mac')).toBe(true);
    expect(isCommandPaletteShortcut(ctrl('k'), 'mac')).toBe(false);
    expect(isCommandPaletteShortcut(ctrl('P', { shift: true }), 'other')).toBe(true);
    expect(isCommandPaletteShortcut(ctrl('k'), 'other')).toBe(false);
  });

  it('opens the scoped palettes per platform', () => {
    expect(matchScopeShortcut(cmd('p'), 'mac')).toBe('sessions');
    expect(matchScopeShortcut(cmd('P', { shift: true }), 'mac')).toBe('workspaces');
    expect(matchScopeShortcut(cmd('o', { shift: true }), 'mac')).toBe('files');
    expect(matchScopeShortcut(ctrl('s', { shift: true }), 'other')).toBe('sessions');
    expect(matchScopeShortcut(ctrl('w', { shift: true }), 'other')).toBe('workspaces');
    expect(matchScopeShortcut(ctrl('p'), 'other')).toBeNull();
    expect(matchScopeShortcut(cmd('p', { alt: true }), 'mac')).toBeNull();
  });
});

describe('sidebar and terminal chords', () => {
  it('toggles the sidebar on the platform modifier plus backslash', () => {
    expect(isSidebarShortcut(cmd('\\'))).toBe(true);
    expect(isSidebarShortcut(ctrl('\\'))).toBe(true);
  });

  it('accepts either modifier on either platform, as it always did', () => {
    expect(isSidebarShortcut(ctrl('\\'))).toBe(true); // Ctrl+\ on macOS
    expect(isSidebarShortcut(cmd('\\'))).toBe(true); // Cmd+\ elsewhere
  });

  it('accepts layouts that type backslash with Option or AltGr', () => {
    expect(isSidebarShortcut(cmd('\\', { alt: true }))).toBe(true);
    expect(isSidebarShortcut(ctrl('\\', { alt: true }))).toBe(true);
  });

  it('needs a modifier and the backslash', () => {
    expect(isSidebarShortcut(chord('\\'))).toBe(false);
    expect(isSidebarShortcut(cmd('/'))).toBe(false);
  });

  it('toggles the terminal on a bare Ctrl+backtick, by key or physical key', () => {
    expect(isShellShortcut(ctrl('`'))).toBe(true);
    expect(isShellShortcut(ctrl('¸', { code: 'Backquote' }))).toBe(true);
    expect(isShellShortcut(ctrl('`', { shift: true }))).toBe(false);
    expect(isShellShortcut(cmd('`'))).toBe(false);
  });
});

describe('browser toggle chord', () => {
  it('is Shift+Cmd+L on macOS and Ctrl+Shift+L elsewhere', () => {
    expect(isBrowserShortcut(cmd('L', { shift: true }), 'mac')).toBe(true);
    expect(isBrowserShortcut(ctrl('L', { shift: true }), 'other')).toBe(true);
  });

  it('is not Cmd+L alone, the wrong platform modifier, or with Alt', () => {
    expect(isBrowserShortcut(cmd('l'), 'mac')).toBe(false);
    expect(isBrowserShortcut(ctrl('L', { shift: true }), 'mac')).toBe(false);
    expect(isBrowserShortcut(cmd('L', { shift: true }), 'other')).toBe(false);
    expect(isBrowserShortcut(cmd('L', { shift: true, alt: true }), 'mac')).toBe(false);
  });

  it('is labelled for each platform', () => {
    expect(BROWSER_SHORTCUT_LABELS.mac).toBe('⇧⌘L');
    expect(BROWSER_SHORTCUT_LABELS.other).toBe('Ctrl+Shift+L');
  });
});

describe('side panel chord', () => {
  // Option turns B into ∫ on a Mac, so the chord is matched on the physical key.
  const mac = (mods: Partial<KeyChord> = {}) => cmd('∫', { alt: true, code: 'KeyB', ...mods });
  const other = (mods: Partial<KeyChord> = {}) => ctrl('b', { alt: true, code: 'KeyB', ...mods });

  it('is Option+Cmd+B on macOS and Ctrl+Alt+B elsewhere', () => {
    expect(isSidePanelShortcut(mac(), 'mac')).toBe(true);
    expect(isSidePanelShortcut(other(), 'other')).toBe(true);
  });

  // The Working shelf's chord is Shift+Cmd+B, without Option: this one never has Shift.
  it('is not with Shift', () => {
    expect(isSidePanelShortcut(mac({ shift: true }), 'mac')).toBe(false);
    expect(isSidePanelShortcut(other({ shift: true }), 'other')).toBe(false);
  });

  it('is not another key', () => {
    expect(isSidePanelShortcut(mac({ code: 'KeyN' }), 'mac')).toBe(false);
    expect(isSidePanelShortcut(other({ code: 'KeyN' }), 'other')).toBe(false);
  });

  it('is not the other platform’s chord, nor both modifiers at once', () => {
    expect(isSidePanelShortcut(other(), 'mac')).toBe(false);
    expect(isSidePanelShortcut(mac(), 'other')).toBe(false);
    expect(isSidePanelShortcut(mac({ ctrl: true }), 'mac')).toBe(false);
    expect(isSidePanelShortcut(other({ meta: true }), 'other')).toBe(false);
  });

  it('needs Alt', () => {
    expect(isSidePanelShortcut(cmd('b', { code: 'KeyB' }), 'mac')).toBe(false);
    expect(isSidePanelShortcut(ctrl('b', { code: 'KeyB' }), 'other')).toBe(false);
  });

  it('is labelled for each platform', () => {
    expect(SIDE_PANEL_SHORTCUT_LABELS.mac).toBe('⌥⌘B');
    expect(SIDE_PANEL_SHORTCUT_LABELS.other).toBe('Ctrl+Alt+B');
  });
});

describe('info panel chord', () => {
  // Option turns J into ∆ on a Mac, so the chord is matched on the physical key.
  const mac = (mods: Partial<KeyChord> = {}) => cmd('∆', { alt: true, code: 'KeyJ', ...mods });
  const other = (mods: Partial<KeyChord> = {}) => ctrl('j', { alt: true, code: 'KeyJ', ...mods });

  it('is Option+Cmd+J on macOS and Ctrl+Alt+J elsewhere', () => {
    expect(isInfoPanelShortcut(mac(), 'mac')).toBe(true);
    expect(isInfoPanelShortcut(other(), 'other')).toBe(true);
  });

  it('is not with Shift', () => {
    expect(isInfoPanelShortcut(mac({ shift: true }), 'mac')).toBe(false);
    expect(isInfoPanelShortcut(other({ shift: true }), 'other')).toBe(false);
  });

  it('is not another key', () => {
    expect(isInfoPanelShortcut(mac({ code: 'KeyB' }), 'mac')).toBe(false);
    expect(isInfoPanelShortcut(other({ code: 'KeyB' }), 'other')).toBe(false);
  });

  it('is not the other platform’s chord, nor both modifiers at once', () => {
    expect(isInfoPanelShortcut(other(), 'mac')).toBe(false);
    expect(isInfoPanelShortcut(mac(), 'other')).toBe(false);
    expect(isInfoPanelShortcut(mac({ ctrl: true }), 'mac')).toBe(false);
    expect(isInfoPanelShortcut(other({ meta: true }), 'other')).toBe(false);
  });

  it('needs Alt', () => {
    expect(isInfoPanelShortcut(cmd('j', { code: 'KeyJ' }), 'mac')).toBe(false);
    expect(isInfoPanelShortcut(ctrl('j', { code: 'KeyJ' }), 'other')).toBe(false);
  });

  it('is labelled for each platform', () => {
    expect(INFO_PANEL_SHORTCUT_LABELS.mac).toBe('⌥⌘J');
    expect(INFO_PANEL_SHORTCUT_LABELS.other).toBe('Ctrl+Alt+J');
  });
});

describe('open-in chord', () => {
  // Elsewhere a bare Ctrl+letter is the terminal's (Claude Code's and nano's
  // Ctrl+O among them), so the chord takes Alt there, matched on the physical
  // key as the info panel's is.
  const other = (mods: Partial<KeyChord> = {}) => ctrl('o', { alt: true, code: 'KeyO', ...mods });

  it('is Cmd+O on macOS and Ctrl+Alt+O elsewhere', () => {
    expect(isOpenInShortcut(cmd('o'), 'mac')).toBe(true);
    expect(isOpenInShortcut(other(), 'other')).toBe(true);
    // A layout where Alt changes the letter still has the key.
    expect(isOpenInShortcut(other({ key: 'ø' }), 'other')).toBe(true);
  });

  it('leaves a bare Ctrl+O to the terminal off macOS', () => {
    expect(isOpenInShortcut(ctrl('o', { code: 'KeyO' }), 'other')).toBe(false);
  });

  it('leaves Shift+Cmd+O to the Files scope of the palette, and is never with Shift', () => {
    expect(isOpenInShortcut(cmd('O', { shift: true }), 'mac')).toBe(false);
    expect(isOpenInShortcut(other({ shift: true }), 'other')).toBe(false);
    expect(matchScopeShortcut(cmd('O', { shift: true }), 'mac')).toBe('files');
  });

  it('is not with Alt on macOS, the other platform’s chord, or both modifiers at once', () => {
    expect(isOpenInShortcut(cmd('o', { alt: true }), 'mac')).toBe(false);
    expect(isOpenInShortcut(ctrl('o'), 'mac')).toBe(false);
    expect(isOpenInShortcut(other(), 'mac')).toBe(false);
    expect(isOpenInShortcut(cmd('o'), 'other')).toBe(false);
    expect(isOpenInShortcut(cmd('o', { ctrl: true }), 'mac')).toBe(false);
    expect(isOpenInShortcut(other({ meta: true }), 'other')).toBe(false);
  });

  it('is not while composing, nor another key', () => {
    expect(isOpenInShortcut(cmd('o', { isComposing: true }), 'mac')).toBe(false);
    expect(isOpenInShortcut(other({ isComposing: true }), 'other')).toBe(false);
    expect(isOpenInShortcut(cmd('p'), 'mac')).toBe(false);
    expect(isOpenInShortcut(other({ code: 'KeyP' }), 'other')).toBe(false);
  });

  it('is labelled for each platform', () => {
    expect(OPEN_IN_SHORTCUT_LABELS.mac).toBe('⌘O');
    expect(OPEN_IN_SHORTCUT_LABELS.other).toBe('Ctrl+Alt+O');
  });
});

describe('close chord', () => {
  it('is Cmd+W on macOS', () => {
    expect(isCloseShortcut(cmd('w'), 'mac')).toBe(true);
    expect(isCloseShortcut(cmd('W'), 'mac')).toBe(true);
  });

  it('is nothing elsewhere: Ctrl+W deletes a word in the terminal', () => {
    expect(isCloseShortcut(ctrl('w'), 'other')).toBe(false);
    expect(isCloseShortcut(cmd('w'), 'other')).toBe(false);
  });

  it('leaves Shift+Cmd+W to the window, and other modifiers alone', () => {
    expect(isCloseShortcut(cmd('W', { shift: true }), 'mac')).toBe(false);
    expect(isCloseShortcut(cmd('w', { alt: true }), 'mac')).toBe(false);
    expect(isCloseShortcut(cmd('w', { ctrl: true }), 'mac')).toBe(false);
    expect(isCloseShortcut(ctrl('w'), 'mac')).toBe(false);
  });
});

describe('browser-focused chords', () => {
  it('maps each chord to its action on macOS', () => {
    expect(matchBrowserFocusedShortcut(cmd('l'), 'mac')).toBe('focus-address');
    expect(matchBrowserFocusedShortcut(cmd('r'), 'mac')).toBe('reload');
    expect(matchBrowserFocusedShortcut(cmd('R', { shift: true }), 'mac')).toBe('hard-reload');
    expect(matchBrowserFocusedShortcut(cmd('['), 'mac')).toBe('back');
    expect(matchBrowserFocusedShortcut(cmd(']'), 'mac')).toBe('forward');
    expect(matchBrowserFocusedShortcut(cmd('f'), 'mac')).toBe('find');
    expect(matchBrowserFocusedShortcut(cmd('='), 'mac')).toBe('zoom-in');
    expect(matchBrowserFocusedShortcut(cmd('+', { shift: true }), 'mac')).toBe('zoom-in');
    expect(matchBrowserFocusedShortcut(cmd('-'), 'mac')).toBe('zoom-out');
    expect(matchBrowserFocusedShortcut(cmd('0'), 'mac')).toBe('zoom-reset');
  });

  it('uses Ctrl elsewhere and ignores the other platform modifier', () => {
    expect(matchBrowserFocusedShortcut(ctrl('l'), 'other')).toBe('focus-address');
    expect(matchBrowserFocusedShortcut(ctrl('r'), 'other')).toBe('reload');
    expect(matchBrowserFocusedShortcut(cmd('r'), 'other')).toBeNull();
    expect(matchBrowserFocusedShortcut(ctrl('r'), 'mac')).toBeNull();
  });

  it('leaves Alt chords and bare keys to the page', () => {
    expect(matchBrowserFocusedShortcut(cmd('r', { alt: true }), 'mac')).toBeNull();
    expect(matchBrowserFocusedShortcut(chord('r'), 'mac')).toBeNull();
    expect(matchBrowserFocusedShortcut(cmd('c'), 'mac')).toBeNull();
  });
});

describe('forwardedShortcutFor', () => {
  it('forwards the app chords with their payload', () => {
    expect(forwardedShortcutFor(cmd('k'), 'mac')).toEqual({ kind: 'command-palette' });
    expect(forwardedShortcutFor(cmd('2'), 'mac')).toEqual({ kind: 'workspace', index: 1 });
    expect(forwardedShortcutFor(cmd('p'), 'mac')).toEqual({
      kind: 'scoped-palette',
      scope: 'sessions',
    });
    expect(forwardedShortcutFor(cmd('\\'), 'mac')).toEqual({ kind: 'sidebar' });
    expect(forwardedShortcutFor(ctrl('`'), 'other')).toEqual({ kind: 'terminal' });
    expect(forwardedShortcutFor(ctrl('L', { shift: true }), 'other')).toEqual({ kind: 'browser' });
    expect(forwardedShortcutFor(cmd('∫', { alt: true, code: 'KeyB' }), 'mac')).toEqual({
      kind: 'side-panel',
    });
    expect(forwardedShortcutFor(ctrl('b', { alt: true, code: 'KeyB' }), 'other')).toEqual({
      kind: 'side-panel',
    });
    expect(forwardedShortcutFor(cmd('∆', { alt: true, code: 'KeyJ' }), 'mac')).toEqual({
      kind: 'info-panel',
    });
    expect(forwardedShortcutFor(ctrl('j', { alt: true, code: 'KeyJ' }), 'other')).toEqual({
      kind: 'info-panel',
    });
    expect(forwardedShortcutFor(cmd('o'), 'mac')).toEqual({ kind: 'open-in' });
    expect(forwardedShortcutFor(ctrl('o', { alt: true, code: 'KeyO' }), 'other')).toEqual({
      kind: 'open-in',
    });
  });

  it('leaves a bare Ctrl+O to the page off macOS', () => {
    expect(forwardedShortcutFor(ctrl('o', { code: 'KeyO' }), 'other')).toBeNull();
  });

  it('forwards Shift+Cmd+O as the Files scope, not as the open-in chord', () => {
    expect(forwardedShortcutFor(cmd('O', { shift: true }), 'mac')).toEqual({
      kind: 'scoped-palette',
      scope: 'files',
    });
  });

  it('forwards the browser chords as their action', () => {
    expect(forwardedShortcutFor(cmd('l'), 'mac')).toEqual({ kind: 'focus-address' });
    expect(forwardedShortcutFor(cmd('0'), 'mac')).toEqual({ kind: 'zoom-reset' });
  });

  it('forwards the close chord on macOS only', () => {
    expect(forwardedShortcutFor(cmd('w'), 'mac')).toEqual({ kind: 'close' });
    expect(forwardedShortcutFor(cmd('W', { shift: true }), 'mac')).toBeNull();
    expect(forwardedShortcutFor(ctrl('w'), 'other')).toBeNull();
  });

  it('prefers the toggle over the focus-address chord that shares its letter', () => {
    expect(forwardedShortcutFor(cmd('L', { shift: true }), 'mac')).toEqual({ kind: 'browser' });
  });

  it('forwards nothing for page input', () => {
    expect(forwardedShortcutFor(chord('a'), 'mac')).toBeNull();
    expect(forwardedShortcutFor(cmd('c'), 'mac')).toBeNull();
    expect(forwardedShortcutFor(cmd('v'), 'mac')).toBeNull();
    expect(forwardedShortcutFor(chord('Enter'), 'mac')).toBeNull();
  });
});

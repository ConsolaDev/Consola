import { describe, expect, it } from 'vitest';
import { decideGuestShortcut, type GuestKeyInput } from './guestShortcuts';

function input(key: string, mods: Partial<GuestKeyInput> = {}): GuestKeyInput {
  return {
    type: 'keyDown',
    key,
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...mods,
  };
}

describe('decideGuestShortcut', () => {
  it('takes an app chord on macOS and sends it', () => {
    expect(decideGuestShortcut(input('k', { meta: true }), 'darwin')).toEqual({
      action: { kind: 'command-palette' },
      send: true,
    });
  });

  it('takes Ctrl chords elsewhere', () => {
    expect(decideGuestShortcut(input('L', { control: true, shift: true }), 'win32')).toEqual({
      action: { kind: 'browser' },
      send: true,
    });
    expect(decideGuestShortcut(input('k', { meta: true }), 'linux')).toBeNull();
  });

  it('takes the browser chords', () => {
    expect(decideGuestShortcut(input('l', { meta: true }), 'darwin')?.action).toEqual({
      kind: 'focus-address',
    });
    expect(decideGuestShortcut(input('['), 'darwin')).toBeNull();
    expect(decideGuestShortcut(input('[', { meta: true }), 'darwin')?.action).toEqual({
      kind: 'back',
    });
  });

  it('leaves typing, copy and paste, and key-ups to the page', () => {
    expect(decideGuestShortcut(input('a'), 'darwin')).toBeNull();
    expect(decideGuestShortcut(input('c', { meta: true }), 'darwin')).toBeNull();
    expect(decideGuestShortcut(input('v', { meta: true }), 'darwin')).toBeNull();
    expect(decideGuestShortcut(input('k', { meta: true, type: 'keyUp' }), 'darwin')).toBeNull();
  });

  it('takes ⌘W on macOS and leaves Ctrl+W to the page elsewhere', () => {
    expect(decideGuestShortcut(input('w', { meta: true }), 'darwin')).toEqual({
      action: { kind: 'close' },
      send: true,
    });
    expect(decideGuestShortcut(input('w', { control: true }), 'linux')).toBeNull();
    // ⇧⌘W is the window's, through the menu.
    expect(decideGuestShortcut(input('W', { meta: true, shift: true }), 'darwin')).toBeNull();
  });

  it('keeps a held ⌘W from the page and sends it once: held, it closes one thing', () => {
    expect(decideGuestShortcut(input('w', { meta: true, isAutoRepeat: true }), 'darwin')).toEqual({
      action: { kind: 'close' },
      send: false,
    });
  });

  it('keeps a held chord from the page but sends it once', () => {
    expect(decideGuestShortcut(input('r', { meta: true, isAutoRepeat: true }), 'darwin')).toEqual({
      action: { kind: 'reload' },
      send: false,
    });
  });
});

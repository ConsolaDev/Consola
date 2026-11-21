import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CertificateTrust } from './CertificateTrust';
import { installPopupPolicy, isGestureKey, PopupRegistry, type PopupHandle } from './popupWindows';

function fakePopup(): PopupHandle & { destroyed: boolean } {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** Whose a popup is: its page's id and its opener's tab are made up per test. */
const owner = (sessionId: string, workspaceId: string, host: string, contentsId = 0) => ({
  sessionId,
  workspaceId,
  host,
  contentsId,
  openerTabId: `${sessionId}-tab`,
});

describe('PopupRegistry', () => {
  it('destroys only the popups the match names', () => {
    const registry = new PopupRegistry();
    const mine = fakePopup();
    const theirs = fakePopup();
    registry.track(mine, owner('s1', 'w1', 'a'));
    registry.track(theirs, owner('s2', 'w2', 'b'));

    registry.closeWhere((owner) => owner.sessionId === 's1');

    expect(mine.destroyed).toBe(true);
    expect(theirs.destroyed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('closes everything on quit, and skips one already gone', () => {
    const registry = new PopupRegistry();
    const gone = fakePopup();
    const open = fakePopup();
    registry.track(gone, owner('s1', 'w1', 'a'));
    registry.track(open, owner('s1', 'w1', 'a'));
    gone.destroyed = true;

    registry.closeAll();

    expect(open.destroyed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('forgets a popup that closed by itself', () => {
    const registry = new PopupRegistry();
    const popup = fakePopup();
    registry.track(popup, owner('s1', 'w1', 'a'));
    registry.forget(popup);
    expect(registry.size).toBe(0);
  });

  it("names the tab whose page opened a popup, by the popup's page, until the popup closes", () => {
    const registry = new PopupRegistry();
    const popup = fakePopup();
    registry.track(popup, owner('s1', 'w1', 'a', 20));
    expect(registry.openerTabOf(20)).toBe('s1-tab');
    expect(registry.openerTabOf(21)).toBeUndefined();
    registry.forget(popup);
    expect(registry.openerTabOf(20)).toBeUndefined();
  });
});

/** A key as Electron's `before-input-event` gives it. */
const keyDown = (
  key: string,
  held: Partial<Record<'meta' | 'control' | 'shift' | 'alt', boolean>> = {},
) => ({
  type: 'keyDown',
  key,
  code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  meta: false,
  control: false,
  shift: false,
  alt: false,
  ...held,
});

describe('isGestureKey', () => {
  it('counts a key going down that the page gets', () => {
    expect(isGestureKey(keyDown('a'), 'darwin')).toBe(true);
    expect(isGestureKey(keyDown('Enter'), 'darwin')).toBe(true);
    expect(isGestureKey({ ...keyDown('a'), type: 'keyUp' }, 'darwin')).toBe(false);
  });

  it('never counts a chord the app takes from the page, which the page never sees', () => {
    // The palette, closing a tab, and quitting.
    expect(isGestureKey(keyDown('k', { meta: true }), 'darwin')).toBe(false);
    expect(isGestureKey(keyDown('w', { meta: true }), 'darwin')).toBe(false);
    expect(isGestureKey(keyDown('q', { meta: true }), 'darwin')).toBe(false);
    expect(isGestureKey(keyDown('Q', { meta: true }), 'darwin')).toBe(false);
  });
});

describe('installPopupPolicy', () => {
  /** A page's guest, and its window-open handler as the policy sets it. */
  function policed() {
    const guest = Object.assign(new EventEmitter(), {
      handler: undefined as undefined | ((details: unknown) => { action: string }),
      setWindowOpenHandler(handler: (details: unknown) => { action: string }) {
        this.handler = handler;
      },
    });
    installPopupPolicy(guest as unknown as WebContents, {
      host: {} as BrowserWindow,
      guestId: 4,
      sessionIdOf: () => 's1',
      tabIdOf: () => 't1',
      workspaceId: 'w1',
      atTabCap: () => false,
      openTab: vi.fn(),
      popups: new PopupRegistry(),
      certificates: { guard: vi.fn() } as unknown as CertificateTrust,
      createWindow: vi.fn(),
      maxSize: () => ({ width: 1000, height: 800 }),
      guardQuit: vi.fn(),
    });
    /** What the page's `window.open` of a sized popup gets now. */
    const openPopup = () =>
      guest.handler?.({
        url: 'https://login.example.com/',
        disposition: 'new-window',
        features: 'width=400,height=500',
      }).action;
    return { guest, openPopup };
  }

  it('lets a sized popup follow a press of a mouse button, and not its release', () => {
    const { guest, openPopup } = policed();
    guest.emit('input-event', {}, { type: 'mouseUp' });
    expect(openPopup()).toBe('deny');
    guest.emit('input-event', {}, { type: 'mouseDown' });
    expect(openPopup()).toBe('allow');
  });

  it('lets one follow a key the page gets, and never an app chord', () => {
    const { guest, openPopup } = policed();
    guest.emit(
      'before-input-event',
      {},
      keyDown('k', { meta: process.platform === 'darwin', control: process.platform !== 'darwin' }),
    );
    if (process.platform === 'darwin') {
      guest.emit('before-input-event', {}, keyDown('q', { meta: true }));
      guest.emit('before-input-event', {}, keyDown('w', { meta: true }));
    }
    expect(openPopup()).toBe('deny');
    guest.emit('before-input-event', {}, keyDown('a'));
    expect(openPopup()).toBe('allow');
  });
});

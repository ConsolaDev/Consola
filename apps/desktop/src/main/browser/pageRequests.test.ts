import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CertificateTrust } from './CertificateTrust';
import { secureGuest } from './guestPolicy';
import { hardenPopup } from './popupWindows';

/** A page's web contents: its events, and what the installers call on it. */
class FakeContents extends EventEmitter {
  readonly id = 7;
  setWindowOpenHandler = vi.fn();
  getURL = () => 'https://example.com/';
  getTitle = () => '';
  isDestroyed = () => false;
}

/** Every guest gets its floor from `secureGuest`; every popup from `hardenPopup`. */
const installers: Array<[string, (contents: FakeContents) => void]> = [
  ['every guest', (contents) => secureGuest(contents as unknown as WebContents)],
  [
    'every popup',
    (contents) => {
      const popup = {
        webContents: contents,
        setMenu: vi.fn(),
        setTitle: vi.fn(),
        isDestroyed: () => false,
      };
      const certificates = { guard: vi.fn() } as unknown as CertificateTrust;
      hardenPopup(popup as unknown as BrowserWindow, certificates, 'w1');
    },
  ],
];

/**
 * What a page can ask for that Electron would answer itself, and how each is
 * answered: the default always prevented, and the callback (when there is
 * one) given nothing.
 */
const requests: Array<[string, unknown[], unknown[] | null]> = [
  // A client certificate: none, rather than the first in the system store.
  ['select-client-certificate', ['https://example.com/', [{ subjectName: 'Me' }]], []],
  // A Bluetooth device: none, rather than the first that matches.
  ['select-bluetooth-device', [[{ deviceId: 'nearby', deviceName: 'Phone' }]], ['']],
  // A page's `beforeunload`: ignored, so the page goes, rather than kept with no word.
  ['will-prevent-unload', [], null],
];

describe.each(installers)('%s', (_who, install) => {
  it.each(requests)('refuses %s', (event, args, answered) => {
    const contents = new FakeContents();
    install(contents);
    expect(contents.listenerCount(event)).toBeGreaterThan(0);
    const preventDefault = vi.fn();
    const callback = vi.fn();
    contents.emit(event, { preventDefault }, ...args, ...(answered ? [callback] : []));
    expect(preventDefault).toHaveBeenCalled();
    if (answered) expect(callback).toHaveBeenCalledWith(...answered);
  });
});

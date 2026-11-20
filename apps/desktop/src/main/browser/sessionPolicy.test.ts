import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserTab, browserPartitionFor } from '../../shared/browser';
import {
  configurePartition,
  decideDownload,
  decidePermission,
  downloadDialogTitle,
  type DownloadPlaces,
  downloadSource,
  gateDownloads,
  partitionFor,
} from './sessionPolicy';

describe('decideDownload', () => {
  it("cancels a download from a page of a tab in the agent's hands, at any time", () => {
    expect(decideDownload({ kind: 'tabs', hands: ['agent'] })).toBe('cancel');
  });

  it("allows one from a tab in the person's hands", () => {
    expect(decideDownload({ kind: 'tabs', hands: ['person'] })).toBe('allow');
  });

  it("cancels for a page not bound yet when any tab it may be is in the agent's hands", () => {
    expect(decideDownload({ kind: 'tabs', hands: ['person', 'agent'] })).toBe('cancel');
    expect(decideDownload({ kind: 'tabs', hands: ['person', 'person'] })).toBe('allow');
  });

  it('cancels one from a page main cannot place, and allows one with no page at all', () => {
    expect(decideDownload({ kind: 'unknown' })).toBe('cancel');
    expect(decideDownload({ kind: 'tabs', hands: [] })).toBe('cancel');
    expect(decideDownload({ kind: 'none' })).toBe('allow');
  });
});

describe('downloadSource', () => {
  const tab = (id: string, openedBy: 'person' | 'agent' = 'person'): BrowserTab => ({
    id,
    url: 'https://example.com/',
    title: '',
    openedBy,
  });
  const page = (id: number, destroyed = false) =>
    ({ id, isDestroyed: () => destroyed }) as unknown as WebContents;
  /** Tab 1's page is bound; popup window 20 was opened by tab 2's; page 30 is not bound yet. */
  const places: DownloadPlaces = {
    tabsForPage: (contents) =>
      contents.id === 1 ? [tab('t1')] : contents.id === 30 ? [tab('t3')] : [],
    popupOpener: (contents) => (contents.id === 20 ? tab('t2', 'agent') : undefined),
    handsOf: (of) => (of.id === 't1' ? 'person' : 'agent'),
  };

  it('places a tab’s page by its tab, and a page not bound yet by each tab it may be', () => {
    expect(downloadSource(page(1), places)).toEqual({ kind: 'tabs', hands: ['person'] });
    expect(downloadSource(page(30), places)).toEqual({ kind: 'tabs', hands: ['agent'] });
  });

  it('places a popup window by the tab whose page opened it', () => {
    expect(downloadSource(page(20), places)).toEqual({ kind: 'tabs', hands: ['agent'] });
    const personsOpener: DownloadPlaces = { ...places, handsOf: () => 'person' };
    expect(decideDownload(downloadSource(page(20), personsOpener))).toBe('allow');
    expect(decideDownload(downloadSource(page(20), places))).toBe('cancel');
  });

  it('fails closed for a page in a browser partition that is no tab’s or popup’s, or is gone', () => {
    expect(downloadSource(page(99), places)).toEqual({ kind: 'unknown' });
    expect(downloadSource(page(1, true), places)).toEqual({ kind: 'unknown' });
    expect(decideDownload(downloadSource(page(99), places))).toBe('cancel');
  });

  it('leaves a download with no page as it was', () => {
    expect(downloadSource(undefined, places)).toEqual({ kind: 'none' });
    expect(decideDownload(downloadSource(undefined, places))).toBe('allow');
  });
});

describe('decidePermission', () => {
  it.each(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])('allows %s', (permission) => {
    expect(decidePermission(permission)).toBe(true);
  });

  it.each([
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'midi',
    'openExternal',
    'display-capture',
    'unknown-future-permission',
  ])('denies %s', (permission) => {
    expect(decidePermission(permission)).toBe(false);
  });
});

describe('partitionFor', () => {
  it('is the shared partition string for that workspace', () => {
    expect(partitionFor('ws-1')).toBe(browserPartitionFor('ws-1'));
  });
});

describe('downloadDialogTitle', () => {
  it('names the site that offers the file', () => {
    expect(downloadDialogTitle('https://files.example.com:8443/a.zip')).toBe(
      'Save a file from files.example.com:8443',
    );
  });

  it('falls back to a plain title for an address with no host', () => {
    expect(downloadDialogTitle('blob:')).toBe('Save file');
    expect(downloadDialogTitle('not a url')).toBe('Save file');
  });
});

describe('configurePartition', () => {
  function fakeSession() {
    const listeners = new Map<string, (...args: never[]) => void>();
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) =>
        listeners.set(event, listener),
      ),
    };
    return { session, listeners };
  }

  it('refuses display capture with null, since an empty answer throws in main', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-display', session as unknown as Session);
    const handler = session.setDisplayMediaRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    handler({}, callback);
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('installs no certificate verify proc: certificates are decided per page', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-certs', session as unknown as Session);
    expect(session.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it('leaves every download to Electron’s save dialog: no path is ever set for it', () => {
    const { session, listeners } = fakeSession();
    configurePartition('persist:test-downloads', session as unknown as Session);
    const item = {
      getURL: () => 'https://files.example.com/a.zip',
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    };
    (listeners.get('will-download') as unknown as (e: unknown, i: unknown) => void)({}, item);
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: 'Save a file from files.example.com',
    });
  });

  describe('with a gate on downloads', () => {
    afterEach(() => gateDownloads(null));

    function download(listeners: Map<string, (...args: never[]) => void>, from: unknown) {
      const item = {
        getURL: () => 'https://files.example.com/a.zip',
        setSaveDialogOptions: vi.fn(),
        setSavePath: vi.fn(),
        cancel: vi.fn(),
      };
      const event = { preventDefault: vi.fn() };
      (listeners.get('will-download') as unknown as (e: unknown, i: unknown, w: unknown) => void)(
        event,
        item,
        from,
      );
      return { item, event };
    }

    it('cancels what the gate cancels, before any save dialog is asked for', () => {
      const { session, listeners } = fakeSession();
      configurePartition('persist:test-gate', session as unknown as Session);
      const page = { id: 7 } as unknown as WebContents;
      const seen: unknown[] = [];
      gateDownloads((from) => {
        seen.push(from);
        return 'cancel';
      });
      const { item, event } = download(listeners, page);
      expect(seen).toEqual([page]);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
    });

    it('lets the rest through to the save dialog', () => {
      const { session, listeners } = fakeSession();
      configurePartition('persist:test-gate-allow', session as unknown as Session);
      gateDownloads(() => 'allow');
      const { item, event } = download(listeners, undefined);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(item.setSaveDialogOptions).toHaveBeenCalled();
    });
  });

  it('configures a partition once', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-once', session as unknown as Session);
    configurePartition('persist:test-once', session as unknown as Session);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });
});

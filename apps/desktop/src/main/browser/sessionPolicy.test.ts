import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserTab, browserPartitionFor } from '../../shared/browser';
import {
  configurePartition,
  decideDownload,
  decidePermission,
  downloadDialogTitle,
  type DownloadPageFacts,
  type DownloadPlaces,
  downloadRefusal,
  type DownloadSource,
  downloadSource,
  gateDownloads,
  partitionFor,
} from './sessionPolicy';

/** A page that has put up no save dialog yet. */
const FIRST: DownloadPageFacts = { dialogWaiting: false, downloadedBefore: false };
/** One whose earlier download is past its dialog. */
const LATER: DownloadPageFacts = { dialogWaiting: false, downloadedBefore: true };
/** One whose earlier download still waits at its dialog. */
const WAITING: DownloadPageFacts = { dialogWaiting: true, downloadedBefore: true };

const fromTabs = (hands: Array<'agent' | 'person'>, personUsing = false): DownloadSource => ({
  kind: 'tabs',
  hands,
  personUsing,
});

describe('decideDownload', () => {
  it("cancels a download from a page of a tab in the agent's hands, at any time", () => {
    expect(decideDownload(fromTabs(['agent']), FIRST)).toBe('cancel');
    // Whatever else is true: the agent's hands come first.
    expect(decideDownload(fromTabs(['agent'], true), FIRST)).toBe('cancel');
  });

  it("allows a page's first download from a tab in the person's hands", () => {
    expect(decideDownload(fromTabs(['person']), FIRST)).toBe('allow');
    expect(decideDownload(fromTabs(['person'], true), FIRST)).toBe('allow');
  });

  it("cancels for a page not bound yet when any tab it may be is in the agent's hands", () => {
    expect(decideDownload(fromTabs(['person', 'agent']), FIRST)).toBe('cancel');
    expect(decideDownload(fromTabs(['person', 'person']), FIRST)).toBe('allow');
  });

  // At most one save dialog waits per page: a page cannot stack them on the person's screen.
  it('cancels a download while the same page has a save dialog waiting, even on the person’s input', () => {
    expect(decideDownload(fromTabs(['person'], true), WAITING)).toBe('cancel');
  });

  it('cancels a later download unless the person used the tab just now', () => {
    expect(decideDownload(fromTabs(['person']), LATER)).toBe('cancel');
    expect(decideDownload(fromTabs(['person'], true), LATER)).toBe('allow');
  });

  // Consola starts no download in a browser partition itself, so one with no page hid where it came from.
  it('cancels one from a page main cannot place, and one with no page at all', () => {
    expect(decideDownload({ kind: 'unknown' }, FIRST)).toBe('cancel');
    expect(decideDownload(fromTabs([]), FIRST)).toBe('cancel');
    expect(decideDownload({ kind: 'none' }, FIRST)).toBe('cancel');
  });

  it('says why it cancels, and nothing when it allows', () => {
    expect(downloadRefusal(fromTabs(['person']), FIRST)).toBeNull();
    for (const [source, page] of [
      [fromTabs(['agent']), FIRST],
      [fromTabs(['person'], true), WAITING],
      [fromTabs(['person']), LATER],
      [{ kind: 'unknown' }, FIRST],
      [{ kind: 'none' }, FIRST],
    ] as Array<[DownloadSource, DownloadPageFacts]>) {
      expect(downloadRefusal(source, page)).toMatch(/^Cancelled a/);
    }
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
  /**
   * Tab 1's page is bound; popup window 20 was opened by tab 2's; page 30 is
   * not bound yet, and page 40 not bound either, with two tabs it may be. The
   * person used tabs 1 and 4 just now.
   */
  const places: DownloadPlaces = {
    tabsForPage: (contents) =>
      contents.id === 1
        ? [tab('t1')]
        : contents.id === 30
          ? [tab('t3')]
          : contents.id === 40
            ? [tab('t1'), tab('t4')]
            : [],
    popupOpener: (contents) => (contents.id === 20 ? tab('t2', 'agent') : undefined),
    handsOf: (of) => (of.id === 't1' || of.id === 't4' ? 'person' : 'agent'),
    personUsing: (of) => of.id === 't1' || of.id === 't4',
  };

  it('places a tab’s page by its tab, and a page not bound yet by each tab it may be', () => {
    expect(downloadSource(page(1), places)).toEqual(fromTabs(['person'], true));
    expect(downloadSource(page(30), places)).toEqual(fromTabs(['agent']));
    expect(downloadSource(page(40), places)).toEqual(fromTabs(['person', 'person'], true));
  });

  it('counts the person as using a page not bound yet only when they used every tab it may be', () => {
    const one: DownloadPlaces = { ...places, personUsing: (of) => of.id === 't1' };
    expect(downloadSource(page(40), one)).toEqual(fromTabs(['person', 'person'], false));
  });

  it('places a popup window by the tab whose page opened it', () => {
    expect(downloadSource(page(20), places)).toEqual(fromTabs(['agent']));
    const personsOpener: DownloadPlaces = { ...places, handsOf: () => 'person' };
    expect(decideDownload(downloadSource(page(20), personsOpener), FIRST)).toBe('allow');
    expect(decideDownload(downloadSource(page(20), places), FIRST)).toBe('cancel');
  });

  it('fails closed for a page in a browser partition that is no tab’s or popup’s, or is gone', () => {
    expect(downloadSource(page(99), places)).toEqual({ kind: 'unknown' });
    expect(downloadSource(page(1, true), places)).toEqual({ kind: 'unknown' });
    expect(decideDownload(downloadSource(page(99), places), FIRST)).toBe('cancel');
  });

  it('cancels a download with no page: none comes from Consola in a browser partition', () => {
    expect(downloadSource(undefined, places)).toEqual({ kind: 'none' });
    expect(decideDownload(downloadSource(undefined, places), FIRST)).toBe('cancel');
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
      setDevicePermissionHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) =>
        listeners.set(event, listener),
      ),
    };
    return { session, listeners };
  }

  // Each chooser for the person's devices: the default prevented, and nothing chosen.
  it.each<[string, unknown[], unknown[]]>([
    ['select-hid-device', [{ deviceList: [{ deviceId: 'pad' }] }], []],
    ['select-serial-port', [[{ portId: 'port' }], {}], ['']],
    ['select-usb-device', [{ deviceList: [{ deviceId: 'key' }] }], []],
  ])('chooses nothing for %s', (event, args, answered) => {
    const { session, listeners } = fakeSession();
    configurePartition(`persist:test-${event}`, session as unknown as Session);
    const preventDefault = vi.fn();
    const callback = vi.fn();
    (listeners.get(event) as unknown as (...given: unknown[]) => void)(
      { preventDefault },
      ...args,
      callback,
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(...answered);
  });

  it('grants no device without a chooser, and pairs none', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-devices', session as unknown as Session);
    const permits = session.setDevicePermissionHandler.mock.calls[0][0];
    expect(permits({ deviceType: 'hid', origin: 'https://example.com' })).toBe(false);
    const pair = session.setBluetoothPairingHandler.mock.calls[0][0];
    const callback = vi.fn();
    pair({ deviceId: 'phone', pairingKind: 'confirm' }, callback);
    expect(callback).toHaveBeenCalledWith({ confirmed: false });
  });

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
      gateDownloads((from, item) => {
        seen.push(from, item);
        return 'cancel';
      });
      const { item, event } = download(listeners, page);
      expect(seen).toEqual([page, item]);
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

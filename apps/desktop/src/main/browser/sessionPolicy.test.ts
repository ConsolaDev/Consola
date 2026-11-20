import { EventEmitter } from 'node:events';
import type { DownloadItem, Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserTab, browserPartitionFor } from '../../shared/browser';
import {
  configurePartition,
  decideDownload,
  decidePermission,
  downloadDialogTitle,
  type DownloadPlaces,
  downloadRefusal,
  type DownloadSource,
  downloadSource,
  gateDownloads,
  partitionFor,
  type SessionDownloadFacts,
} from './sessionPolicy';
import { UninvitedDownloads } from './downloadGate';

/** A session that has shown no uninvited save dialog since the person's last input in it. */
const QUIET: SessionDownloadFacts = { uninvitedWaiting: false, uninvitedSincePersonInput: false };
/** One that has shown one since, now past its dialog. */
const SPENT: SessionDownloadFacts = { uninvitedWaiting: false, uninvitedSincePersonInput: true };
/** One whose uninvited dialog still waits; the person has given input in it since. */
const WAITING: SessionDownloadFacts = { uninvitedWaiting: true, uninvitedSincePersonInput: false };

const fromTabs = (
  hands: Array<'agent' | 'person'>,
  personUsing = false,
  sessionIds: string[] = ['s1'],
): DownloadSource => ({ kind: 'tabs', hands, personUsing, sessionIds });

describe('decideDownload', () => {
  it("cancels a download from a page of a tab in the agent's hands, at any time", () => {
    expect(decideDownload(fromTabs(['agent']), QUIET)).toBe('cancel');
    // Whatever else is true: the agent's hands come first.
    expect(decideDownload(fromTabs(['agent'], true), QUIET)).toBe('cancel');
  });

  it("cancels for a page not bound yet when any tab it may be is in the agent's hands", () => {
    expect(decideDownload(fromTabs(['person', 'agent']), QUIET)).toBe('cancel');
    expect(decideDownload(fromTabs(['person', 'person']), QUIET)).toBe('allow');
  });

  it('allows one right after the person’s input on its tab, whatever the session has shown', () => {
    expect(decideDownload(fromTabs(['person'], true), QUIET)).toBe('allow');
    expect(decideDownload(fromTabs(['person'], true), SPENT)).toBe('allow');
    expect(decideDownload(fromTabs(['person'], true), WAITING)).toBe('allow');
  });

  // A download nobody asked for: the session's browser gets one at a time, and one
  // per stretch without the person's input, however many tabs its pages open.
  it('allows a session one uninvited download while it is quiet', () => {
    expect(decideDownload(fromTabs(['person']), QUIET)).toBe('allow');
  });

  it('cancels an uninvited one while another’s dialog waits in the session', () => {
    expect(decideDownload(fromTabs(['person']), WAITING)).toBe('cancel');
  });

  it('cancels an uninvited one once one was shown since the person’s last input in the session', () => {
    expect(decideDownload(fromTabs(['person']), SPENT)).toBe('cancel');
  });

  // Consola starts no download in a browser partition itself, so one with no page hid where it came from.
  it('cancels one from a page main cannot place, and one with no page at all', () => {
    expect(decideDownload({ kind: 'unknown' }, QUIET)).toBe('cancel');
    expect(decideDownload(fromTabs([]), QUIET)).toBe('cancel');
    expect(decideDownload({ kind: 'none' }, QUIET)).toBe('cancel');
  });

  it('says why it cancels, and nothing when it allows', () => {
    expect(downloadRefusal(fromTabs(['person']), QUIET)).toBeNull();
    for (const [source, session] of [
      [fromTabs(['agent']), QUIET],
      [fromTabs(['person']), WAITING],
      [fromTabs(['person']), SPENT],
      [{ kind: 'unknown' }, QUIET],
      [{ kind: 'none' }, QUIET],
    ] as Array<[DownloadSource, SessionDownloadFacts]>) {
      expect(downloadRefusal(source, session)).toMatch(/^Cancelled a/);
    }
  });
});

describe('UninvitedDownloads', () => {
  /** A download item: at its save dialog until a path is chosen, or it is done. */
  class FakeItem extends EventEmitter {
    savePath = '';
    getSavePath() {
      return this.savePath;
    }
    saved() {
      this.savePath = '/Users/me/Downloads/report.csv';
      this.emit('updated', {}, 'progressing');
    }
    asItem() {
      return this as unknown as DownloadItem;
    }
  }

  /** What the decision says now of an uninvited download from a tab of `sessionIds`. */
  const uninvited = (downloads: UninvitedDownloads, sessionIds = ['s1']) =>
    decideDownload(fromTabs(['person'], false, sessionIds), downloads.factsFor(sessionIds));
  /** And of one right after the person's input on its own tab. */
  const invited = (downloads: UninvitedDownloads, sessionIds = ['s1']) =>
    decideDownload(fromTabs(['person'], true, sessionIds), downloads.factsFor(sessionIds));

  it('allows a page’s first uninvited download, and cancels a second from the same page', () => {
    const downloads = new UninvitedDownloads();
    expect(uninvited(downloads)).toBe('allow');
    const first = new FakeItem();
    downloads.shown(['s1'], first.asItem());
    expect(uninvited(downloads)).toBe('cancel');
    // Still none once its dialog is past: the person has given no input since.
    first.saved();
    expect(uninvited(downloads)).toBe('cancel');
  });

  it('cancels a second from another tab of the same session, as a page’s own new tab would be', () => {
    const downloads = new UninvitedDownloads();
    downloads.shown(['s1'], new FakeItem().asItem());
    // Any other page of the session, the tab the first page opened by script included.
    expect(uninvited(downloads, ['s1'])).toBe('cancel');
  });

  it('gives the session one more after the person’s input in any of its tabs', () => {
    const downloads = new UninvitedDownloads();
    const first = new FakeItem();
    downloads.shown(['s1'], first.asItem());
    first.emit('done', {}, 'cancelled');
    downloads.personInput('s1');
    expect(uninvited(downloads)).toBe('allow');
    downloads.shown(['s1'], new FakeItem().asItem());
    expect(uninvited(downloads)).toBe('cancel');
  });

  it('keeps one waiting dialog at a time, even past the person’s input', () => {
    const downloads = new UninvitedDownloads();
    downloads.shown(['s1'], new FakeItem().asItem());
    downloads.personInput('s1');
    expect(uninvited(downloads)).toBe('cancel');
  });

  it('allows one right after the person’s press on its own tab while an uninvited dialog waits', () => {
    const downloads = new UninvitedDownloads();
    downloads.shown(['s1'], new FakeItem().asItem());
    expect(invited(downloads)).toBe('allow');
  });

  it('leaves another session unaffected', () => {
    const downloads = new UninvitedDownloads();
    downloads.shown(['s1'], new FakeItem().asItem());
    expect(uninvited(downloads, ['s2'])).toBe('allow');
    // A page that may be either session's is judged by both.
    expect(uninvited(downloads, ['s2', 's1'])).toBe('cancel');
  });

  it('forgets a session once it is gone', () => {
    const downloads = new UninvitedDownloads();
    downloads.shown(['s1'], new FakeItem().asItem());
    downloads.prune(new Set(['s2']));
    expect(uninvited(downloads)).toBe('allow');
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
   * person used tabs 1 and 4 just now. Tab 4 is session s2's, the rest s1's;
   * page 50's tab has no session left.
   */
  const places: DownloadPlaces = {
    tabsForPage: (contents) =>
      contents.id === 1
        ? [tab('t1')]
        : contents.id === 30
          ? [tab('t3')]
          : contents.id === 40
            ? [tab('t1'), tab('t4')]
            : contents.id === 50
              ? [tab('t5')]
              : [],
    popupOpener: (contents) => (contents.id === 20 ? tab('t2', 'agent') : undefined),
    handsOf: (of) => (of.id === 't1' || of.id === 't4' ? 'person' : 'agent'),
    personUsing: (of) => of.id === 't1' || of.id === 't4',
    sessionOf: (of) => (of.id === 't4' ? 's2' : of.id === 't5' ? undefined : 's1'),
  };

  it('places a tab’s page by its tab and session, and a page not bound yet by each tab it may be', () => {
    expect(downloadSource(page(1), places)).toEqual(fromTabs(['person'], true));
    expect(downloadSource(page(30), places)).toEqual(fromTabs(['agent']));
    expect(downloadSource(page(40), places)).toEqual(
      fromTabs(['person', 'person'], true, ['s1', 's2']),
    );
  });

  it('counts the person as using a page not bound yet only when they used every tab it may be', () => {
    const one: DownloadPlaces = { ...places, personUsing: (of) => of.id === 't1' };
    expect(downloadSource(page(40), one)).toEqual(
      fromTabs(['person', 'person'], false, ['s1', 's2']),
    );
  });

  it('places a popup window by the tab whose page opened it, and so by its session', () => {
    expect(downloadSource(page(20), places)).toEqual(fromTabs(['agent']));
    const personsOpener: DownloadPlaces = { ...places, handsOf: () => 'person' };
    expect(decideDownload(downloadSource(page(20), personsOpener), QUIET)).toBe('allow');
    expect(decideDownload(downloadSource(page(20), places), QUIET)).toBe('cancel');
  });

  it('fails closed for a page in a browser partition that is no tab’s or popup’s, or is gone', () => {
    expect(downloadSource(page(99), places)).toEqual({ kind: 'unknown' });
    expect(downloadSource(page(1, true), places)).toEqual({ kind: 'unknown' });
    expect(downloadSource(page(50), places)).toEqual({ kind: 'unknown' });
    expect(decideDownload(downloadSource(page(99), places), QUIET)).toBe('cancel');
  });

  it('cancels a download with no page: none comes from Consola in a browser partition', () => {
    expect(downloadSource(undefined, places)).toEqual({ kind: 'none' });
    expect(decideDownload(downloadSource(undefined, places), QUIET)).toBe('cancel');
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

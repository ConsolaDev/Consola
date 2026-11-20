import { EventEmitter } from 'node:events';
import type { DownloadItem, Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserTab, browserPartitionFor } from '../../shared/browser';
import {
  clearBrowsingData,
  configurePartition,
  decideDownload,
  decidePermission,
  downloadDialogTitle,
  type DownloadFacts,
  type DownloadPlaces,
  downloadRefusal,
  type DownloadSource,
  downloadSource,
  gateDownloads,
  isInvited,
  partitionFor,
  QUIET_SESSION,
} from './sessionPolicy';
import { SessionDownloads } from './downloadGate';
import { PERSON_INPUT_GUARD_MS } from './PersonInput';

const T0 = 1_700_000_000_000;

/** A session with nothing waiting and nothing spent. */
const QUIET = QUIET_SESSION;
/** One with a save dialog waiting, invited or not. */
const WAITING: DownloadFacts = { ...QUIET_SESSION, dialogWaiting: true };
/** One whose tab's latest input already paid for a download. */
const SPENT_INPUT: DownloadFacts = { ...QUIET_SESSION, inputSpent: true };
/** One that has shown an uninvited download since the person's last input in it. */
const SPENT_UNINVITED: DownloadFacts = { ...QUIET_SESSION, uninvitedSincePersonInput: true };

/** A download from tab t1 of session s1, the person's input on it at `inputAt` if any. */
const fromTabs = (
  hands: Array<'agent' | 'person'>,
  inputAt?: number,
  sessionIds: string[] = ['s1'],
): DownloadSource => ({
  kind: 'tabs',
  tabIds: hands.map((_hand, index) => `t${index + 1}`),
  hands,
  personInputAt: hands.map(() => inputAt),
  sessionIds,
});

describe('decideDownload', () => {
  it("cancels a download from a page of a tab in the agent's hands, at any time", () => {
    expect(decideDownload(fromTabs(['agent']), QUIET)).toBe('cancel');
    // Whatever else is true: the agent's hands come first.
    expect(decideDownload(fromTabs(['agent'], T0), QUIET)).toBe('cancel');
  });

  it("cancels for a page not bound yet when any tab it may be is in the agent's hands", () => {
    expect(decideDownload(fromTabs(['person', 'agent']), QUIET)).toBe('cancel');
    expect(decideDownload(fromTabs(['person', 'person']), QUIET)).toBe('allow');
  });

  // One save dialog at a time in a session: a waiting one holds the window anyway.
  it('cancels any download while a save dialog waits in the session, even on the person’s input', () => {
    expect(decideDownload(fromTabs(['person'], T0), WAITING)).toBe('cancel');
    expect(decideDownload(fromTabs(['person']), WAITING)).toBe('cancel');
  });

  it('allows one on the person’s input on its tab, which pays for one download only', () => {
    expect(decideDownload(fromTabs(['person'], T0), QUIET)).toBe('allow');
    expect(decideDownload(fromTabs(['person'], T0), SPENT_UNINVITED)).toBe('allow');
    // Spent: it is uninvited now, and the session's one uninvited download decides.
    expect(decideDownload(fromTabs(['person'], T0), SPENT_INPUT)).toBe('allow');
    expect(
      decideDownload(fromTabs(['person'], T0), { ...SPENT_INPUT, uninvitedSincePersonInput: true }),
    ).toBe('cancel');
  });

  // A download nobody asked for: the session's browser gets one per stretch
  // without the person's input, however many tabs its pages open.
  it('allows a session one uninvited download, and cancels another until the person’s next input', () => {
    expect(decideDownload(fromTabs(['person']), QUIET)).toBe('allow');
    expect(decideDownload(fromTabs(['person']), SPENT_UNINVITED)).toBe('cancel');
  });

  // Consola starts no download in a browser partition itself, so one with no page hid where it came from.
  it('cancels one from a page main cannot place, and one with no page at all', () => {
    expect(decideDownload({ kind: 'unknown' }, QUIET)).toBe('cancel');
    expect(decideDownload(fromTabs([]), QUIET)).toBe('cancel');
    expect(decideDownload({ kind: 'none' }, QUIET)).toBe('cancel');
  });

  it('says why it cancels, and nothing when it allows', () => {
    expect(downloadRefusal(fromTabs(['person']), QUIET)).toBeNull();
    for (const [source, facts] of [
      [fromTabs(['agent']), QUIET],
      [fromTabs(['person'], T0), WAITING],
      [fromTabs(['person']), SPENT_UNINVITED],
      [{ kind: 'unknown' }, QUIET],
      [{ kind: 'none' }, QUIET],
    ] as Array<[DownloadSource, DownloadFacts]>) {
      expect(downloadRefusal(source, facts)).toMatch(/^Cancelled a/);
    }
  });
});

describe('SessionDownloads', () => {
  /** A download item: at its save dialog until a path is chosen, or it is done. */
  class FakeItem extends EventEmitter {
    savePath = '';
    getSavePath() {
      return this.savePath;
    }
    /** The person answered the dialog with a place to save it. */
    saved() {
      this.savePath = '/Users/me/Downloads/report.csv';
      this.emit('updated', {}, 'progressing');
    }
    asItem() {
      return this as unknown as DownloadItem;
    }
  }

  /** Session s1 has tabs t1 and t2, session s2 has t3. Each tab's page is a page of its own. */
  function world() {
    let now = T0;
    const downloads = new SessionDownloads(() => now);
    const inputs = new Map<string, number>();
    const pages = new Map<string, EventEmitter>();
    const sessionOf = (tabId: string) => (tabId === 't3' ? 's2' : 's1');
    const pageOf = (tabId: string) => {
      const page = pages.get(tabId) ?? new EventEmitter();
      pages.set(tabId, page);
      return page;
    };
    /** A download from `tabId`'s page, decided and, if allowed, recorded. */
    const download = (tabId: string) => {
      const at = inputs.get(tabId);
      const source = {
        kind: 'tabs' as const,
        tabIds: [tabId],
        hands: ['person' as const],
        personInputAt: [at !== undefined && now - at < PERSON_INPUT_GUARD_MS ? at : undefined],
        sessionIds: [sessionOf(tabId)],
      };
      const facts = downloads.factsFor(source);
      const decision = decideDownload(source, facts);
      const item = new FakeItem();
      if (decision === 'allow') {
        downloads.allowed(
          source,
          isInvited(source, facts),
          pageOf(tabId) as unknown as WebContents,
          item.asItem(),
        );
      }
      return { decision, item };
    };
    /** The person presses in `tabId`. */
    const press = (tabId: string) => {
      inputs.set(tabId, now);
      downloads.personInput(sessionOf(tabId));
    };
    const wait = (ms: number) => {
      now += ms;
    };
    return { downloads, download, press, wait, pageOf };
  }

  it('lets one of a burst after the person’s press through, and cancels the rest while it waits', () => {
    const { download, press } = world();
    press('t1');
    const first = download('t1');
    expect(first.decision).toBe('allow');
    expect(download('t1').decision).toBe('cancel');
    expect(download('t1').decision).toBe('cancel');
  });

  it('takes a second download on the same old input as the session’s one uninvited download', () => {
    const { download, press, wait } = world();
    press('t1');
    download('t1').item.saved();
    wait(1_000);
    // Still within the guard, but the input is spent.
    const second = download('t1');
    expect(second.decision).toBe('allow');
    second.item.emit('done', {}, 'completed');
    expect(download('t1').decision).toBe('cancel');
    // A new press: one more.
    press('t1');
    expect(download('t1').decision).toBe('allow');
  });

  it('allows a page’s first uninvited download, and cancels a second from another tab of the session', () => {
    const { download } = world();
    download('t1').item.saved();
    // The tab t1's page opened by script is a page of its own: still the session's one.
    expect(download('t2').decision).toBe('cancel');
    expect(download('t1').decision).toBe('cancel');
  });

  it('gives the session one more uninvited download after the person’s input in any of its tabs', () => {
    const { download, press, wait } = world();
    download('t1').item.saved();
    press('t2');
    wait(PERSON_INPUT_GUARD_MS);
    expect(download('t1').decision).toBe('allow');
  });

  it('keeps a waiting dialog of another tab of the session blocking, even on the person’s press', () => {
    const { download, press } = world();
    download('t1');
    press('t2');
    expect(download('t2').decision).toBe('cancel');
  });

  it('leaves another session unaffected', () => {
    const { download } = world();
    download('t1');
    expect(download('t3').decision).toBe('allow');
  });

  it('is not left blocked by a tab that closes while its dialog waits', () => {
    const { download, press, pageOf } = world();
    download('t1');
    // Its page goes with the tab, and its download with no word of its own.
    pageOf('t1').emit('destroyed');
    press('t2');
    expect(download('t2').decision).toBe('allow');
  });

  it('forgets a session once it is gone', () => {
    const { downloads, download } = world();
    download('t1');
    downloads.prune(new Set(['s2']));
    expect(download('t2').decision).toBe('allow');
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
   * person used tab 1 at T0, tab 4 at T0 + 1. Tab 4 is session s2's, the rest
   * s1's; page 50's tab has no session left.
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
    personInputAt: (of) => (of.id === 't1' ? T0 : of.id === 't4' ? T0 + 1 : undefined),
    sessionOf: (of) => (of.id === 't4' ? 's2' : of.id === 't5' ? undefined : 's1'),
  };

  it('places a tab’s page by its tab and session, and a page not bound yet by each tab it may be', () => {
    expect(downloadSource(page(1), places)).toEqual({
      kind: 'tabs',
      tabIds: ['t1'],
      hands: ['person'],
      personInputAt: [T0],
      sessionIds: ['s1'],
    });
    expect(downloadSource(page(40), places)).toEqual({
      kind: 'tabs',
      tabIds: ['t1', 't4'],
      hands: ['person', 'person'],
      personInputAt: [T0, T0 + 1],
      sessionIds: ['s1', 's2'],
    });
  });

  it('counts a page not bound yet as the person’s only when they used every tab it may be', () => {
    const one: DownloadPlaces = {
      ...places,
      personInputAt: (of) => (of.id === 't1' ? T0 : undefined),
    };
    const source = downloadSource(page(40), one);
    if (source.kind !== 'tabs') throw new Error('expected tabs');
    expect(isInvited(source, QUIET)).toBe(false);
    expect(isInvited(downloadSource(page(1), places) as typeof source, QUIET)).toBe(true);
  });

  it('places a popup window by the tab whose page opened it, and so by its session', () => {
    expect(downloadSource(page(20), places)).toMatchObject({ tabIds: ['t2'], hands: ['agent'] });
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

describe('clearBrowsingData', () => {
  it('empties storage, caches (the code cache too), sign-ins and open connections', async () => {
    const done: string[] = [];
    const step = (name: string) => vi.fn(async () => void done.push(name));
    const target = {
      clearStorageData: step('storage'),
      clearCache: step('cache'),
      clearCodeCaches: step('code caches'),
      closeAllConnections: step('connections'),
      clearAuthCache: step('sign-ins'),
    };
    await clearBrowsingData(target);
    expect(done.sort()).toEqual(['cache', 'code caches', 'connections', 'sign-ins', 'storage']);
    expect(target.clearCodeCaches).toHaveBeenCalledWith({});
  });

  it('fails when a step fails, so the person is told', async () => {
    const target = {
      clearStorageData: vi.fn(async () => {
        throw new Error('disk');
      }),
      clearCache: vi.fn(async () => {}),
      clearCodeCaches: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
    };
    await expect(clearBrowsingData(target)).rejects.toThrow('disk');
  });
});

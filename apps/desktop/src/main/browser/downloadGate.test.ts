import { EventEmitter } from 'node:events';
import type { DownloadItem, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../../shared/browser';
import { createDownloadGate, SessionDownloads } from './downloadGate';
import type { DownloadPlaces } from './sessionPolicy';

const T0 = 1_700_000_000_000;

/** A tab's page: page n is tab tn's. */
class FakePage extends EventEmitter {
  constructor(public readonly id: number) {
    super();
  }
  isDestroyed() {
    return false;
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

/** A download: at its save dialog until a path is chosen, or it is done. */
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

const tab = (id: string): BrowserTab => ({
  id,
  url: 'https://files.example.com/',
  title: '',
  openedBy: 'person',
});

/**
 * Session s1's tabs: t1, which the person opened, and t2, which t1's page
 * opened by script with no input. Session s2 has t3.
 */
function setup() {
  const inputs = new Map<string, number>();
  const places: DownloadPlaces = {
    tabsForPage: (contents) => [tab(`t${contents.id}`)],
    popupOpener: () => undefined,
    handsOf: () => 'person',
    personInputAt: (of) => inputs.get(of.id),
    sessionOf: (of) => (of.id === 't3' ? 's2' : 's1'),
  };
  const log = vi.fn();
  const downloads = new SessionDownloads(() => T0);
  const gate = createDownloadGate(places, downloads, log);
  const pages = new Map<number, FakePage>();
  const download = (pageId: number) => {
    const page = pages.get(pageId) ?? new FakePage(pageId);
    pages.set(pageId, page);
    const item = new FakeItem();
    return { item, decision: gate(page.asWebContents(), item.asItem()) };
  };
  /** The person presses in tab `tabId`: their input on it, and in its session. */
  const press = (tabId: string) => {
    inputs.set(tabId, T0);
    downloads.personInput(places.sessionOf(tab(tabId)) as string);
  };
  return { download, press, log };
}

describe('the download gate', () => {
  it('gives a session one uninvited download, which a tab its page opened cannot get round', () => {
    const { download, log } = setup();
    const first = download(1);
    expect(first.decision).toBe('allow');
    // The page's own new tab, a page of its own: still the session's one.
    expect(download(2).decision).toBe('cancel');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('save dialog is open'));
    first.item.saved();
    expect(download(2).decision).toBe('cancel');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('since the person last used'));
    // Another session's browser has its own.
    expect(download(3).decision).toBe('allow');
  });

  it('lets one of a burst after the person’s press through, and spends the press on it', () => {
    const { download, press } = setup();
    press('t1');
    const theirs = download(1);
    expect(theirs.decision).toBe('allow');
    expect(download(1).decision).toBe('cancel');
    expect(download(1).decision).toBe('cancel');
    theirs.item.saved();
    // The press is spent: the next is the session's one uninvited download.
    expect(download(1).decision).toBe('allow');
  });

  it('cancels a download that names no page, and logs why', () => {
    const { log } = setup();
    const gate = createDownloadGate(
      {
        tabsForPage: () => [],
        popupOpener: () => undefined,
        handsOf: () => 'person',
        personInputAt: () => undefined,
        sessionOf: () => 's1',
      },
      new SessionDownloads(),
      log,
    );
    expect(gate(undefined, new FakeItem().asItem())).toBe('cancel');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('named no page'));
  });
});

import { EventEmitter } from 'node:events';
import type { DownloadItem, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../../shared/browser';
import { createDownloadGate, UninvitedDownloads } from './downloadGate';
import type { DownloadPlaces } from './sessionPolicy';

/** A tab's page. */
class FakePage {
  constructor(public readonly id: number) {}
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
  /** The person chose where it goes; it carries on. */
  saved() {
    this.savePath = '/Users/me/Downloads/report.csv';
    this.emit('updated', {}, 'progressing');
  }
  /** It ended: finished, cancelled at its dialog, or interrupted. */
  done(state = 'cancelled') {
    this.emit('done', {}, state);
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
 * Session s1's tabs: t1 the person opened, and t2, which t1's page opened by
 * script with no input. Session s2 has t3. Page n is tab tn's.
 */
function setup() {
  const inUse = new Set<string>();
  const places: DownloadPlaces = {
    tabsForPage: (contents) => [tab(`t${contents.id}`)],
    popupOpener: () => undefined,
    handsOf: () => 'person',
    personUsing: (of) => inUse.has(of.id),
    sessionOf: (of) => (of.id === 't3' ? 's2' : 's1'),
  };
  const log = vi.fn();
  const uninvited = new UninvitedDownloads();
  const gate = createDownloadGate(places, uninvited, log);
  const download = (pageId: number) => {
    const item = new FakeItem();
    return { item, decision: gate(new FakePage(pageId).asWebContents(), item.asItem()) };
  };
  /** The person presses in tab `tabId`: their input on it, and in its session. */
  const press = (tabId: string) => {
    inUse.add(tabId);
    uninvited.personInput(places.sessionOf(tab(tabId)) as string);
  };
  /** The person-input guard has passed. */
  const later = () => inUse.clear();
  return { download, press, later, log };
}

describe('the download gate', () => {
  it('gives a session one uninvited download, which a tab its page opened cannot get round', () => {
    const { download, log } = setup();
    const first = download(1);
    expect(first.decision).toBe('allow');
    // The page's own new tab, a page of its own: still the session's one.
    expect(download(2).decision).toBe('cancel');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('save dialog is open'));
    first.item.saved();
    expect(download(2).decision).toBe('cancel');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('since the person last used'));
    // Another session's browser has its own.
    expect(download(3).decision).toBe('allow');
  });

  it('lets the person’s own click through, and gives back one uninvited download for their next input', () => {
    const { download, press, later } = setup();
    const first = download(1);
    // Their press on the tab: their click, even with the uninvited dialog waiting.
    press('t2');
    const theirs = download(2);
    expect(theirs.decision).toBe('allow');
    later();
    first.item.done();
    theirs.item.done('completed');
    // Their input in the session gave it one more uninvited download, and only one.
    expect(download(2).decision).toBe('allow');
    expect(download(1).decision).toBe('cancel');
  });

  it('cancels a download that names no page, and logs why', () => {
    const { log } = setup();
    const gate = createDownloadGate(
      {
        tabsForPage: () => [],
        popupOpener: () => undefined,
        handsOf: () => 'person',
        personUsing: () => false,
        sessionOf: () => 's1',
      },
      new UninvitedDownloads(),
      log,
    );
    expect(gate(undefined, new FakeItem().asItem())).toBe('cancel');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('named no page'));
  });
});

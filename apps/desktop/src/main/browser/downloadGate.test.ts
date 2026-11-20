import { EventEmitter } from 'node:events';
import type { DownloadItem, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../../shared/browser';
import { createDownloadGate } from './downloadGate';
import type { DownloadPlaces } from './sessionPolicy';

/** A page; Electron reads its id once, as each download starts. */
class FakePage extends EventEmitter {
  destroyed = false;
  constructor(public readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

/** A download: at its save dialog until a path is chosen, or it is done. */
class FakeItem extends EventEmitter {
  savePath = '';
  state = 'progressing';
  getSavePath() {
    return this.savePath;
  }
  getState() {
    return this.state;
  }
  /** The person chose where it goes; it carries on. */
  saved() {
    this.savePath = '/Users/me/Downloads/report.csv';
    this.emit('updated', {}, 'progressing');
  }
  /** It ended: finished, cancelled at its dialog, or interrupted. */
  done(state = 'cancelled') {
    this.state = state;
    this.emit('done', {}, state);
  }
  asItem() {
    return this as unknown as DownloadItem;
  }
}

const tab: BrowserTab = {
  id: 't1',
  url: 'https://files.example.com/',
  title: '',
  openedBy: 'person',
};

function setup() {
  let personUsing = false;
  const places: DownloadPlaces = {
    tabsForPage: () => [tab],
    popupOpener: () => undefined,
    handsOf: () => 'person',
    personUsing: () => personUsing,
  };
  const log = vi.fn();
  const gate = createDownloadGate(places, log);
  const page = new FakePage(7);
  const download = () => {
    const item = new FakeItem();
    return { item, decision: gate(page.asWebContents(), item.asItem()) };
  };
  return { gate, page, download, log, usedNow: () => (personUsing = true) };
}

describe('the download gate', () => {
  it("lets a page's first download through, with nobody's input", () => {
    const { download, log } = setup();
    expect(download().decision).toBe('allow');
    expect(log).not.toHaveBeenCalled();
  });

  it('cancels another from the same page while its save dialog waits, saying why', () => {
    const { download, usedNow, log } = setup();
    usedNow();
    expect(download().decision).toBe('allow');
    expect(download().decision).toBe('cancel');
    expect(download().decision).toBe('cancel');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('save dialog is still open'));
  });

  it('lets the next through once the dialog is past, only on the person’s input', () => {
    const { download, usedNow } = setup();
    const first = download();
    first.item.saved();
    expect(download().decision).toBe('cancel');
    usedNow();
    expect(download().decision).toBe('allow');
  });

  it('counts a download cancelled at its dialog, or by anyone, as past it', () => {
    const { download, usedNow } = setup();
    usedNow();
    download().item.done('cancelled');
    const second = download();
    expect(second.decision).toBe('allow');
    second.item.done('interrupted');
    expect(download().decision).toBe('allow');
  });

  it('judges each page by its own dialogs, and follows only what it let through', () => {
    const { download, page, gate, usedNow } = setup();
    usedNow();
    download();
    const cancelled = download();
    expect(cancelled.decision).toBe('cancel');
    expect(cancelled.item.listenerCount('done')).toBe(0);
    // Another page's first download is its own: this page's dialog does not count against it.
    const other = new FakePage(8);
    expect(gate(other.asWebContents(), new FakeItem().asItem())).toBe('allow');
    // One watch on the page, however many of its downloads went through.
    download().item.done();
    expect(page.listenerCount('destroyed')).toBe(1);
  });

  it('forgets a page once it is destroyed', () => {
    const { download, page, usedNow } = setup();
    usedNow();
    download();
    page.destroyed = true;
    page.emit('destroyed');
    page.destroyed = false;
    // The same id would be a new page; it starts afresh.
    expect(download().decision).toBe('allow');
  });

  it('cancels a download that names no page, and logs why', () => {
    const { gate, log } = setup();
    expect(gate(undefined, new FakeItem().asItem())).toBe('cancel');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('named no page'));
  });
});

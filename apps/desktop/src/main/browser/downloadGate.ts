import type { DownloadItem, WebContents } from 'electron';
import {
  type DownloadGate,
  type DownloadPageFacts,
  type DownloadPlaces,
  downloadRefusal,
  downloadSource,
} from './sessionPolicy';

/** What the gate needs of a download: whether it is past its save dialog. */
type FollowedItem = Pick<DownloadItem, 'getSavePath' | 'on' | 'removeListener'>;

/**
 * Which pages have put a save dialog on the person's screen, and which have
 * one waiting there now, by the page's web contents id (read once, as each
 * download starts). A download is past its dialog once the person has chosen
 * where it goes (it has a save path), or once it is done: cancelled at the
 * dialog, or by anyone, or finished. A page is forgotten when it is destroyed.
 */
export class DownloadDialogs {
  private readonly waiting = new Map<number, number>();
  private readonly downloaded = new Set<number>();

  public factsFor(pageId: number): DownloadPageFacts {
    return {
      dialogWaiting: (this.waiting.get(pageId) ?? 0) > 0,
      downloadedBefore: this.downloaded.has(pageId),
    };
  }

  /** A download of this page goes on to its save dialog. */
  public opened(page: WebContents, pageId: number, item: FollowedItem): void {
    if (!this.downloaded.has(pageId)) {
      this.downloaded.add(pageId);
      page.once('destroyed', () => {
        this.downloaded.delete(pageId);
        this.waiting.delete(pageId);
      });
    }
    this.waiting.set(pageId, (this.waiting.get(pageId) ?? 0) + 1);
    let past = false;
    const pastDialog = () => {
      if (past) return;
      past = true;
      item.removeListener('updated', onUpdated);
      item.removeListener('done', pastDialog);
      const left = (this.waiting.get(pageId) ?? 1) - 1;
      if (left > 0) this.waiting.set(pageId, left);
      else this.waiting.delete(pageId);
    };
    const onUpdated = () => {
      if (item.getSavePath() !== '') pastDialog();
    };
    item.on('updated', onUpdated);
    item.on('done', pastDialog);
  }
}

/**
 * The gate on every download of the browser partitions (`gateDownloads`):
 * places its page (`downloadSource`), reads what that page has already put
 * on screen (`DownloadDialogs`), and decides (`downloadRefusal`), logging why
 * it cancels one. What it lets through, it follows to the end of its dialog.
 */
export function createDownloadGate(
  places: DownloadPlaces,
  log: (message: string) => void = console.info,
  dialogs: DownloadDialogs = new DownloadDialogs(),
): DownloadGate {
  return (from, item) => {
    const source = downloadSource(from, places);
    // Read once, and only of a page that is there: a destroyed one throws on `.id`.
    const pageId = source.kind === 'tabs' && from ? from.id : undefined;
    const page =
      pageId === undefined
        ? { dialogWaiting: false, downloadedBefore: false }
        : dialogs.factsFor(pageId);
    const refusal = downloadRefusal(source, page);
    if (refusal) {
      log(refusal);
      return 'cancel';
    }
    if (from && pageId !== undefined) dialogs.opened(from, pageId, item);
    return 'allow';
  };
}

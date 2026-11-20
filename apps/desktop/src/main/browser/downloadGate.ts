import type { DownloadItem } from 'electron';
import {
  type DownloadGate,
  type DownloadPlaces,
  downloadRefusal,
  downloadSource,
  type SessionDownloadFacts,
} from './sessionPolicy';

/** What the gate needs of a download: whether it is past its save dialog. */
type FollowedItem = Pick<DownloadItem, 'getSavePath' | 'on' | 'removeListener'>;

/**
 * The uninvited downloads each session's browser has put on the person's
 * screen: ones from a tab the person gave no input on just before. Per
 * session, not per page, because a page can open tabs with no input, each a
 * page of its own (`downloadRefusal` says why there is one at all). It knows
 * which have a save dialog waiting now, and which sessions have shown one
 * since the person's last input on any of their tabs (`personInput`). A
 * download is past its dialog once the person has chosen where it goes (it
 * has a save path), or once it is done: cancelled at the dialog, or by
 * anyone, or finished.
 */
export class UninvitedDownloads {
  /** Dialogs waiting, by session. */
  private readonly waiting = new Map<string, number>();
  /** Sessions that have shown one since the person's last input in them. */
  private readonly shownSinceInput = new Set<string>();

  /** What the sessions a download may be from have shown: either one counts. */
  public factsFor(sessionIds: readonly string[]): SessionDownloadFacts {
    return {
      uninvitedWaiting: sessionIds.some((id) => (this.waiting.get(id) ?? 0) > 0),
      uninvitedSincePersonInput: sessionIds.some((id) => this.shownSinceInput.has(id)),
    };
  }

  /** An uninvited download goes on to its save dialog: it counts against each of these sessions. */
  public shown(sessionIds: readonly string[], item: FollowedItem): void {
    for (const id of sessionIds) {
      this.shownSinceInput.add(id);
      this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
    }
    let past = false;
    const pastDialog = () => {
      if (past) return;
      past = true;
      item.removeListener('updated', onUpdated);
      item.removeListener('done', pastDialog);
      for (const id of sessionIds) {
        const left = (this.waiting.get(id) ?? 1) - 1;
        if (left > 0) this.waiting.set(id, left);
        else this.waiting.delete(id);
      }
    };
    const onUpdated = () => {
      if (item.getSavePath() !== '') pastDialog();
    };
    item.on('updated', onUpdated);
    item.on('done', pastDialog);
  }

  /** The person gave input on one of the session's tabs: its one uninvited download is back. */
  public personInput(sessionId: string): void {
    this.shownSinceInput.delete(sessionId);
  }

  /** Forgets the sessions that are gone, and with them their tabs. */
  public prune(liveSessionIds: ReadonlySet<string>): void {
    for (const id of [...this.waiting.keys()]) if (!liveSessionIds.has(id)) this.waiting.delete(id);
    for (const id of [...this.shownSinceInput]) {
      if (!liveSessionIds.has(id)) this.shownSinceInput.delete(id);
    }
  }
}

/**
 * The gate on every download of the browser partitions (`gateDownloads`):
 * places its page (`downloadSource`), reads what that page's session has
 * already shown unasked (`UninvitedDownloads`), and decides
 * (`downloadRefusal`), logging why it cancels one. An uninvited download it
 * lets through counts against its session until its dialog is past, and
 * until the person's next input there.
 */
export function createDownloadGate(
  places: DownloadPlaces,
  uninvited: UninvitedDownloads,
  log: (message: string) => void = console.info,
): DownloadGate {
  return (from, item) => {
    const source = downloadSource(from, places);
    const sessionIds = source.kind === 'tabs' ? source.sessionIds : [];
    const refusal = downloadRefusal(source, uninvited.factsFor(sessionIds));
    if (refusal) {
      log(refusal);
      return 'cancel';
    }
    if (source.kind === 'tabs' && !source.personUsing) uninvited.shown(sessionIds, item);
    return 'allow';
  };
}

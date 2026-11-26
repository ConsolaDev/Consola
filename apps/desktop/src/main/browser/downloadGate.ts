import type { DownloadItem, WebContents } from 'electron';
import { PERSON_INPUT_GUARD_MS } from './PersonInput';
import { downloadRefusal, downloadSource, isInvited, QUIET_SESSION } from './sessionPolicy';
import type { DownloadFacts, DownloadGate, DownloadPlaces, DownloadSource } from './sessionPolicy';

/** What the gate needs of a download: whether it is past its save dialog. */
type FollowedItem = Pick<DownloadItem, 'getSavePath' | 'on' | 'removeListener'>;
/** What it needs of the page it came from: when it goes. */
type FollowedPage = Pick<WebContents, 'once' | 'removeListener'>;

type PlacedSource = Extract<DownloadSource, { kind: 'tabs' }>;

/**
 * What each session's browser has put on the person's screen, for the
 * download rule (`downloadRefusal`): the save dialogs waiting now, invited
 * or not; the person's inputs a download was already allowed on (one input
 * pays for one); and the sessions that have shown an uninvited download
 * since the person's last input on any of their tabs (`personInput`).
 *
 * A dialog stops waiting once the person has chosen where its download goes
 * (it has a save path), once the download is done (cancelled at the dialog,
 * or by anyone, or finished), or once the page it came from is destroyed
 * (its tab closed, its popup or window gone): a session is never left
 * blocked by a page that is not there.
 */
export class SessionDownloads {
  /** Dialogs waiting, by session. */
  private readonly waiting = new Map<string, number>();
  /** Per tab, the time of the person's input a download was allowed on. */
  private readonly spent = new Map<string, number>();
  /** Sessions that have shown an uninvited download since the person's last input in them. */
  private readonly shownSinceInput = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** What the sessions and tabs a download may be from have shown: any one counts. */
  public factsFor(source: PlacedSource): DownloadFacts {
    return {
      dialogWaiting: source.sessionIds.some((id) => (this.waiting.get(id) ?? 0) > 0),
      inputSpent: source.tabIds.some((tabId, index) => {
        const at = source.personInputAt[index];
        return at !== undefined && this.spent.get(tabId) === at;
      }),
      uninvitedSincePersonInput: source.sessionIds.some((id) => this.shownSinceInput.has(id)),
    };
  }

  /**
   * A download goes on to its save dialog: it waits in each of its sessions
   * until it is past it, and spends the person's input (an invited one) or
   * the session's one uninvited download.
   */
  public allowed(
    source: PlacedSource,
    invited: boolean,
    page: FollowedPage,
    item: FollowedItem,
  ): void {
    const { sessionIds } = source;
    if (invited) {
      this.forgetStaleInputs();
      source.tabIds.forEach((tabId, index) => {
        const at = source.personInputAt[index];
        if (at !== undefined) this.spent.set(tabId, at);
      });
    } else {
      for (const id of sessionIds) this.shownSinceInput.add(id);
    }
    for (const id of sessionIds) this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
    let past = false;
    const pastDialog = () => {
      if (past) return;
      past = true;
      item.removeListener('updated', onUpdated);
      item.removeListener('done', pastDialog);
      page.removeListener('destroyed', pastDialog);
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
    page.once('destroyed', pastDialog);
  }

  /** The person gave input on one of the session's tabs: its one uninvited download is back. */
  public personInput(sessionId: string): void {
    this.shownSinceInput.delete(sessionId);
  }

  /** Forgets the sessions that are gone. */
  public prune(liveSessionIds: ReadonlySet<string>): void {
    for (const id of [...this.waiting.keys()]) if (!liveSessionIds.has(id)) this.waiting.delete(id);
    for (const id of [...this.shownSinceInput]) {
      if (!liveSessionIds.has(id)) this.shownSinceInput.delete(id);
    }
  }

  /** An input past the guard can no longer be spent: its mark is dropped. */
  private forgetStaleInputs(): void {
    const now = this.now();
    for (const [tabId, at] of [...this.spent]) {
      if (now - at >= PERSON_INPUT_GUARD_MS) this.spent.delete(tabId);
    }
  }
}

/**
 * The gate on every download of the browser partitions (`gateDownloads`):
 * places its page (`downloadSource`), reads what its session and tabs have
 * already shown (`SessionDownloads`), and decides (`downloadRefusal`),
 * logging why it cancels one. What it lets through it records.
 */
export function createDownloadGate(
  places: DownloadPlaces,
  downloads: SessionDownloads,
  log: (message: string) => void = console.info,
): DownloadGate {
  return (from, item) => {
    const source = downloadSource(from, places);
    const facts = source.kind === 'tabs' ? downloads.factsFor(source) : QUIET_SESSION;
    const refusal = downloadRefusal(source, facts);
    if (refusal || source.kind !== 'tabs' || !from) {
      log(refusal ?? 'Cancelled a download that named no page.');
      return 'cancel';
    }
    downloads.allowed(source, isInvited(source, facts), from, item);
    return 'allow';
  };
}

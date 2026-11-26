import type { DownloadItem, Session, Streams, WebContents } from 'electron';
import { browserPartitionFor } from '../../shared/browser';
import type { BrowserTab } from '../../shared/browser';
import type { TabHands } from './PersonInput';

/**
 * What a page may ask the person's machine for.
 *
 * Only what a page needs to behave like a page: full screen, a locked pointer
 * (games, canvases) and writing sanitised text to the clipboard. Camera,
 * microphone, location, notifications and the rest are denied — the packaged
 * app carries no usage strings for them, so they could not work anyway, and a
 * prompt the person cannot reason about is worse than none. A permission this
 * list has never heard of is denied for the same reason.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
]);

export function decidePermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

/** The partition a workspace's pages live in. */
export function partitionFor(workspaceId: string): string {
  return browserPartitionFor(workspaceId);
}

export type DownloadDecision = 'allow' | 'cancel';

/** Where a download came from, as the gate placed its page (`downloadSource`). */
export type DownloadSource =
  /** Electron named no page. */
  | { kind: 'none' }
  /**
   * A tab's page, or a popup window a tab's page opened: the tabs it may be
   * (one once its page is bound; each its window has a page coming for until
   * then), with whose hands each is in, when the person last gave input on
   * each within `PERSON_INPUT_GUARD_MS` (undefined for none), and the sessions
   * they are of.
   */
  | {
      kind: 'tabs';
      tabIds: readonly string[];
      hands: readonly TabHands[];
      personInputAt: ReadonlyArray<number | undefined>;
      sessionIds: readonly string[];
    }
  /** A page in a browser partition that is no tab's and no popup's main made. */
  | { kind: 'unknown' };

/** What the gate knows of a download's session and tabs (`SessionDownloads`). */
export interface DownloadFacts {
  /** A save dialog of a download this session's browser started waits now, invited or not. */
  dialogWaiting: boolean;
  /** A download was already allowed on the person's latest input on one of its tabs. */
  inputSpent: boolean;
  /** An uninvited download has been shown in the session since the person's last input on any of its tabs. */
  uninvitedSincePersonInput: boolean;
}

/** A session that has shown nothing, and spent nothing of the person's input. */
export const QUIET_SESSION: DownloadFacts = {
  dialogWaiting: false,
  inputSpent: false,
  uninvitedSincePersonInput: false,
};

/**
 * Whether a download is the person's own: they gave input on its tab (every
 * tab it may be) within `PERSON_INPUT_GUARD_MS`, and no download has been
 * allowed on that input yet. One input pays for one download.
 */
export function isInvited(
  source: Extract<DownloadSource, { kind: 'tabs' }>,
  facts: DownloadFacts,
): boolean {
  return source.personInputAt.every((at) => at !== undefined) && !facts.inputSpent;
}

/**
 * Why a download is cancelled before its save dialog, or null when it may go
 * on to it. In this order:
 *
 * - A tab in the agent's hands (`PersonInput.handsOf`): an agent must not
 *   start downloads nobody clicked, each of which would put a save dialog in
 *   front of the person. However long after the agent's last move or act it
 *   comes; the person takes a tab back by pressing in it, so their own click
 *   on a download link is always theirs. Cost if wrong: after an agent uses
 *   one of the person's tabs, a download that tab starts on its own is
 *   cancelled until the person next clicks or types in it.
 * - A page main cannot place, or no page at all: Consola starts no download
 *   in a browser partition itself, so one with no page is a page's that hid
 *   where it came from (a service worker, a frame that went). Cost if wrong:
 *   such a download is cancelled.
 * - A save dialog already waiting anywhere in the session, invited or not:
 *   one at a time. A waiting dialog holds the window, so the person cannot
 *   have clicked for a second one, and a page cannot stack them.
 * - The person's input on its tab, not yet spent (`isInvited`): their own
 *   click, which goes on.
 * - Anything else is uninvited, and a session's browser gets one per
 *   stretch without the person's input: none once one has been shown since
 *   the person's last input on any of its tabs. Per session, not per page,
 *   since a page can open tabs with no input, each a page of its own. One at
 *   all, since a page that starts its download after a countdown, or a
 *   server that answers the person's click late, is common.
 *
 * Cost if wrong: a page that offers two files from one click delivers the
 * second only after the first dialog is answered, and a third needs another
 * click; a site that starts a second delayed download more than 6 s after
 * the person's last click in that session's browser has it cancelled, and
 * they click again.
 */
export function downloadRefusal(source: DownloadSource, facts: DownloadFacts): string | null {
  switch (source.kind) {
    case 'none':
      return 'Cancelled a download that named no page.';
    case 'unknown':
      return 'Cancelled a download from a page that is no tab of a session.';
    case 'tabs':
      if (source.hands.length === 0 || source.hands.includes('agent')) {
        return "Cancelled a download from a tab in an agent's hands.";
      }
      if (facts.dialogWaiting) {
        return 'Cancelled a download while another’s save dialog is open in the session.';
      }
      if (isInvited(source, facts)) return null;
      if (facts.uninvitedSincePersonInput) {
        return 'Cancelled a download nobody asked for: the session has had one since the person last used its browser.';
      }
      return null;
  }
}

/** Whether a download may go on to its save dialog (`downloadRefusal`). */
export function decideDownload(source: DownloadSource, facts: DownloadFacts): DownloadDecision {
  return downloadRefusal(source, facts) === null ? 'allow' : 'cancel';
}

/** What the gate places a download's page with. */
export interface DownloadPlaces {
  /** The tab a page is bound to, or each its window has a page coming for (`BrowserService.tabsForPage`). */
  tabsForPage(contents: WebContents): BrowserTab[];
  /** The tab whose page opened this popup window, when it is one main made. */
  popupOpener(contents: WebContents): BrowserTab | undefined;
  handsOf(tab: BrowserTab): TabHands;
  /** When the person last gave input on the tab, if within `PERSON_INPUT_GUARD_MS` (`PersonInput`). */
  personInputAt(tab: BrowserTab): number | undefined;
  /** The session the tab belongs to, or undefined when none has it now. */
  sessionOf(tab: BrowserTab): string | undefined;
}

/**
 * Places the page a download came from. A popup window is judged by the tab
 * whose page opened it, and so by its session; a page of a tab by that tab,
 * or, while its window has not bound it yet (its first load can get there
 * first), by each tab the window has a page coming for. A page that is none
 * of these, or is gone, or whose tabs no session has, is `unknown`.
 */
export function downloadSource(
  from: WebContents | undefined,
  places: DownloadPlaces,
): DownloadSource {
  if (!from) return { kind: 'none' };
  if (from.isDestroyed()) return { kind: 'unknown' };
  const opener = places.popupOpener(from);
  const placed = (opener ? [opener] : places.tabsForPage(from)).flatMap((tab) => {
    const sessionId = places.sessionOf(tab);
    return sessionId ? [{ tab, sessionId }] : [];
  });
  if (placed.length === 0) return { kind: 'unknown' };
  return {
    kind: 'tabs',
    tabIds: placed.map(({ tab }) => tab.id),
    hands: placed.map(({ tab }) => places.handsOf(tab)),
    personInputAt: placed.map(({ tab }) => places.personInputAt(tab)),
    sessionIds: [...new Set(placed.map(({ sessionId }) => sessionId))],
  };
}

/**
 * Decides each download by the page it came from (undefined when Electron
 * names none), told the item so it can follow its save dialog.
 */
export type DownloadGate = (from: WebContents | undefined, item: DownloadItem) => DownloadDecision;

/**
 * Set once main can tell which tab a page is and whose hands it is in
 * (`ipc-handlers`, `createDownloadGate`), and cleared when it stops; until
 * then every download goes on to its save dialog, as before.
 */
let downloadGate: DownloadGate | null = null;

export function gateDownloads(gate: DownloadGate | null): void {
  downloadGate = gate;
}

/**
 * Partitions already configured, by name. A window attaches a guest for every
 * tab, and a second window of the same workspace can open after the first
 * closed; installing the handlers again would only stack duplicates.
 *
 * Held by partition name rather than by Session object: Electron returns the
 * same Session for a name for the life of the app, and the name is what the
 * policy is about.
 */
const configured = new Set<string>();

/**
 * Set a partition's rules before any guest uses it. Idempotent per partition.
 *
 * Certificates are not decided here. A page with a bad certificate does not
 * load (Chromium's own verdict stands), and the one exception a person can make
 * is answered per page, from its `certificate-error` event
 * (`CertificateTrust`). A session-wide verify proc would only add a main-process
 * call to every verification, and approving everything in it would also switch
 * off Certificate Transparency.
 */
export function configurePartition(partition: string, session: Session): void {
  if (configured.has(partition)) return;
  configured.add(partition);

  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(decidePermission(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => decidePermission(permission));
  // Sharing the screen or a window is never something a page may do.
  // `null` is the refusal: an empty `{}` throws in main ("Video was requested,
  // but no video stream was provided").
  session.setDisplayMediaRequestHandler((_request, callback) => {
    callback(null as unknown as Streams);
  });
  // The person's devices. Asking for one is already refused by the permission
  // check above (`hid`, `serial`, `usb`), and Electron cancels a chooser
  // nobody prevents; these say no again, so no later listener's default
  // (the first device) or grant could hand one to a page.
  session.setDevicePermissionHandler(() => false);
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  // Windows and Linux only (macOS pairs by itself, after its own prompt).
  session.setBluetoothPairingHandler?.((_details, callback) => callback({ confirmed: false }));
  // A file is never saved without asking where. With no save path set,
  // Electron shows its save dialog for every download; the title says which
  // site is offering the file, since the page names the file itself. One an
  // agent started is cancelled before that (`decideDownload`).
  session.on('will-download', (event, item, from) => {
    if (downloadGate?.(from, item) === 'cancel') {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({ title: downloadDialogTitle(item.getURL()) });
  });
}

/**
 * Empties a workspace's partition, for "Clear browsing data" and for a
 * deleted workspace: cookies and storage, the HTTP cache and the code cache
 * its sites' scripts left, the sign-ins basic auth keeps in a cache of its
 * own (neither of the others empties it), and open connections (one set up
 * under a certificate the person approved would skip the check that approval
 * no longer passes). Rejects when a step fails, so the person is told.
 * Per-site zoom levels and HSTS state stay: Electron clears neither.
 */
export async function clearBrowsingData(
  target: Pick<
    Session,
    'clearStorageData' | 'clearCache' | 'clearCodeCaches' | 'closeAllConnections' | 'clearAuthCache'
  >,
): Promise<void> {
  await target.clearStorageData();
  await target.clearCache();
  await target.clearCodeCaches({});
  await target.closeAllConnections();
  await target.clearAuthCache();
}

/** Names the site a download comes from; a page-controlled address is only ever read as a host. */
export function downloadDialogTitle(url: string): string {
  try {
    const { host } = new URL(url);
    return host ? `Save a file from ${host}` : 'Save file';
  } catch {
    return 'Save file';
  }
}

import type { DownloadItem, Session, Streams, WebContents } from 'electron';
import { type BrowserTab, browserPartitionFor } from '../../shared/browser';
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
   * A tab's page, or a popup window a tab's page opened: whose hands that tab
   * is in, whether the person gave input on it within `PERSON_INPUT_GUARD_MS`,
   * and its session. A page not bound to its tab yet may be any of several:
   * it counts as in use only when every one of them is, and is judged by
   * each of their sessions.
   */
  | {
      kind: 'tabs';
      hands: readonly TabHands[];
      personUsing: boolean;
      sessionIds: readonly string[];
    }
  /** A page in a browser partition that is no tab's and no popup's main made. */
  | { kind: 'unknown' };

/**
 * What a session's browser has already put on the person's screen unasked
 * (`UninvitedDownloads`), for the sessions a download may be from.
 */
export interface SessionDownloadFacts {
  /** An uninvited download's save dialog waits in the session now. */
  uninvitedWaiting: boolean;
  /** One has been shown in it since the person's last input on any of its tabs. */
  uninvitedSincePersonInput: boolean;
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
 * - The person's input on its tab within `PERSON_INPUT_GUARD_MS`: their own
 *   click, which goes on.
 * - Anything else is uninvited, and a session's browser gets one at a time
 *   and one per stretch without the person's input: none while another's
 *   dialog waits anywhere in the session, and none once one has been shown
 *   since the person's last input on any of its tabs. Per session, not per
 *   page: a page can open tabs with no input, each a page of its own, and
 *   would otherwise stack dialogs on the person's screen one tab at a time.
 *   One at all, since a page that starts its download after a countdown, or
 *   a server that answers the person's click late, is common. Cost if wrong:
 *   a site that starts a second delayed download more than 6 s after the
 *   person's last click in that session's browser has it cancelled; they
 *   click again.
 */
export function downloadRefusal(
  source: DownloadSource,
  session: SessionDownloadFacts,
): string | null {
  switch (source.kind) {
    case 'none':
      return 'Cancelled a download that named no page.';
    case 'unknown':
      return 'Cancelled a download from a page that is no tab of a session.';
    case 'tabs':
      if (source.hands.length === 0 || source.hands.includes('agent')) {
        return "Cancelled a download from a tab in an agent's hands.";
      }
      if (source.personUsing) return null;
      if (session.uninvitedWaiting) {
        return "Cancelled a download nobody asked for while another's save dialog is open in the session.";
      }
      if (session.uninvitedSincePersonInput) {
        return 'Cancelled a download nobody asked for: the session has had one since the person last used its browser.';
      }
      return null;
  }
}

/** Whether a download may go on to its save dialog (`downloadRefusal`). */
export function decideDownload(
  source: DownloadSource,
  session: SessionDownloadFacts,
): DownloadDecision {
  return downloadRefusal(source, session) === null ? 'allow' : 'cancel';
}

/** What the gate places a download's page with. */
export interface DownloadPlaces {
  /** The tab a page is bound to, or each its window has a page coming for (`BrowserService.tabsForPage`). */
  tabsForPage(contents: WebContents): BrowserTab[];
  /** The tab whose page opened this popup window, when it is one main made. */
  popupOpener(contents: WebContents): BrowserTab | undefined;
  handsOf(tab: BrowserTab): TabHands;
  /** Whether the person gave input on the tab within `PERSON_INPUT_GUARD_MS` (`PersonInput`). */
  personUsing(tab: BrowserTab): boolean;
  /** The session the tab belongs to, or undefined when none has it now. */
  sessionOf(tab: BrowserTab): string | undefined;
}

/**
 * Places the page a download came from. A popup window is judged by the tab
 * whose page opened it; a page of a tab by that tab, or, while its window has
 * not bound it yet (its first load can get there first), by each tab the
 * window has a page coming for. A page that is none of these, or is gone, or
 * whose tabs no session has, is `unknown`.
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
    hands: placed.map(({ tab }) => places.handsOf(tab)),
    personUsing: placed.every(({ tab }) => places.personUsing(tab)),
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

/** Names the site a download comes from; a page-controlled address is only ever read as a host. */
export function downloadDialogTitle(url: string): string {
  try {
    const { host } = new URL(url);
    return host ? `Save a file from ${host}` : 'Save file';
  } catch {
    return 'Save file';
  }
}

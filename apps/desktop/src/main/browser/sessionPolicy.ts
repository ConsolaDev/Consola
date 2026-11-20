import type { Session, Streams, WebContents } from 'electron';
import { browserPartitionFor } from '../../shared/browser';
import { agentActing, type DownloadFacts, personIsUsing } from './PersonInput';

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

/**
 * Whether a download a tab's page started may go on to the save dialog.
 *
 * An agent must not start downloads nobody clicked, and each would put a
 * save dialog in front of the person. A download is the person's when they
 * pressed a key or a button in that tab, or navigated it from the toolbar,
 * within the last 3 s. Otherwise it is cancelled when the tab is an agent's
 * (Ruling LL: whatever its page does on its own is the agent's doing), or
 * when an agent's act or move is under way on it, or ended within
 * `ACT_AFTERMATH_MS` (what a click starts reaches main after the click
 * returns). Cost if wrong: a download the person started during an agent's
 * act, or one a page in an agent's tab starts more than 3 s after their
 * click, is cancelled, and they start it again.
 */
export function decideDownload(facts: DownloadFacts): DownloadDecision {
  if (personIsUsing(facts.personInputAt, facts.now)) return 'allow';
  return facts.openedByAgent || agentActing(facts) ? 'cancel' : 'allow';
}

/**
 * A download from a page that may be any of these tabs: the one it is bound
 * to, or, before its window has bound it, each tab the window has a page
 * coming for. Cancelled when any of them would cancel it; a page that can be
 * no tab is allowed, as before.
 */
export function decideDownloadFrom(candidates: readonly DownloadFacts[]): DownloadDecision {
  return candidates.some((facts) => decideDownload(facts) === 'cancel') ? 'cancel' : 'allow';
}

/** Decides each download by the page it came from (undefined when Electron names none). */
export type DownloadGate = (from: WebContents | undefined) => DownloadDecision;

/**
 * Set once main can tell which tab a page is and what was done on it
 * (`ipc-handlers`), and cleared when it stops; until then every download
 * goes on to its save dialog, as before.
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
  // A file is never saved without asking where. With no save path set,
  // Electron shows its save dialog for every download; the title says which
  // site is offering the file, since the page names the file itself. One an
  // agent started is cancelled before that (`decideDownload`).
  session.on('will-download', (event, item, from) => {
    if (downloadGate?.(from) === 'cancel') {
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

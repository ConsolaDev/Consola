/** What main learned about a `webContents` the renderer named by id. */
export interface GuestFacts {
  /** `webContents.getType()`: only a `<webview>` guest is ever bound. */
  type: string;
  destroyed: boolean;
  /** The guest's `hostWebContents` is the window that is asking. */
  hostIsSender: boolean;
  /** The guest's session is the partition of the workspace the window holds. */
  inWorkspacePartition: boolean;
  /** The tab belongs to a session of that same workspace. */
  tabInWorkspace: boolean;
}

export type GuestBinding = { ok: true } | { ok: false; reason: string };

/**
 * Whether a renderer may bind this guest to this tab.
 *
 * The renderer names a tab and a `webContents` id, and neither is trusted: an
 * id could be another window's page, a devtools view or the app's own
 * contents, and a tab id could belong to another workspace. Every check here
 * is something main can read for itself.
 *
 * Pure: the IPC handler gathers the facts from the real objects.
 */
export function decideGuestBinding(facts: GuestFacts): GuestBinding {
  if (facts.destroyed) return { ok: false, reason: 'the page is already gone' };
  if (facts.type !== 'webview') return { ok: false, reason: 'the contents is not a <webview>' };
  if (!facts.hostIsSender) return { ok: false, reason: "the page is not this window's" };
  if (!facts.inWorkspacePartition) {
    return { ok: false, reason: "the page is not in this workspace's browser partition" };
  }
  if (!facts.tabInWorkspace) return { ok: false, reason: "the tab is not this workspace's" };
  return { ok: true };
}

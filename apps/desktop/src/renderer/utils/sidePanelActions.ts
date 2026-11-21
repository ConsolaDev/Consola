/**
 * The side panel for callers outside a component: window chords, the palette.
 * Each reads the stores when it is called, as a component would on render.
 */
import { checkoutPathForSession } from '../../shared/workspace';
import { tabFactsFor, tabKind, type TabFacts, type TabKindId } from '../sidePanel/tabKinds';
import { useCheckoutStore } from '../stores/checkoutStore';
import { useNavigationStore } from '../stores/navigationStore';
import { usePreviewTabStore } from '../stores/previewTabStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

/**
 * What the tab kinds read about the session on screen, or null when there is
 * none: no session, or the Inbox or Automations lying over it. Its checkout
 * is what the store last read, as the header's is.
 */
export function currentTabFacts(): TabFacts | null {
  const { activeWorkspaceId, activeSessionId, overlay } = useNavigationStore.getState();
  if (!activeWorkspaceId || !activeSessionId || overlay !== null) return null;
  const { getWorkspace, getSession } = useWorkspaceStore.getState();
  const workspace = getWorkspace(activeWorkspaceId);
  const session = workspace ? getSession(activeWorkspaceId, activeSessionId) : undefined;
  if (!workspace || !session) return null;
  const path = checkoutPathForSession(workspace, session);
  const checkout = path ? useCheckoutStore.getState().byPath[path] : undefined;
  return tabFactsFor(workspace, session, checkout);
}

/**
 * What the kind's header button does, for its chord: opens its tab, or hides
 * the side panel while that tab is in front. Does nothing, and answers false,
 * with no session on screen or while the kind does not apply to it, so the
 * caller can leave the key to whatever else wants it.
 */
export function pressShortcutOnScreen(kind: TabKindId): boolean {
  const facts = currentTabFacts();
  if (!facts || !tabKind(kind)?.availability(facts).available) return false;
  useSidePanelStore.getState().pressShortcut(kind);
  return true;
}

/** Opens a changed file's diff as a preview, and brings the Files tab, where previews show, to the front. */
export function openDiffInFilesTab(rootPath: string, relativePath: string, staged: boolean): void {
  usePreviewTabStore.getState().openDiff(rootPath, relativePath, staged);
  useSidePanelStore.getState().openKind('files');
}

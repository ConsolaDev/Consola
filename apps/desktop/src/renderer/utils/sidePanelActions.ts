/**
 * The side panel for callers outside a component: window chords, the palette.
 * Each reads the stores when it is called, as a component would on render.
 */
import { checkoutPathForSession } from '../../shared/workspace';
import {
  keyboardInSidePanel,
  keyboardToConversation,
} from '../components/SidePanel/keyboardAfterClose';
import { isInFront } from '../sidePanel/layout';
import { shortcutActs, tabFactsFor, tabKind } from '../sidePanel/tabKinds';
import type { TabFacts, TabKindId } from '../sidePanel/tabKinds';
import { foundPullRequestNow } from '../stores/branchPullRequestStore';
import { useCheckoutStore } from '../stores/checkoutStore';
import { infoPanelShownNow, toggleInfoPanel } from '../stores/infoPanelRoomStore';
import { useNavigationStore } from '../stores/navigationStore';
import { usePreviewTabStore } from '../stores/previewTabStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

/**
 * What the tab kinds read about the session on screen, or null when there is
 * none: no session, or the Inbox or Automations lying over it. Its checkout
 * and its branch's pull request are what the stores last read, as the
 * header's are.
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
  return tabFactsFor(
    workspace,
    session,
    checkout,
    foundPullRequestNow(workspace, session, checkout),
  );
}

function appliesTo(kind: TabKindId, facts: TabFacts): boolean {
  return tabKind(kind)?.availability(facts).available ?? false;
}

/**
 * What the kind's header button does, for its chord: opens its tab, or hides
 * the side panel while that tab is in front on screen. It acts when the
 * button would (`shortcutActs`): a kind in front is always pressed, even one
 * that does not apply to the session, because pressing it only hides the
 * panel. Does nothing, and answers false, with no session on screen, or for
 * a kind that does not apply and is not in front, so the caller can leave
 * the key to whatever else wants it.
 */
export function pressShortcutOnScreen(kind: TabKindId): boolean {
  const facts = currentTabFacts();
  const entry = tabKind(kind);
  if (!facts || !entry) return false;
  const { layout, pressShortcut } = useSidePanelStore.getState();
  if (!shortcutActs(entry, facts, isInFront(layout, kind))) return false;
  const handOn = keyboardIfSidePanelHides();
  pressShortcut(kind);
  handOn();
  return true;
}

/**
 * What the header's side panel toggle does, for its chord: shows or hides
 * the side panel. Does nothing, and answers false, with no session on screen,
 * the Inbox or Automations included, since there is no side panel there.
 */
export function toggleSidePanelOnScreen(): boolean {
  if (!currentTabFacts()) return false;
  const handOn = keyboardIfSidePanelHides();
  useSidePanelStore.getState().toggleVisible();
  handOn();
  return true;
}

/**
 * The info panel chord's action (⌥⌘J on macOS, Ctrl+Alt+J elsewhere), from
 * the window's keydown and from a page that has the keyboard (main forwards
 * the chord on `browser:shortcut`): what the header's info panel toggle and
 * the palette's row do (`toggleInfoPanel`, which they call directly), by
 * what is on screen, so a panel that stepped aside for a narrow window is
 * shown. Does nothing, and answers false, with no session on screen, the
 * Inbox or Automations included, since there is no info panel there. Showing
 * it takes no keyboard; hiding it with the keyboard on one of its rows hands
 * the keyboard to the conversation, never to the body.
 */
export function toggleInfoPanelOnScreen(): boolean {
  if (!currentTabFacts()) return false;
  const wasInInfoPanel = !!document.activeElement?.closest('.info-panel');
  toggleInfoPanel();
  if (wasInInfoPanel && !infoPanelShownNow()) {
    requestAnimationFrame(() => keyboardToConversation());
  }
  return true;
}

/**
 * For a chord that may hide the side panel: call it before the chord acts,
 * and what it returns after. Should the side panel have hidden with the
 * keyboard in it, or in a page, the keyboard goes to the conversation once
 * that has rendered (`keyboardToConversation`). From anywhere else it stays.
 */
function keyboardIfSidePanelHides(): () => void {
  const wasInSidePanel = keyboardInSidePanel();
  return () => {
    if (wasInSidePanel && !useSidePanelStore.getState().layout.visible) {
      requestAnimationFrame(() => keyboardToConversation());
    }
  };
}

/**
 * Whether the kind's view is on screen: a session is showing, the kind is in
 * front in a group on screen, and it applies to that session. A kind in front
 * that does not apply shows only why, with its view unmounted.
 */
export function kindOnScreen(kind: TabKindId): boolean {
  const facts = currentTabFacts();
  return (
    facts !== null && isInFront(useSidePanelStore.getState().layout, kind) && appliesTo(kind, facts)
  );
}

/** Opens a changed file's diff as a preview, and brings the Files tab, where previews show, to the front. */
export function openDiffInFilesTab(rootPath: string, relativePath: string, staged: boolean): void {
  usePreviewTabStore.getState().openDiff(rootPath, relativePath, staged);
  useSidePanelStore.getState().openKind('files');
}

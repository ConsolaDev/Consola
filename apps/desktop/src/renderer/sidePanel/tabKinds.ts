/**
 * The kinds of tab the side panel can hold. This is the one list of them: the
 * session header's shortcuts, the "+" list, the command palette and the layout
 * all read it, and its order is canonical, so wherever kinds are listed they
 * are listed in this order. Adding a kind is adding its id to `TabKindId` and
 * its entry to `TAB_KINDS`.
 *
 * What a kind can show depends on the session it is for, which each kind reads
 * from `TabFacts`. Nothing here looks at the layout: whether a tab is in front
 * is the caller's to work out, from `isInFront` and `visibleGroups`, and
 * `bodyFor` takes the answer.
 *
 * No components and no stores, so the node test environment can import it.
 */
import {
  Diff,
  FolderTree,
  GitPullRequest,
  Globe,
  type LucideIcon,
  TerminalSquare,
} from 'lucide-react';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import type { WorkItemRef } from '../../shared/workItems';
import { checkoutPathForSession, type Session, type Workspace } from '../../shared/workspace';
import { BROWSER_SHORTCUT_LABEL, isMac } from '../utils/platform';
import { SHELL_SHORTCUT_LABEL } from '../utils/shellShortcut';

export type TabKindId = 'changes' | 'files' | 'terminal' | 'browser' | 'pull-request';

export interface TabFacts {
  workspace: Workspace;
  session: Session;
  /** checkoutPathForSession(workspace, session); undefined while the worktree is removed. */
  checkoutPath: string | undefined;
  /** What git says the checkout is; undefined until it has been read. */
  checkout: CheckoutInfo | undefined;
}

export type Availability = { available: true } | { available: false; reason: string };

export interface TabKind {
  id: TabKindId;
  /** One uppercase letter, unique: the kind's key in the "+" list. */
  key: string;
  icon: LucideIcon;
  /** Shown beside the title in tooltips, when the kind has a chord. */
  chord?: string;
  title(facts: TabFacts): string;
  /** The tab bar's label, when it is shorter than the title. */
  tabTitle?(facts: TabFacts): string;
  availability(facts: TabFacts): Availability;
  /** 'keep': stays mounted behind another tab in a visible group. 'front': mounted only while in front. */
  mount: 'keep' | 'front';
}

const REMOVED_WORKTREE =
  'This session’s worktree was removed. It is rebuilt when the session next starts.';
const NOT_A_REPOSITORY = 'This folder is not a git repository.';
const NO_FOLDER = 'This session has no folder.';
const NOT_LINKED = 'This session is not linked to a pull request or issue.';
const NO_ACCOUNT = 'This workspace has no account to read it with. Add one in Workspace settings.';

const unavailable = (reason: string): Availability => ({ available: false, reason });

/** The Pull request kind's title: the linked item, or the kind's own name without one. */
function workItemTitle(item: WorkItemRef | undefined): string {
  if (!item) return 'Pull request';
  return `${item.type === 'pr' ? 'Pull request' : 'Issue'} #${item.number}`;
}

/**
 * For a kind that shows the session's folder: available whenever there is
 * one. `checkoutPath` is undefined while the worktree is removed, and also
 * for a session with no folder of its own whose workspace has no scope left
 * to fall back to, so a view never has to assume it.
 */
function folderAvailability(facts: TabFacts): Availability {
  if (facts.session.removedWorktree) return unavailable(REMOVED_WORKTREE);
  if (facts.checkoutPath === undefined) return unavailable(NO_FOLDER);
  return { available: true };
}

export const TAB_KINDS: readonly TabKind[] = [
  {
    id: 'changes',
    key: 'D',
    icon: Diff,
    title: () => 'Changes',
    // While the checkout is unread it is offered: `GitReviewPanel` says
    // "Not a git repository" itself if that turns out to be the answer.
    availability: (facts) => {
      if (facts.session.removedWorktree) return unavailable(REMOVED_WORKTREE);
      if (facts.checkout?.kind === 'none') return unavailable(NOT_A_REPOSITORY);
      return { available: true };
    },
    mount: 'keep',
  },
  {
    id: 'files',
    key: 'F',
    icon: FolderTree,
    chord: isMac ? '⇧⌘E' : 'Ctrl+Shift+E',
    title: () => 'Files',
    availability: folderAvailability,
    mount: 'keep',
  },
  {
    // The session's shell, in its checkout. Its view attaching spawns the
    // shell, and main rebuilds a removed worktree first, so the view mounts
    // only in front, in a group on screen, while there is a folder: a tab
    // behind another, in a hidden panel, in a group Maximize hides, or for a
    // removed worktree starts nothing. Closing the tab tears down only the
    // view; the shell keeps running, and its screen comes back with the tab.
    id: 'terminal',
    key: 'T',
    icon: TerminalSquare,
    chord: SHELL_SHORTCUT_LABEL,
    title: () => 'Terminal',
    availability: folderAvailability,
    mount: 'front',
  },
  {
    // The session's in-app browser. It holds no page: pages live in
    // `BrowserHost`, and its view only claims the slot a page is drawn over,
    // clearing the agent's dot as it does. So the view mounts only in front,
    // in a group on screen: a tab behind another, in a hidden panel or in a
    // group Maximize hides claims nothing, and its page hides. Its tabs
    // belong to the session and its logins to the workspace, so it reads no
    // checkout and applies to every session.
    id: 'browser',
    key: 'B',
    icon: Globe,
    chord: BROWSER_SHORTCUT_LABEL,
    title: () => 'Browser',
    availability: () => ({ available: true }),
    mount: 'front',
  },
  {
    // The session's linked pull request or issue. It reads the item, never
    // the checkout, so it needs no folder.
    id: 'pull-request',
    key: 'P',
    icon: GitPullRequest,
    title: (facts) => workItemTitle(facts.session.workItem),
    tabTitle: (facts) => {
      const item = facts.session.workItem;
      if (!item) return workItemTitle(item);
      return item.type === 'pr' ? `#${item.number}` : 'Issue';
    },
    // The item is read as the workspace's account, as the Inbox reads it, so
    // a link is not enough without one.
    availability: (facts) => {
      if (!facts.session.workItem) return unavailable(NOT_LINKED);
      if (!facts.workspace.provider) return unavailable(NO_ACCOUNT);
      return { available: true };
    },
    mount: 'keep',
  },
];

export const TAB_KIND_IDS: readonly TabKindId[] = TAB_KINDS.map((kind) => kind.id);

/** The kind with this id, or undefined for one this build does not list. */
export function tabKind(id: string): TabKind | undefined {
  return TAB_KINDS.find((kind) => kind.id === id);
}

export function isTabKindId(id: string): id is TabKindId {
  return tabKind(id) !== undefined;
}

export function tabFactsFor(
  workspace: Workspace,
  session: Session,
  checkout: CheckoutInfo | undefined,
): TabFacts {
  return { workspace, session, checkoutPath: checkoutPathForSession(workspace, session), checkout };
}

/**
 * What a tab's slot renders. A kind that mounts only in front renders nothing
 * behind, whatever it would say. Otherwise an unavailable kind says why in
 * front and renders nothing behind, and an available one renders its view.
 * This is the gate a view's own effects sit behind: a view that is not
 * rendered starts nothing.
 */
export function bodyFor(
  kind: TabKind,
  facts: TabFacts,
  inFront: boolean,
): 'view' | 'unavailable' | 'none' {
  if (!inFront && kind.mount === 'front') return 'none';
  if (!kind.availability(facts).available) return inFront ? 'unavailable' : 'none';
  return 'view';
}

/**
 * Whether pressing a kind's shortcut, its header button or its chord, does
 * anything. A kind in front on screen always does, even one that does not
 * apply to the session, because pressing it only hides the side panel.
 * Otherwise it does only while the kind applies. The header button is
 * dimmed exactly while this is false, so the button and the chord agree.
 */
export function shortcutActs(kind: TabKind, facts: TabFacts, inFront: boolean): boolean {
  return inFront || kind.availability(facts).available;
}

/** The "+" list: the available kinds, then the unavailable ones, each in registry order. */
export function newTabOptions(
  facts: TabFacts,
  kinds: readonly TabKind[] = TAB_KINDS,
): Array<{ kind: TabKind; availability: Availability }> {
  const options = kinds.map((kind) => ({ kind, availability: kind.availability(facts) }));
  return [
    ...options.filter((option) => option.availability.available),
    ...options.filter((option) => !option.availability.available),
  ];
}

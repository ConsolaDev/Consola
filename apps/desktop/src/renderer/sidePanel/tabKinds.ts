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
import { Diff, type LucideIcon } from 'lucide-react';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { checkoutPathForSession, type Session, type Workspace } from '../../shared/workspace';

export type TabKindId = 'changes';

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

const unavailable = (reason: string): Availability => ({ available: false, reason });

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

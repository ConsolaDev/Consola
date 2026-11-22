import { useEffect } from 'react';
import { create } from 'zustand';
import type { BranchPullRequestAnswer } from '../../shared/branchPullRequest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { INBOX_REFRESH_INTERVAL_MS, type WorkItemRef } from '../../shared/workItems';
import { checkoutPathForSession, type Session, type Workspace } from '../../shared/workspace';
import { providerBridge } from '../services/providerBridge';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { useCheckoutStore } from './checkoutStore';

export interface BranchPullRequestEntry {
  /** What main last answered; it names the branch it was read for. */
  answer?: BranchPullRequestAnswer;
  /** A lookup is running, or waiting for the one running. */
  loading: boolean;
  /** When the last lookup was asked of main: 0 until one has been. */
  askedAt: number;
}

/** One entry per workspace and folder: main reads the folder's branch, and the workspace's account asks. */
export function branchLookupKey(workspaceId: string, dir: string): string {
  return JSON.stringify([workspaceId, dir]);
}

interface FindOptions {
  /** The person's Refresh or Retry: main asks the provider again rather than answer from its cache. */
  force?: boolean;
  /**
   * The branch the caller knows the checkout is on. Never sent: main reads
   * the branch from the folder itself. It says whether a lookup already
   * running was asked about the same branch.
   */
  branch?: string;
}

interface BranchPullRequestState {
  /** Each checkout's last answer, by `branchLookupKey`. */
  entries: Record<string, BranchPullRequestEntry>;
  /**
   * Ask main for the pull request of the branch checked out in `dir`. One
   * lookup per key runs at a time, and a find joins it while it can answer
   * for that find: asked about the same branch, and forced if the find is.
   * Otherwise one more lookup is asked once it ends, shared by every find
   * meanwhile, so an answer for a branch the checkout has since left never
   * ends a lookup, and the person's Retry never takes an answer main gave
   * from its cache.
   */
  find(workspaceId: string, dir: string, options?: FindOptions): Promise<void>;
}

interface Lookup {
  force: boolean;
  branch: string | undefined;
}

const NEVER_ASKED: BranchPullRequestEntry = { loading: false, askedAt: 0 };

/** Why a lookup failed when main could read no branch from the folder. */
const BRANCH_UNREAD = 'git could not read the branch';

/**
 * What the entry holds once a lookup asked about `asked` ends with `answer`.
 * An answer that says nothing new never takes the place of one that does:
 * - main read no branch (git failed or timed out, or HEAD was detached for
 *   a moment): the answer for the branch asked about stays, else that
 *   branch's lookup failed, so the person can retry it;
 * - a failure keeps the pull request already found for the same branch, so
 *   its section and tab stay. The item's own read says when that fails.
 * A real answer that the branch has none replaces a found one.
 */
function settledAnswer(
  previous: BranchPullRequestAnswer | undefined,
  answer: BranchPullRequestAnswer,
  asked: string | undefined,
): BranchPullRequestAnswer {
  if (answer.branch === null && asked !== undefined) {
    return previous?.branch === asked
      ? previous
      : { kind: 'failed', branch: asked, error: BRANCH_UNREAD };
  }
  if (answer.kind === 'failed' && previous?.kind === 'found' && previous.branch === answer.branch) {
    return previous;
  }
  return answer;
}

/** The lookup running per key, and what it was asked. */
const running = new Map<string, { promise: Promise<void>; lookup: Lookup }>();
/** The one lookup waiting for it, for every find asked meanwhile: the latest branch, forced if any was. */
const waiting = new Map<string, { promise: Promise<void>; lookup: Lookup }>();

/**
 * The pull request each checkout's branch has, for sessions linked to none.
 * Main reads the branch from the folder and keeps every answer for the
 * Inbox's interval, so asking here costs a few git reads, not a provider
 * request. An answer is only ever shown: the session is linked when the
 * person presses Link.
 */
export const useBranchPullRequestStore = create<BranchPullRequestState>((set, get) => {
  function patch(key: string, change: Partial<BranchPullRequestEntry>): void {
    set((state) => ({
      entries: { ...state.entries, [key]: { ...(state.entries[key] ?? NEVER_ASKED), ...change } },
    }));
  }

  function ask(key: string, workspaceId: string, dir: string, lookup: Lookup): Promise<void> {
    patch(key, { loading: true, askedAt: Date.now() });
    const promise = providerBridge
      .findBranchPullRequest(workspaceId, dir, { force: lookup.force })
      .then(
        (answer): BranchPullRequestAnswer => {
          // Main read a branch the renderer does not know of yet, or none (a
          // detached HEAD, say): asking again would be answered the same way,
          // so the checkout is read again.
          if (lookup.branch !== undefined && answer.branch !== lookup.branch) {
            void useCheckoutStore.getState().load(dir);
          }
          return answer;
        },
        (error: unknown): BranchPullRequestAnswer | undefined =>
          lookup.branch === undefined
            ? undefined
            : { kind: 'failed', branch: lookup.branch, error: ipcErrorMessage(error) },
      )
      .then((answer) => {
        running.delete(key);
        // A failure with no branch to name keeps the last answer.
        const previous = get().entries[key]?.answer;
        const kept = answer ? settledAnswer(previous, answer, lookup.branch) : previous;
        patch(key, { loading: waiting.has(key), answer: kept });
      });
    running.set(key, { promise, lookup });
    return promise;
  }

  return {
    entries: {},

    find: (workspaceId, dir, { force = false, branch } = {}) => {
      const key = branchLookupKey(workspaceId, dir);
      const next = waiting.get(key);
      if (next) {
        next.lookup.branch = branch;
        next.lookup.force ||= force;
        return next.promise;
      }
      const current = running.get(key);
      if (!current) return ask(key, workspaceId, dir, { force, branch });
      if (current.lookup.branch === branch && (current.lookup.force || !force)) {
        return current.promise;
      }
      const lookup: Lookup = { force, branch };
      patch(key, { loading: true });
      const promise = current.promise.then(() => {
        waiting.delete(key);
        return ask(key, workspaceId, dir, lookup);
      });
      waiting.set(key, { promise, lookup });
      return promise;
    },
  };
});

/** The checkout's branch, when it has one: a detached HEAD or a folder outside git has none. */
function branchOf(checkout: CheckoutInfo | undefined): string | undefined {
  return checkout && checkout.kind !== 'none' ? checkout.branch : undefined;
}

/** The found pull request, only while the checkout is still on the branch it was found for. */
export function foundPullRequestOf(
  entry: BranchPullRequestEntry | undefined,
  branch: string | undefined,
): WorkItemRef | undefined {
  const answer = entry?.answer;
  if (!branch || answer?.kind !== 'found' || answer.branch !== branch) return undefined;
  return answer.pullRequest.ref;
}

/** Where a session's lookup is kept, or null for a session it does not apply to: one linked, or with no folder. */
function lookupKeyOf(
  workspace: Workspace | undefined,
  session: Session | undefined,
): string | null {
  if (!workspace || !session || session.workItem) return null;
  const dir = checkoutPathForSession(workspace, session);
  return dir ? branchLookupKey(workspace.id, dir) : null;
}

/**
 * The pull request found from an unlinked session's branch, as last looked
 * up. It never asks: `useBranchPullRequestLookup` does, while someone looks.
 * Takes the session as it may still be loading, so it can be called before
 * a component knows it has one.
 */
export function useFoundPullRequest(
  workspace: Workspace | undefined,
  session: Session | undefined,
  checkout: CheckoutInfo | undefined,
): WorkItemRef | undefined {
  const key = lookupKeyOf(workspace, session);
  const entry = useBranchPullRequestStore((state) => (key ? state.entries[key] : undefined));
  return foundPullRequestOf(entry, branchOf(checkout));
}

/** `useFoundPullRequest`, for callers outside a component: as the store holds it now. */
export function foundPullRequestNow(
  workspace: Workspace,
  session: Session,
  checkout: CheckoutInfo | undefined,
): WorkItemRef | undefined {
  const key = lookupKeyOf(workspace, session);
  const entry = key ? useBranchPullRequestStore.getState().entries[key] : undefined;
  return foundPullRequestOf(entry, branchOf(checkout));
}

/** The session's lookup entry as it is, for the info panel: it never asks. */
export function useBranchLookupEntry(
  workspace: Workspace,
  session: Session,
): BranchPullRequestEntry | undefined {
  const key = lookupKeyOf(workspace, session);
  return useBranchPullRequestStore((state) => (key ? state.entries[key] : undefined));
}

/**
 * Asks while `active`, for an unlinked session with an account, a checkout path and a branch:
 * on becoming active, when the branch or path changes, and every INBOX_REFRESH_INTERVAL_MS while active.
 *
 * `active` is someone looking at pull request facts: the info panel shown
 * with its Pull request section open, or the Pull request tab in front. A
 * folded section or a hidden panel asks nothing.
 */
export function useBranchPullRequestLookup(
  workspace: Workspace | undefined,
  session: Session | undefined,
  checkout: CheckoutInfo | undefined,
  active: boolean,
): void {
  const workspaceId = workspace?.id;
  // Another account may see another answer: a new login asks again.
  const accountLogin = workspace?.provider?.accountLogin;
  const dir =
    workspace && session && !session.workItem
      ? checkoutPathForSession(workspace, session)
      : undefined;
  const branch = branchOf(checkout);
  const asks = active && !!branch;

  useEffect(() => {
    if (!asks || !workspaceId || !accountLogin || !dir) return;
    const ask = () => void useBranchPullRequestStore.getState().find(workspaceId, dir, { branch });
    ask();
    const timer = setInterval(ask, INBOX_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [asks, workspaceId, accountLogin, dir, branch]);
}

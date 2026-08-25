import type { GitProviderId } from './providers';
import { isGitProviderId, PROVIDER_META } from './providers';

/**
 * Work-item shapes shared by main and renderer.
 *
 * Deliberately token-free: a token is borrowed from the provider CLI inside
 * the main process at the moment it is needed and never crosses IPC. Anything
 * defined here may end up in a renderer, so nothing here may carry a credential.
 */

/**
 * Why an item is in the inbox. An item can carry several: a PR you authored
 * and were also asked to review is both, and the sections care which.
 */
export type InboxRole =
  | 'review-requested-direct'
  | 'review-requested-team'
  | 'author'
  | 'assignee'
  | 'involved';

/**
 * A remote work item a session is about. Mutable on the session since v7:
 * a hand-made session can be linked to one after the fact, or unlinked.
 */
export interface WorkItemRef {
  provider: GitProviderId;
  /** "owner/name", e.g. "sympower/controller-app". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}

/**
 * One PR or issue in a workspace's Inbox, provider-neutral.
 *
 * Remote-driven on purpose: items exist whether or not the repo is cloned
 * locally. Everything the renderer shows comes from this shape — it holds no
 * token and no local path.
 */
export interface InboxItem {
  workItem: WorkItemRef;
  title: string;
  /** Login of whoever opened it. */
  author: string;
  /** Every reason this item is in the inbox; see sectionFor. */
  roles: InboxRole[];
  isDraft: boolean;
  /** Lowercased provider state, e.g. 'open'. */
  state: string;
  /** Normalised review verdict; 'none' for issues and unreviewed PRs. */
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none';
  /** Rolled-up CI verdict; absent when the item has no checks (issues, no CI). */
  ciStatus?: 'pending' | 'passing' | 'failing';
  /** Check counts, when the provider reports them. Phase D fills this in. */
  checks?: { passed: number; failed: number; pending: number; total: number };
  commentCount: number;
  additions?: number;
  deletions?: number;
  /** ISO timestamp from the provider, used for ordering. */
  updatedAt: string;
  url: string;
}

/**
 * One workspace's cached Inbox. Main owns it; renderers receive it on
 * inbox:changed and via inbox:get.
 *
 * On a failed refresh the previous items and fetchedAt are carried forward and
 * `error` is set — "degrade, never dialog": the UI labels the staleness, it
 * never loses the last good list.
 */
export interface InboxSnapshot {
  workspaceId: string;
  items: InboxItem[];
  /** Epoch ms of the last successful fetch; 0 when nothing ever succeeded. */
  fetchedAt: number;
  error?: string;
}

/** Whether two refs name the same work item. Repo casing is not identity. */
export function sameWorkItem(a?: WorkItemRef, b?: WorkItemRef): boolean {
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.type === b.type &&
    a.number === b.number
  );
}

/** Stable map key for a work item, casing-normalised like sameWorkItem. */
export function workItemKey(ref: WorkItemRef): string {
  return `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`;
}

/**
 * Canonical web URL for a work item, for when no fetched item carries one.
 *
 * Renderer-reachable on purpose (the strip needs a link with no driver round
 * trip); the GitHub driver's own workItemUrl delegates here. A plain
 * find-and-replace rather than workItemPrompt.ts's substitutePlaceholders:
 * that module imports from this one, so borrowing it back would be a cycle.
 */
export function workItemUrl(ref: WorkItemRef): string {
  return PROVIDER_META[ref.provider].webUrlTemplate[ref.type]
    .replace('{{repo}}', ref.repo)
    .replace('{{number}}', String(ref.number));
}

/** Exactly one slash, no whitespace on either side of it. */
const OWNER_NAME_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * Shape-validate an unknown value as a WorkItemRef before it reaches
 * WorkspaceService: a known provider id, "owner/name", pr | issue, and a
 * positive integer number. Pure; the WORKSPACE_SESSION_UPDATE handler runs
 * it on the link payload, where TypeScript's types are long gone.
 */
export function isValidWorkItemRef(value: unknown): value is WorkItemRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isGitProviderId(ref.provider) &&
    typeof ref.repo === 'string' &&
    OWNER_NAME_PATTERN.test(ref.repo) &&
    (ref.type === 'pr' || ref.type === 'issue') &&
    typeof ref.number === 'number' &&
    Number.isInteger(ref.number) &&
    ref.number > 0
  );
}

/**
 * Rebuild a ref from an allow-list, setActions/setProviderBinding-style: an
 * IPC payload that passed isValidWorkItemRef is still whatever shape the
 * renderer sent, and this is the caller's chance to drop anything beyond the
 * four fields before it is stored or persisted.
 */
export function toWorkItemRef(ref: WorkItemRef): WorkItemRef {
  return { provider: ref.provider, repo: ref.repo, type: ref.type, number: ref.number };
}

/**
 * What a launch asks for: a stored action by id, or an ad-hoc body that is
 * rendered like an action's but never persisted (its session records the
 * name snapshot 'Custom prompt').
 */
export type WorkItemLaunchAction = { id: string } | { customPrompt: string };

/**
 * 'action:<id>' or 'custom:<trimmed body>' — the key under which one action
 * against one item is coalesced (main) and shown as in-flight (renderer).
 * The raw trimmed body rather than a hash: the strings are short, and an
 * inspectable key is worth more than a shorter one.
 */
export function workItemActionKey(action: WorkItemLaunchAction): string {
  return 'id' in action ? `action:${action.id}` : `custom:${action.customPrompt.trim()}`;
}

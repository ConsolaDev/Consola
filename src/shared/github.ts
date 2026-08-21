/**
 * GitHub-facing shapes shared by main and renderer.
 *
 * Deliberately token-free: a token is borrowed from `gh` inside the main
 * process at the moment it is needed and never crosses IPC. Anything defined
 * here may end up in a renderer, so nothing here may ever carry a credential.
 */

/** One account in the `gh` keyring, as `gh auth status` reports it. */
export interface GhAccount {
  login: string;
  /** Whether `gh` itself would use this account today (its active account). */
  active: boolean;
}

/** What probing the `gh` CLI found. Feeds the settings account picker. */
export interface GhProbeResult {
  /** The binary was found and runs. */
  available: boolean;
  /** Path actually resolved, when one was found. */
  resolvedBinary?: string;
  version?: string;
  /** Empty when nobody is signed in — the UI offers `gh auth login`. */
  accounts: GhAccount[];
  error?: string;
}

/**
 * A remote work item a session was launched from. Immutable on the session,
 * like `harnessId`: it names why the session exists.
 */
export interface WorkItemRef {
  provider: 'github';
  /** "owner/name", e.g. "sympower/controller-app". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}

/**
 * One PR or issue in a workspace's Inbox, as fetched from GitHub.
 *
 * Remote-driven on purpose: items exist whether or not the repo is cloned
 * locally. Everything the renderer shows comes from this shape — it holds no
 * token and no local path.
 */
export interface InboxItem {
  workItem: WorkItemRef;
  title: string;
  /** Lowercased GitHub state, e.g. 'open'. */
  state: string;
  /** Why this item is in the inbox. One role per item; see parseInboxPayload. */
  role: 'assigned' | 'author' | 'review-requested';
  /** Rolled-up CI verdict; absent when the item has no checks (issues, no CI). */
  ciStatus?: 'pending' | 'passing' | 'failing';
  /** GitHub's reviewDecision verbatim, e.g. 'CHANGES_REQUESTED'. PRs only. */
  reviewDecision?: string;
  /** ISO timestamp from GitHub, used for ordering. */
  updatedAt: string;
  url: string;
  additions?: number;
  deletions?: number;
}

/**
 * One workspace's cached Inbox. Main owns it; renderers receive it on
 * github:inbox-changed and via github:get-inbox.
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

/** Canonical GitHub URL for a work item, for when no fetched item carries one. */
export function workItemUrl(ref: WorkItemRef): string {
  return `https://github.com/${ref.repo}/${ref.type === 'pr' ? 'pull' : 'issues'}/${ref.number}`;
}

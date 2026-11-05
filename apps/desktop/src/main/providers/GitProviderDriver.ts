import type { WorkItemDetails as SharedWorkItemDetails, WorkItemMutation } from '../../shared/workItemDetails';
import type { GitProviderId, ProviderBinding, ProviderProbeResult } from '../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { PullRequestLookup, PullRequestQuery } from './pullRequests';

/**
 * What Consola needs from a git hosting provider in order to run its Inbox.
 *
 * The mirror of HarnessDriver one layer over: Consola coordinates the
 * provider's own CLI rather than speaking its API, so a driver describes how
 * to borrow a credential, fetch the inbox, check a work item out and clone a
 * repo — never how a PR looks. Every method corresponds to something that
 * genuinely differs between providers. Nothing outside src/main/providers/
 * may branch on `id`; the registry in ./index.ts is the only place that does.
 */
export interface GitProviderDriver {
  readonly id: GitProviderId;

  /**
   * Environment variable carrying the borrowed token into subprocesses and
   * PTYs ('GH_TOKEN' for GitHub). Named per driver so the layering code
   * never has to know which CLI reads what.
   */
  readonly tokenEnvVar: string;

  /** Binary present? Who is signed in? Feeds the binding panel. Never throws. */
  probe(): Promise<ProviderProbeResult>;

  /**
   * Borrow a token for one account. Cached briefly in memory, never
   * persisted, never put on IPC. Throws with the CLI's own reason on
   * failure — the caller decides how to degrade.
   */
  token(accountLogin: string): Promise<string>;

  /**
   * One request, provider-neutral items. Must throw on an unrecognised
   * reply: a plausible-looking empty list would read as "nothing to do".
   */
  fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]>;

  fetchDetails?(ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<SharedWorkItemDetails>;
  mutateItem?(ref: WorkItemRef, mutation: WorkItemMutation, env: NodeJS.ProcessEnv): Promise<void>;

  /**
   * Check a work item out inside an existing detached worktree. Every git
   * mechanic around it (add, prune, branch) is WorktreeService's; this is
   * only the provider-specific fetch.
   */
  checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<void>;

  /** Clone `repo` to `destinationDir` (the clone's own directory, not its parent). */
  cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void>;

  /** Whether a git remote URL names `repo` on this provider. */
  matchesRemote(remoteUrl: string, repo: string): boolean;

  workItemUrl(ref: WorkItemRef): string;

  /** The fixed context header prepended to every action body. */
  seedHeader(ref: WorkItemRef, item?: InboxItem): string;

  /**
   * `owner/name` for a git remote URL on this provider, or null when the URL
   * is not one of its repositories. How a worktree that was never linked to
   * a work item learns which repository its branch's PR would live in.
   */
  repoOfRemote?(remoteUrl: string): string | null;

  /**
   * Whether `url` is a file only a signed-in account can read — an image
   * pasted into a private repository's pull request. Main fetches those with
   * the workspace account's token as a Bearer credential, on that one
   * request only; every other image in a work item is fetched anonymously.
   */
  isPrivateAsset?(url: URL): boolean;

  /**
   * Pull requests in every state — open, merged, closed — by number or by
   * head branch. One answer per query, in order; a failed query carries
   * `error` instead of failing the batch. Must refuse unrecognised replies:
   * an empty list reads as "no PR", and callers act on that.
   */
  lookupPullRequests?(queries: PullRequestQuery[], env: NodeJS.ProcessEnv): Promise<PullRequestLookup[]>;

  /**
   * One item as a reviewer reads it: its description and comments, and for a
   * pull request the files it changes and its diff. Fetched by main with the
   * account's token for a session that holds none — a read-only session's
   * only window on the item beyond its checkout. Must refuse a reply it does
   * not recognise rather than describe an item that is not there.
   */
  describeWorkItem?(ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<WorkItemDetails>;
}

/** What `describeWorkItem` returns. Everything but the URL and the counts is other people's text. */
export interface WorkItemDetails {
  title: string;
  body: string;
  author: string;
  /** Lowercased provider state, e.g. 'open'. */
  state: string;
  url: string;
  comments: Array<{ author: string; body: string }>;
  /** Pull requests only. */
  baseRef?: string;
  headRef?: string;
  files?: Array<{ path: string; additions: number; deletions: number }>;
  diff?: string;
}

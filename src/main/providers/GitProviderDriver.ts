import type { GitProviderId, ProviderBinding, ProviderProbeResult } from '../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';

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
}

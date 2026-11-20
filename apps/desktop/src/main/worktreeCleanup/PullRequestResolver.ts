import type { Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type {
  PullRequestLookup,
  PullRequestQuery,
  PullRequestState,
} from '../providers/pullRequests';
import type { WorktreeInspection, WorktreeService } from '../WorktreeService';
import type { PullRequestFact } from './policy';

export interface PullRequestResolverDeps {
  /** The workspace's provider driver, or null when it has none this build can use. */
  driverFor(workspace: Workspace): GitProviderDriver | null;
  /** Login env plus the workspace account's token, composed in main. */
  composeEnv(workspace: Workspace): Promise<NodeJS.ProcessEnv>;
  worktrees: Pick<WorktreeService, 'isManagedPath' | 'inspect'>;
}

/** Which pull request could explain a session, and how to ask about it. */
export interface Attribution {
  workspace: Workspace;
  session: Session;
  driver: GitProviderDriver;
  query: PullRequestQuery;
  /** Already inspected when the PR was found through the worktree's branch. */
  inspection?: WorktreeInspection;
}

/** A lookup reduced to what cleanup decides on. */
export type PullRequestJudgement =
  | { kind: 'finished'; pr: PullRequestState }
  | { kind: 'open'; pr: PullRequestState }
  | { kind: 'none' }
  | { kind: 'failed'; error: string };

/**
 * Which pull request a session is about, and whether it is finished.
 *
 * A session is attributed a PR only if it is linked to one, or runs in one of
 * Consola's own worktrees whose pushed branch has one. A branch is never read
 * from a scope folder: whatever that checkout has on it now says nothing
 * about why the session exists. Shared by the cleanup tools and the
 * "pull request finished" rule.
 */
export class PullRequestResolver {
  constructor(private readonly deps: PullRequestResolverDeps) {}

  /** Null when no PR can explain the session: it is not a candidate at all. */
  public async attribute(
    workspace: Workspace,
    session: Session,
  ): Promise<Attribution | 'no-provider' | null> {
    const linked = session.workItem?.type === 'pr';
    const managed = !linked && !!session.cwd && this.deps.worktrees.isManagedPath(session.cwd);
    if (!linked && !managed) return null;

    const driver = this.deps.driverFor(workspace);
    // A linked session in a workspace that cannot answer is worth
    // reporting; a worktree session in a local-only workspace is simply
    // not something cleanup can reason about.
    if (!driver?.lookupPullRequests) return linked ? 'no-provider' : null;
    if (linked) {
      const { repo, number } = session.workItem!;
      return { workspace, session, driver, query: { repo, number } };
    }

    const inspection = await this.deps.worktrees.inspect(session.cwd!);
    // A detached HEAD, a missing remote, or a remote on another host
    // leave nothing to look up — not a candidate rather than a guess.
    if (!inspection?.isLinkedWorktree || !inspection.remoteBranch || !inspection.originUrl)
      return null;
    const repo = driver.repoOfRemote?.(inspection.originUrl);
    if (!repo) return null;
    return {
      workspace,
      session,
      driver,
      query: { repo, headBranch: inspection.remoteBranch },
      inspection,
    };
  }

  /** One batched provider call for a workspace, with the env it ran under. Throws as a whole. */
  public async lookup(
    workspace: Workspace,
    driver: GitProviderDriver,
    queries: PullRequestQuery[],
  ): Promise<{ env: NodeJS.ProcessEnv; lookups: PullRequestLookup[] }> {
    const env = await this.deps.composeEnv(workspace);
    const lookups = await driver.lookupPullRequests!(queries, env);
    return { env, lookups };
  }

  /** For an explicit delete: the session's PR, if one can be found, and the env to fetch it with. */
  public async prFor(
    workspace: Workspace,
    session: Session,
  ): Promise<{ pr: PullRequestState | null; env: NodeJS.ProcessEnv }> {
    try {
      const attribution = await this.attribute(workspace, session);
      if (attribution && attribution !== 'no-provider') {
        const { env, lookups } = await this.lookup(workspace, attribution.driver, [
          attribution.query,
        ]);
        return { pr: lookups[0]?.pullRequests[0] ?? null, env };
      }
      if (workspace.provider) return { pr: null, env: await this.deps.composeEnv(workspace) };
    } catch {
      // No PR to compare with: "pushed to a remote" decides instead.
    }
    return { pr: null, env: process.env };
  }
}

/** Finished means merged or closed with none open for the same thing. */
export function judgeLookup(lookup: PullRequestLookup): PullRequestJudgement {
  if (lookup.error) return { kind: 'failed', error: lookup.error };
  const open = lookup.pullRequests.find((pr) => pr.status === 'open');
  if (open) return { kind: 'open', pr: open };
  const pr = lookup.pullRequests[0];
  if (!pr) return { kind: 'none' };
  return { kind: 'finished', pr };
}

/** The policy's view of a judgement. */
export function toFact(judgement: PullRequestJudgement): PullRequestFact {
  switch (judgement.kind) {
    case 'finished':
      return {
        kind: 'finished',
        number: judgement.pr.number,
        status: judgement.pr.status === 'merged' ? 'merged' : 'closed',
      };
    case 'open':
      return { kind: 'open', number: judgement.pr.number };
    case 'none':
      return { kind: 'none' };
    case 'failed':
      return { kind: 'unknown', detail: judgement.error };
  }
}

import type { Session, Workspace } from '../../shared/workspace';
import {
  anySweepRuleOn,
  type CleanupEntry,
  type CleanupPreview,
  type CleanupReport,
  describeTrigger,
  type RemovedWorktree,
  type SessionDeleteOutcome,
  type SessionDeletePreview,
  type TreeVerdict,
  type WorktreeCleanupRules,
} from '../../shared/worktreeCleanup';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type { WorktreeInspection } from '../WorktreeService';
import {
  FactGatherer,
  type FactSources,
  type GatherOptions,
  type ResolvedPullRequest,
} from './FactGatherer';
import type { PathLock } from './PathLock';
import { judge, type TreeFacts, userBlockers } from './policy';
import type { ProcessSnapshot } from './ProcessCwdIndex';
import { judgeLookup, PullRequestResolver, toFact } from './PullRequestResolver';
import { indexTrees, type TreeUser } from './TreeIndex';
import { type Execution, type ExecutorDeps, WorktreeExecutor } from './WorktreeExecutor';

export interface WorktreeCleanupDeps extends Omit<FactSources, 'lock' | 'worktrees'> {
  lock: Pick<PathLock, 'run' | 'recentlyPrepared'>;
  worktrees: FactSources['worktrees'] &
    ExecutorDeps['worktrees'] & { isManagedPath(dir: string): boolean };
  stop(session: Pick<Session, 'id' | 'instanceId'>): void;
  recordRemoved(entries: Array<{ sessionId: string; removed: RemovedWorktree }>): void;
  clearRemoved(worktreePath: string): void;
  removed?: ExecutorDeps['removed'];
  /** What the "pull request finished" rule asks the provider with. Absent: the rule never applies. */
  pullRequests?: {
    driverFor(workspace: Workspace): GitProviderDriver | null;
    composeEnv(workspace: Workspace): Promise<NodeJS.ProcessEnv>;
  };
  now(): number;
  sleep?(ms: number): Promise<void>;
}

export interface Evaluation {
  verdict: TreeVerdict;
  facts: TreeFacts;
  inspection: WorktreeInspection | null;
}

export interface SweepOptions {
  /** Only worktrees some session of this workspace uses. */
  workspaceId?: string;
  /** Judge by these rules instead of the stored ones (what turning one on would do). */
  rulesFor?(workspace: Workspace): WorktreeCleanupRules | null;
  /** Ask the provider again even when its answer is still fresh. */
  refreshPullRequests?: boolean;
}

/** How long a pull request's answer counts as fresh. */
export const PULL_REQUEST_FRESH_MS = 15 * 60_000;
/** How long a local sweep may lean on an older answer before treating it as unknown. */
const PULL_REQUEST_STALE_MS = 35 * 60_000;

/**
 * Removing Consola's worktrees when their work is done.
 *
 * One decision function (`policy.judge`) for every caller — the cleanup
 * tools, the sweep, Preview, the delete dialog — and one executor that
 * touches disk, which judges again under the folder's lock first.
 */
export class WorktreeCleanupService {
  private readonly gatherer: FactGatherer;
  private readonly executor: WorktreeExecutor;
  private readonly resolver?: PullRequestResolver;
  private readonly prCache = new Map<
    string,
    { at: number; resolved: ResolvedPullRequest; env: NodeJS.ProcessEnv }
  >();
  /** Sweeps, scans and person-initiated removals run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorktreeCleanupDeps) {
    this.gatherer = new FactGatherer(deps);
    this.executor = new WorktreeExecutor({
      lock: deps.lock,
      gather: (tree, options) => this.gatherer.gather(tree, options),
      usersNow: (tree, options) => this.gatherer.usersNow(tree, options),
      stop: (session) => deps.stop(session),
      processes: deps.processes,
      worktrees: deps.worktrees,
      recordRemoved: (entries) => deps.recordRemoved(entries),
      clearRemoved: (worktreePath) => deps.clearRemoved(worktreePath),
      removed: deps.removed,
      now: () => deps.now(),
      sleep: deps.sleep,
    });
    if (deps.pullRequests) {
      this.resolver = new PullRequestResolver({ ...deps.pullRequests, worktrees: deps.worktrees });
    }
  }

  /** The Consola worktree a folder is, or lies in; null for anything else. */
  public treeOf(dir: string | undefined): string | null {
    return dir ? this.deps.worktrees.managedTreeOf(dir) : null;
  }

  /** Every live session using the tree, in any workspace. */
  public users(tree: string): TreeUser[] {
    return this.gatherer.users(tree);
  }

  /** What would happen to one tree right now. Changes nothing. */
  public async evaluateTree(tree: string, options: GatherOptions): Promise<Evaluation> {
    const { facts, inspection } = await this.gatherer.gather(tree, options);
    return { verdict: judge(facts, options.request), facts, inspection };
  }

  /** Remove one tree, if it still qualifies under the folder's lock. */
  public remove(tree: string, options: GatherOptions): Promise<Execution> {
    return this.executor.remove(tree, options);
  }

  /** Preview: what the rules would remove now, and why everything else stays. */
  public scan(options: SweepOptions = {}): Promise<CleanupPreview> {
    return this.exclusive(async () => {
      const evaluations = await this.evaluateAll(options, false);
      const entries = evaluations.map(({ tree, users, verdict }) => entryFor(tree, users, verdict));
      entries.sort((a, b) => Number(b.decision === 'remove') - Number(a.decision === 'remove'));
      const removable = entries.filter((entry) => entry.decision === 'remove').length;
      return {
        entries,
        removable,
        summary:
          entries.length === 0
            ? 'No session runs in a worktree Consola created.'
            : removable === 0
              ? `Nothing to remove now; ${plural(entries.length, 'worktree')} stay.`
              : `Would remove ${plural(removable, 'worktree')}${entries.length > removable ? `; ${entries.length - removable} stay` : ''}.`,
      };
    });
  }

  /**
   * Apply the rules once: the sweep, and "Clean up now". Only worktrees
   * every session on which lives under a rule that is on are even looked at.
   */
  public sweep(options: SweepOptions = {}): Promise<CleanupReport> {
    return this.exclusive(async () => {
      const evaluations = await this.evaluateAll(options, true);
      const report: CleanupReport = { removed: [], kept: [], failed: [], summary: '' };
      for (const { tree, users, verdict, pullRequests, env } of evaluations) {
        if (verdict.decision === 'keep') {
          report.kept.push(entryFor(tree, users, verdict));
          continue;
        }
        const execution = await this.executor.remove(tree, {
          request: { trigger: 'sweep', targets: new Set(), now: this.deps.now() },
          pullRequests,
          env,
          ...(options.rulesFor ? { rulesFor: options.rulesFor } : {}),
        });
        if (execution.kind === 'removed') {
          report.removed.push(entryFor(tree, users, execution.verdict));
        } else if (execution.kind === 'kept') {
          report.kept.push(entryFor(tree, users, execution.verdict));
        } else {
          report.failed.push({ ...entryFor(tree, users, verdict), error: execution.error });
        }
      }
      const parts = [`Removed ${plural(report.removed.length, 'worktree')}`];
      if (report.failed.length) parts.push(`${report.failed.length} could not be removed`);
      if (report.kept.length) parts.push(`${report.kept.length} kept`);
      report.summary = `${parts.join('; ')}.`;
      return report;
    });
  }

  /**
   * What deleting this session would do to its worktree, under the
   * "you delete the session" rule. Null when that rule is off here, or the
   * session has no Consola worktree: the delete is just a delete.
   */
  public async previewDelete(
    workspace: Workspace,
    session: Session,
  ): Promise<SessionDeletePreview> {
    const rules = this.rulesFor(workspace);
    if (!rules?.sessionDeleted) return { worktree: null };
    if (session.removedWorktree) {
      const branch = await this.removedBranchFate(workspace, session);
      return {
        worktree: branch
          ? `Its worktree was already removed; branch ${branch} will be deleted too.`
          : null,
      };
    }
    const tree = this.treeOf(session.cwd);
    if (!tree) return { worktree: null };
    const { pullRequests, env } = await this.pullRequestOf(workspace, session);
    const { verdict, facts } = await this.evaluateTree(tree, {
      request: { trigger: 'session-deleted', targets: new Set([session.id]), now: this.deps.now() },
      pullRequests,
      env,
    });
    if (verdict.decision === 'keep') {
      return { worktree: `Its worktree stays: ${verdict.blockers[0].detail}.` };
    }
    const branch = facts.disk.branch;
    if (verdict.branch === 'delete-at-head' && branch) {
      return { worktree: `Its worktree and branch ${branch} will be removed too.` };
    }
    return {
      worktree: `Its worktree will be removed too${branch ? `; branch ${branch} stays` : ''}.`,
    };
  }

  /**
   * A person deleting a session. The record always goes, first, exactly as
   * it did before any rule existed (`removeRecord` throws, and nothing else
   * happens, when it cannot). With the rule on, the worktree follows — after
   * the record, in the background, so the delete itself never waits on git
   * — and `settled` hears how that went.
   */
  public async deleteForPerson(
    workspace: Workspace,
    session: Session,
    removeRecord: () => void,
    settled: (outcome: SessionDeleteOutcome) => void,
  ): Promise<SessionDeleteOutcome> {
    const none: SessionDeleteOutcome = { worktree: 'none', branch: 'none' };
    const rules = this.rulesFor(workspace);
    const tree = this.treeOf(session.cwd);
    if (!rules?.sessionDeleted || (!tree && !session.removedWorktree)) {
      removeRecord();
      return none;
    }
    const name = `“${session.name}”`;

    if (session.removedWorktree) {
      const removed = session.removedWorktree;
      const branch = await this.removedBranchFate(workspace, session);
      removeRecord();
      if (!branch) return none;
      const deleted = await this.deps.worktrees.deleteBranchAt(
        removed.mainRepo,
        branch,
        removed.commit,
      );
      return deleted.deleted
        ? { worktree: 'none', branch: 'deleted', message: `Deleted ${name} and branch ${branch}.` }
        : {
            worktree: 'none',
            branch: 'kept',
            message: `Deleted ${name}. Branch ${branch} kept: ${deleted.reason}.`,
          };
    }

    // The session's own state first, before its record is gone: a busy or
    // held session keeps its worktree, deleted or not.
    const request = {
      trigger: 'session-deleted' as const,
      targets: new Set([session.id]),
      now: this.deps.now(),
    };
    const own = userBlockers(this.gatherer.userFactsFor(workspace, session, { request }), request);
    removeRecord();
    if (own.blockers.length > 0) {
      return {
        worktree: 'kept',
        branch: 'none',
        message: `Deleted ${name}. Its worktree stays: ${own.blockers[0].detail}.`,
      };
    }

    void (async () => {
      let outcome: SessionDeleteOutcome;
      try {
        const { pullRequests, env } = await this.pullRequestOf(workspace, session);
        const finished = pullRequests.get(session.id)?.fact.kind === 'finished';
        const execution = await this.executor.remove(tree!, {
          request: { ...request, targets: new Set(), finishedPullRequest: finished },
          pullRequests,
          env,
        });
        outcome = outcomeOf(name, execution);
      } catch (error) {
        outcome = {
          worktree: 'kept',
          branch: 'none',
          message: `Deleted ${name}. Its worktree could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      settled(outcome);
    })();
    return { worktree: 'removing', branch: 'none' };
  }

  /** Whether any workspace has a rule on that removes worktrees on its own. */
  public anySweepRuleOn(rulesFor: (workspace: Workspace) => WorktreeCleanupRules | null): boolean {
    return this.deps.getWorkspaces().some((workspace) => anySweepRuleOn(rulesFor(workspace)));
  }

  private rulesFor(workspace: Workspace): WorktreeCleanupRules | null {
    return this.deps.rules?.rulesFor(workspace) ?? null;
  }

  /** The session's pull request, when the provider can say, and the env it was asked with. */
  private async pullRequestOf(workspace: Workspace, session: Session) {
    const pullRequests = new Map<string, ResolvedPullRequest>();
    if (!this.resolver) return { pullRequests, env: process.env };
    const { pr, env } = await this.resolver.prFor(workspace, session);
    if (pr) {
      pullRequests.set(
        session.id,
        pr.status === 'open'
          ? { fact: { kind: 'open', number: pr.number }, state: pr }
          : { fact: { kind: 'finished', number: pr.number, status: pr.status }, state: pr },
      );
    }
    return { pullRequests, env };
  }

  /**
   * For a session whose worktree a rule already removed: the branch deleting
   * it takes too — only when no other session still names that folder, and
   * only a branch Consola made or one whose pull request is finished.
   */
  private async removedBranchFate(workspace: Workspace, session: Session): Promise<string | null> {
    const removed = session.removedWorktree;
    if (!removed?.branch) return null;
    const shared = this.deps
      .getWorkspaces()
      .some((candidate) =>
        candidate.sessions.some(
          (other) => other.id !== session.id && other.removedWorktree?.path === removed.path,
        ),
      );
    if (shared) return null;
    if (removed.branch.startsWith('consola/')) return removed.branch;
    const { pullRequests } = await this.pullRequestOf(workspace, session).catch(() => ({
      pullRequests: new Map<string, ResolvedPullRequest>(),
    }));
    return pullRequests.get(session.id)?.fact.kind === 'finished' ? removed.branch : null;
  }

  /** Run `work` after everything queued before it. */
  public exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every tree in scope, judged with fresh facts. `sweepOnly` skips trees no rule could touch. */
  private async evaluateAll(options: SweepOptions, sweepOnly: boolean) {
    const rulesFor = options.rulesFor ?? this.deps.rules?.rulesFor ?? (() => null);
    const trees = [...indexTrees(this.deps.getWorkspaces(), (dir) => this.treeOf(dir))].filter(
      ([, users]) =>
        !options.workspaceId || users.some((user) => user.workspace.id === options.workspaceId),
    );
    const candidates = sweepOnly
      ? trees.filter(([, users]) => users.every((user) => anySweepRuleOn(rulesFor(user.workspace))))
      : trees;
    if (candidates.length === 0) return [];

    const wantsPr = candidates.flatMap(([, users]) =>
      users.filter((user) => rulesFor(user.workspace)?.prFinished),
    );
    const resolved = await this.resolvePullRequests(wantsPr, options.refreshPullRequests ?? false);
    let snapshot: ProcessSnapshot | undefined;
    const now = this.deps.now();
    const results: Array<{
      tree: string;
      users: TreeUser[];
      verdict: TreeVerdict;
      pullRequests: Map<string, ResolvedPullRequest>;
      env?: NodeJS.ProcessEnv;
    }> = [];
    for (const [tree, users] of candidates) {
      snapshot ??= await this.deps.processes.snapshot();
      const pullRequests = new Map<string, ResolvedPullRequest>();
      let env: NodeJS.ProcessEnv | undefined;
      for (const user of users) {
        const found = resolved.get(user.session.id);
        if (!found) continue;
        pullRequests.set(user.session.id, found.resolved);
        env ??= found.env;
      }
      const { verdict } = await this.evaluateTree(tree, {
        request: { trigger: 'sweep', targets: new Set(), now },
        pullRequests,
        env,
        processSnapshot: snapshot,
        ...(options.rulesFor ? { rulesFor: options.rulesFor } : {}),
      });
      results.push({ tree, users, verdict, pullRequests, env });
    }
    return results;
  }

  /**
   * Whether each session's pull request is finished: one batched provider
   * call per workspace, answers kept for a while per session. A failed
   * lookup is an unknown, which keeps the worktree.
   */
  private async resolvePullRequests(
    users: TreeUser[],
    refresh: boolean,
  ): Promise<Map<string, { resolved: ResolvedPullRequest; env: NodeJS.ProcessEnv }>> {
    const out = new Map<string, { resolved: ResolvedPullRequest; env: NodeJS.ProcessEnv }>();
    if (!this.resolver || users.length === 0) return out;
    const now = this.deps.now();
    const byWorkspace = new Map<Workspace, TreeUser[]>();
    for (const user of users) {
      const cached = this.prCache.get(user.session.id);
      const age = cached ? now - cached.at : Number.POSITIVE_INFINITY;
      if (cached && age < (refresh ? PULL_REQUEST_FRESH_MS : PULL_REQUEST_STALE_MS)) {
        out.set(user.session.id, cached);
        continue;
      }
      byWorkspace.set(user.workspace, [...(byWorkspace.get(user.workspace) ?? []), user]);
    }
    for (const [workspace, group] of byWorkspace) {
      const attributed = [];
      for (const user of group) {
        const attribution = await this.resolver
          .attribute(workspace, user.session)
          .catch(() => null);
        if (attribution && attribution !== 'no-provider') attributed.push(attribution);
      }
      if (attributed.length === 0) continue;
      try {
        const { env, lookups } = await this.resolver.lookup(
          workspace,
          attributed[0].driver,
          attributed.map((item) => item.query),
        );
        attributed.forEach((item, index) => {
          const judged = judgeLookup(lookups[index]);
          const resolved: ResolvedPullRequest = {
            fact: toFact(judged),
            ...('pr' in judged ? { state: judged.pr } : {}),
          };
          const entry = { at: now, resolved, env };
          this.prCache.set(item.session.id, entry);
          out.set(item.session.id, entry);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const item of attributed) {
          out.set(item.session.id, {
            resolved: { fact: { kind: 'unknown', detail } },
            env: process.env,
          });
        }
      }
    }
    return out;
  }
}

function outcomeOf(name: string, execution: Execution): SessionDeleteOutcome {
  if (execution.kind === 'removed') {
    const branch = execution.inspection.branch;
    return {
      worktree: 'removed',
      branch: execution.branch,
      message:
        execution.branch === 'deleted'
          ? `Deleted ${name}, its worktree and branch ${branch}.`
          : `Deleted ${name} and its worktree${branch ? `; branch ${branch} kept` : ''}.`,
    };
  }
  if (execution.kind === 'kept') {
    return {
      worktree: 'kept',
      branch: 'none',
      message: `Deleted ${name}. Its worktree stays: ${execution.verdict.blockers[0]?.detail ?? 'it changed'}.`,
    };
  }
  return {
    worktree: 'kept',
    branch: 'none',
    message: `Deleted ${name}. Its worktree could not be removed: ${execution.error}`,
  };
}

function entryFor(tree: string, users: TreeUser[], verdict: TreeVerdict): CleanupEntry {
  const sessions = users.map(({ session, workspace }) => ({
    id: session.id,
    name: session.name,
    workspaceId: workspace.id,
  }));
  if (verdict.decision === 'remove') {
    return {
      tree,
      sessions,
      decision: 'remove',
      reason: describeTrigger(verdict.trigger),
      trigger: verdict.trigger,
    };
  }
  const headline = verdict.blockers[0];
  return {
    tree,
    sessions,
    decision: 'keep',
    reason: headline.detail.charAt(0).toUpperCase() + headline.detail.slice(1),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export type { Execution } from './WorktreeExecutor';
export type { GatherOptions, ResolvedPullRequest } from './FactGatherer';

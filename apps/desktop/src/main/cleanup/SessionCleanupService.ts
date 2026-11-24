import type {
  CleanupResult,
  CleanupSkipReason,
  SessionOutcome,
  SessionVerdict,
  StalePreview,
  StalePrStatus,
} from '../../shared/sessionCleanup';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';
import type { Blocker, BlockerKind, CleanupTrigger } from '../../shared/worktreeCleanup';
import { describeError } from '../describeError';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type { PullRequestLookup, PullRequestState } from '../providers/pullRequests';
import type { SessionRemover } from '../SessionRemover';
import { workspacesInScope } from '../tools/Tool';
import type { ToolScope } from '../tools/Tool';
import type { WorktreeService } from '../WorktreeService';
import type { ResolvedPullRequest, WorktreeCleanupService } from '../worktreeCleanup';
import { judge } from '../worktreeCleanup/policy';
import { judgeLookup, PullRequestResolver, toFact } from '../worktreeCleanup/PullRequestResolver';
import type { Attribution } from '../worktreeCleanup/PullRequestResolver';

/**
 * Finding and removing sessions whose pull request is finished, and deleting
 * one session on request — each with the worktree and branch it leaves behind.
 *
 * Reached through Consola's tools: agents over MCP, automations through
 * `consola#cleanup_stale_sessions`. Authority is the caller's `ToolScope`, set
 * by whoever transports the call and never by its arguments.
 *
 * The rules, in the order they are applied:
 *
 * - A session is a candidate only if a PR can be attributed to it
 *   (`PullRequestResolver`): it is linked to one, or it runs in one of
 *   Consola's own worktrees whose branch has one.
 * - The caller, conductors, and sessions that are working or waiting on a
 *   prompt are kept.
 * - The PR must be in one of the requested states, and no PR for that branch
 *   may be open.
 * - Whether the worktree can go is the one decision every cleanup shares
 *   (`worktreeCleanup/policy`): only Consola's own worktrees, never a
 *   workspace folder; nothing uncommitted, unpushed, hidden from `git status`,
 *   ignored with no copy in the main checkout, or in a nested repository; not
 *   locked; no process running in it; no session on it open in a window,
 *   held by an automation run, or active within the last hour. Anything that
 *   cannot be told keeps the session.
 * - A worktree another remaining session still uses stays; only the record
 *   goes. The branch is deleted only with its worktree, and only if it still
 *   points at the commit that was just checked.
 * - The tools always delete the session. They ignore the person's cleanup
 *   rules, but not a session's "Never remove this worktree".
 * - Only rebuildable ignored folders (`node_modules`, `dist`, …) go with the
 *   worktree. The Claude transcript is never touched.
 */

export type { CleanupResult, SessionOutcome, SessionVerdict, StalePreview, StalePrStatus };

export interface StaleOptions {
  prStates: readonly StalePrStatus[];
  /** Only consider these sessions. Unmatched ids are reported, never guessed at. */
  sessionIds?: readonly string[];
}

export interface SessionCleanupDeps {
  getWorkspaces(): Workspace[];
  status(instanceId: string): TerminalStatus;
  /** The workspace's provider driver, or null when it has none this build can use. */
  driverFor(workspace: Workspace): GitProviderDriver | null;
  /** Login env plus the workspace account's token, composed in main. */
  composeEnv(workspace: Workspace): Promise<NodeJS.ProcessEnv>;
  worktrees: Pick<WorktreeService, 'isManagedPath' | 'inspect'>;
  cleanup: Pick<WorktreeCleanupService, 'treeOf' | 'evaluateTree' | 'remove'>;
  remover: Pick<SessionRemover, 'stop' | 'remove'>;
  now?(): number;
}

/** A session on its way out, with what executing that needs. */
interface Removal {
  workspace: Workspace;
  session: Session;
  verdict: SessionVerdict;
  /** The Consola worktree it uses, present exactly when that is to be removed. */
  tree?: string;
  pullRequest?: ResolvedPullRequest;
  env?: NodeJS.ProcessEnv;
}

const BUSY: ReadonlySet<TerminalStatus> = new Set(['working', 'needs-attention']);

export class SessionCleanupService {
  /**
   * Runs are serialised: two cleanups interleaving over one worktree (an
   * automation firing while an agent cleans up) could each act on the
   * other's half-finished state.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly resolver: PullRequestResolver;

  constructor(private readonly deps: SessionCleanupDeps) {
    this.resolver = new PullRequestResolver(deps);
  }

  /** What a cleanup would do right now, changing nothing. */
  public previewStale(scope: ToolScope, options: StaleOptions): Promise<StalePreview> {
    return this.exclusive(async () => {
      const plan = await this.plan(scope, options);
      const candidates = plan.removals.map((removal) => removal.verdict);
      return {
        candidates,
        skipped: plan.skipped,
        unknownSessionIds: plan.unknownSessionIds,
        summary: previewSummary(candidates.length, plan.skipped.length),
      };
    });
  }

  /**
   * Plan and act in one step, every rule checked against the state of
   * things now. To act on exactly what a preview showed, pass its
   * candidates as `sessionIds`.
   */
  public cleanupStale(scope: ToolScope, options: StaleOptions): Promise<CleanupResult> {
    return this.exclusive(async () => {
      const plan = await this.plan(scope, options);
      const { removed, failed, nowBusy } = await this.execute(plan.removals, 'tool-stale');
      const skipped = [...plan.skipped, ...nowBusy];
      return {
        removed,
        failed,
        skipped,
        unknownSessionIds: plan.unknownSessionIds,
        summary: resultSummary(removed.length, failed.length, skipped.length),
      };
    });
  }

  /**
   * Delete one session the caller names, whatever its PR says. Its worktree
   * and branch go too, but only under the same rules as a cleanup; when
   * they cannot, the record still goes and the outcome says what stayed.
   */
  public deleteSession(scope: ToolScope, sessionId: string): Promise<SessionOutcome> {
    return this.exclusive(async () => {
      const removal = await this.planDelete(scope, sessionId);
      const { removed, failed, nowBusy } = await this.execute([removal], 'tool-delete');
      if (failed.length > 0) throw new Error(failed[0].error ?? 'Delete failed.');
      if (nowBusy.length > 0)
        throw new Error(`"${removal.session.name}" became busy; it was not deleted.`);
      return removed[0];
    });
  }

  /**
   * What deleting one session would do right now, changing nothing —
   * refusing exactly what `deleteSession` would refuse. The plan a person
   * approves when an agent asks for the delete.
   */
  public previewDelete(scope: ToolScope, sessionId: string): Promise<StalePreview> {
    return this.exclusive(async () => {
      const { verdict } = await this.planDelete(scope, sessionId);
      return {
        candidates: [verdict],
        skipped: [],
        unknownSessionIds: [],
        summary: `Would delete "${verdict.sessionName}"${verdict.worktree?.remove ? ' and its worktree' : ''}.`,
      };
    });
  }

  /** The checks a delete must pass, and what it would do on disk. */
  private async planDelete(scope: ToolScope, sessionId: string): Promise<Removal> {
    const located = workspacesInScope(this.deps.getWorkspaces(), scope)
      .flatMap((workspace) => workspace.sessions.map((session) => ({ workspace, session })))
      .find(({ session }) => session.id === sessionId);
    if (!located) throw new Error(`No session ${sessionId} in the workspaces you can act on.`);
    const { workspace, session } = located;
    if (scope.excludeSessionIds.includes(session.id)) {
      throw new Error('A session cannot delete itself.');
    }
    if (session.kind === 'conductor') {
      throw new Error('Conductors are deleted from the sidebar, together with their group.');
    }
    const status = this.deps.status(session.instanceId);
    if (BUSY.has(status)) {
      throw new Error(`"${session.name}" is ${status}; wait until it is idle, then delete it.`);
    }

    const removal: Removal = { workspace, session, verdict: verdictFor(workspace, session) };
    const tree = this.deps.cleanup.treeOf(session.cwd);
    if (!tree) return removal;
    const { pr, env } = await this.resolver.prFor(workspace, session);
    removal.env = env;
    if (pr) removal.pullRequest = resolvedFrom(pr);
    const { verdict, facts } = await this.deps.cleanup.evaluateTree(tree, {
      request: { trigger: 'tool-delete', targets: new Set([session.id]), now: this.now() },
      pullRequests: pullRequestsOf([removal]),
      env,
    });
    if (verdict.decision === 'remove') {
      markForRemoval(removal, tree, facts.disk.branch ?? null);
    } else {
      removal.verdict.worktree = {
        path: tree,
        remove: false,
        keptBecause: verdict.blockers[0].detail,
      };
    }
    return removal;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async plan(
    scope: ToolScope,
    options: StaleOptions,
  ): Promise<{ removals: Removal[]; skipped: SessionVerdict[]; unknownSessionIds: string[] }> {
    const { attributed, skipped, unknownSessionIds } = await this.collectCandidates(scope, options);
    const decided: Removal[] = [];
    for (const [workspace, group] of groupByWorkspace(attributed)) {
      let found: { env: NodeJS.ProcessEnv; lookups: PullRequestLookup[] };
      try {
        found = await this.resolver.lookup(
          workspace,
          group[0].driver,
          group.map((item) => item.query),
        );
      } catch (error) {
        for (const item of group) {
          skipped.push(skip(workspace, item.session, 'lookup-failed', describeError(error)));
        }
        continue;
      }
      for (let index = 0; index < group.length; index++) {
        const result = await this.decide(group[index], found.lookups[index], options, found.env);
        if ('skip' in result) skipped.push(result.skip);
        else decided.push(result.removal);
      }
    }
    const removals = await this.judgeTrees(decided, skipped);
    return { removals, skipped, unknownSessionIds };
  }

  /** Every session a PR could explain, minus those kept outright; the rest are skipped with a reason. */
  private async collectCandidates(scope: ToolScope, options: StaleOptions) {
    const requested = options.sessionIds ? new Set(options.sessionIds) : null;
    const attributed: Attribution[] = [];
    const skipped: SessionVerdict[] = [];
    const seen = new Set<string>();

    for (const workspace of workspacesInScope(this.deps.getWorkspaces(), scope)) {
      for (const session of workspace.sessions) {
        if (requested && !requested.has(session.id)) continue;
        seen.add(session.id);
        const attribution = await this.resolver.attribute(workspace, session);
        const status = this.deps.status(session.instanceId);
        if (attribution === 'no-provider') {
          skipped.push(
            skip(
              workspace,
              session,
              'no-provider',
              'This workspace has no provider that can report pull request state.',
            ),
          );
        } else if (!attribution) {
          if (requested)
            skipped.push(
              skip(
                workspace,
                session,
                'not-linked',
                'No pull request is linked to this session or its worktree branch.',
              ),
            );
        } else if (scope.excludeSessionIds.includes(session.id)) {
          skipped.push(skip(workspace, session, 'caller', 'This is the session that asked.'));
        } else if (session.kind === 'conductor') {
          skipped.push(skip(workspace, session, 'conductor'));
        } else if (BUSY.has(status)) {
          skipped.push(skip(workspace, session, 'busy', `The session is ${status}.`));
        } else {
          attributed.push(attribution);
        }
      }
    }
    const unknownSessionIds = requested ? [...requested].filter((id) => !seen.has(id)) : [];
    return { attributed, skipped, unknownSessionIds };
  }

  /** The PR's verdict on one session, and the tree it would take with it. */
  private async decide(
    attribution: Attribution,
    lookup: PullRequestLookup,
    options: StaleOptions,
    env: NodeJS.ProcessEnv,
  ): Promise<{ removal: Removal } | { skip: SessionVerdict }> {
    const { workspace, session, query } = attribution;
    const kept = (reason: CleanupSkipReason, detail: string, pr?: PullRequestState) => ({
      skip: {
        ...skip(workspace, session, reason, detail),
        ...(pr ? { pullRequest: summarise(query.repo, pr) } : {}),
      },
    });

    const judged = judgeLookup(lookup);
    if (judged.kind === 'failed') return kept('lookup-failed', judged.error);
    if (judged.kind === 'none')
      return kept('no-pr', `No pull request has ${describeQuery(query)}.`);
    if (judged.kind === 'open')
      return kept('pr-open', `#${judged.pr.number} is still open.`, judged.pr);
    const pr = judged.pr;
    if (!options.prStates.includes(pr.status as StalePrStatus)) {
      return kept('pr-state-excluded', `#${pr.number} is ${pr.status}.`, pr);
    }

    const removal: Removal = {
      workspace,
      session,
      verdict: { ...verdictFor(workspace, session), pullRequest: summarise(query.repo, pr) },
      pullRequest: { fact: toFact(judged), state: pr },
      env,
    };
    if (!session.cwd) {
      return kept(
        'not-managed-worktree',
        'It runs in its scope folder, which cleanup never touches.',
        pr,
      );
    }
    const exists = attribution.inspection ?? (await this.deps.worktrees.inspect(session.cwd));
    if (!exists) {
      // Linked to a finished PR and nothing left on disk: the record is
      // all there is to remove.
      removal.verdict.detail = 'Its worktree is already gone.';
      return { removal };
    }
    const tree = this.deps.cleanup.treeOf(session.cwd);
    if (!tree) return kept('not-managed-worktree', 'It is not a worktree Consola created.', pr);
    removal.tree = tree;
    return { removal };
  }

  /**
   * Judge each tree once, with every candidate on it. A candidate whose own
   * state keeps the tree (open in a window, recently active, held) is
   * skipped, and the tree judged again without it: its neighbours may still
   * go, leaving the worktree to it.
   */
  private async judgeTrees(decided: Removal[], skipped: SessionVerdict[]): Promise<Removal[]> {
    const removals: Removal[] = [];
    const byTree = new Map<string, Removal[]>();
    for (const removal of decided) {
      if (!removal.tree) {
        removals.push(removal);
        continue;
      }
      byTree.set(removal.tree, [...(byTree.get(removal.tree) ?? []), removal]);
    }

    for (const [tree, group] of byTree) {
      const now = this.now();
      const request = {
        trigger: 'tool-stale' as const,
        targets: new Set(group.map((removal) => removal.session.id)),
        now,
      };
      const { facts } = await this.deps.cleanup.evaluateTree(tree, {
        request,
        pullRequests: pullRequestsOf(group),
        env: group[0].env,
        thorough: true,
      });
      let verdict = judge(facts, request);
      const remaining: Removal[] = [];
      for (const removal of group) {
        const own =
          verdict.decision === 'keep'
            ? verdict.blockers.find(
                (blocker) => blocker.sessionId === removal.session.id && blocker.kind !== 'shared',
              )
            : undefined;
        if (own) skipped.push(keptVerdict(removal, own));
        else remaining.push(removal);
      }
      if (remaining.length === 0) continue;
      if (remaining.length < group.length) {
        verdict = judge(facts, {
          ...request,
          targets: new Set(remaining.map((removal) => removal.session.id)),
        });
      }

      if (verdict.decision === 'remove') {
        for (const removal of remaining) markForRemoval(removal, tree, facts.disk.branch ?? null);
        removals.push(...remaining);
      } else if (verdict.blockers.every((blocker) => blocker.kind === 'shared')) {
        for (const removal of remaining) {
          delete removal.tree;
          removal.verdict.worktree = {
            path: tree,
            remove: false,
            keptBecause: verdict.blockers[0].detail,
          };
        }
        removals.push(...remaining);
      } else {
        const headline =
          verdict.blockers.find((blocker) => blocker.kind !== 'shared') ?? verdict.blockers[0];
        for (const removal of remaining) skipped.push(keptVerdict(removal, headline));
      }
    }
    return removals;
  }

  /**
   * Remove trees, then records — so a worktree never disappears under a live
   * agent, and a worktree git refuses to remove keeps its session (resumable
   * with its conversation intact).
   */
  private async execute(
    planned: Removal[],
    trigger: Extract<CleanupTrigger, 'tool-stale' | 'tool-delete'>,
  ): Promise<{
    removed: SessionOutcome[];
    failed: SessionOutcome[];
    nowBusy: SessionVerdict[];
  }> {
    // The plan may be seconds old; a session someone started typing into
    // since then is no longer ours to remove.
    const nowBusy: SessionVerdict[] = [];
    const acting: Removal[] = [];
    for (const removal of planned) {
      const status = this.deps.status(removal.session.instanceId);
      if (BUSY.has(status)) {
        nowBusy.push({
          ...removal.verdict,
          reason: 'busy',
          detail: `The session became ${status}.`,
        });
      } else {
        acting.push(removal);
      }
    }

    const steps = acting.map((removal) => ({ removal, outcome: outcomeFor(removal) }));
    const byTree = new Map<string, typeof steps>();
    for (const step of steps) {
      if (!step.removal.tree) continue;
      byTree.set(step.removal.tree, [...(byTree.get(step.removal.tree) ?? []), step]);
    }

    const backedOut = new Set<string>();
    for (const [tree, group] of byTree) {
      const execution = await this.deps.cleanup.remove(tree, {
        request: {
          trigger,
          targets: new Set(group.map(({ removal }) => removal.session.id)),
          now: this.now(),
        },
        pullRequests: pullRequestsOf(group.map(({ removal }) => removal)),
        env: group[0].removal.env,
      });
      for (const { removal, outcome } of group) {
        if (execution.kind === 'removed') {
          outcome.worktree = 'removed';
          outcome.branch = execution.branch;
          outcome.notes.push(...execution.notes);
        } else if (execution.kind === 'failed') {
          outcome.error = `Worktree not removed, session kept: ${execution.error}`;
        } else if (execution.verdict.blockers.every((blocker) => blocker.kind === 'shared')) {
          outcome.worktree = 'kept';
          outcome.notes.unshift(`Worktree kept: ${execution.verdict.blockers[0].detail}.`);
        } else if (trigger === 'tool-delete') {
          // An explicit delete still deletes; only the worktree stays.
          const headline = execution.verdict.blockers[0];
          outcome.worktree = 'kept';
          outcome.notes.unshift(`Worktree kept: ${headline.detail}.`);
        } else {
          // Something changed since the plan: the session is kept with its worktree.
          const headline =
            execution.verdict.blockers.find((blocker) => blocker.kind !== 'shared') ??
            execution.verdict.blockers[0];
          nowBusy.push(keptVerdict(removal, headline));
          backedOut.add(removal.session.id);
        }
      }
    }

    const removed: SessionOutcome[] = [];
    const failed: SessionOutcome[] = [];
    for (const { removal, outcome } of steps) {
      if (backedOut.has(removal.session.id)) continue;
      if (!outcome.error) {
        try {
          this.deps.remover.remove(removal.workspace.id, removal.session);
        } catch (error) {
          outcome.error = `Session record not deleted: ${describeError(error)}`;
        }
      }
      (outcome.error ? failed : removed).push(outcome);
    }
    return { removed, failed, nowBusy };
  }
}

/** The closed set of reasons the tools report, from the shared decision's richer one. */
export function skipReasonFor(kind: BlockerKind): CleanupSkipReason {
  switch (kind) {
    case 'busy':
    case 'shown':
    case 'held':
    case 'recent':
    case 'recently-prepared':
    case 'process':
      return 'busy';
    case 'dirty':
    case 'ignored-files':
    case 'hidden-changes':
      return 'dirty';
    case 'unpublished':
      return 'local-commits';
    case 'conductor':
      return 'conductor';
    case 'not-managed':
    case 'scope-folder':
    case 'opted-out':
      return 'not-managed-worktree';
    default:
      return 'unverifiable';
  }
}

function keptVerdict(removal: Removal, blocker: Blocker): SessionVerdict {
  return {
    ...removal.verdict,
    reason: skipReasonFor(blocker.kind),
    detail: capitalise(blocker.detail),
  };
}

function resolvedFrom(pr: PullRequestState): ResolvedPullRequest {
  return pr.status === 'open'
    ? { fact: { kind: 'open', number: pr.number }, state: pr }
    : { fact: { kind: 'finished', number: pr.number, status: pr.status }, state: pr };
}

function pullRequestsOf(removals: Removal[]): Map<string, ResolvedPullRequest> {
  const map = new Map<string, ResolvedPullRequest>();
  for (const removal of removals) {
    if (removal.pullRequest) map.set(removal.session.id, removal.pullRequest);
  }
  return map;
}

function verdictFor(workspace: Workspace, session: Session): SessionVerdict {
  return {
    sessionId: session.id,
    sessionName: session.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
}

function skip(
  workspace: Workspace,
  session: Session,
  reason: CleanupSkipReason,
  detail?: string,
): SessionVerdict {
  return { ...verdictFor(workspace, session), reason, ...(detail ? { detail } : {}) };
}

function markForRemoval(removal: Removal, tree: string, branch: string | null): void {
  removal.tree = tree;
  removal.verdict.worktree = { path: tree, remove: true };
  if (branch) removal.verdict.branch = branch;
}

function outcomeFor(removal: Removal): SessionOutcome {
  const { verdict } = removal;
  const notes: string[] = [];
  if (verdict.worktree?.keptBecause) notes.push(`Worktree kept: ${verdict.worktree.keptBecause}.`);
  if (verdict.detail) notes.push(verdict.detail);
  return {
    sessionId: verdict.sessionId,
    sessionName: verdict.sessionName,
    workspaceName: verdict.workspaceName,
    ...(verdict.pullRequest ? { pullRequest: verdict.pullRequest } : {}),
    worktree: verdict.worktree ? 'kept' : 'none',
    branch: 'none',
    notes,
  };
}

function summarise(repo: string, pr: PullRequestState) {
  return { repo, number: pr.number, status: pr.status, url: pr.url };
}

function groupByWorkspace(items: Attribution[]): Map<Workspace, Attribution[]> {
  const groups = new Map<Workspace, Attribution[]>();
  for (const item of items) {
    const group = groups.get(item.workspace) ?? [];
    group.push(item);
    groups.set(item.workspace, group);
  }
  return groups;
}

function describeQuery(query: Attribution['query']): string {
  return 'number' in query
    ? `number ${query.number} in ${query.repo}`
    : `head branch ${query.headBranch} in ${query.repo}`;
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function previewSummary(candidates: number, skipped: number): string {
  if (candidates === 0) {
    return skipped === 0
      ? 'No sessions with finished pull requests.'
      : `Nothing to remove; ${plural(skipped, 'session')} kept.`;
  }
  return `Would remove ${plural(candidates, 'session')}${skipped ? `; ${skipped} kept` : ''}.`;
}

function resultSummary(removed: number, failed: number, skipped: number): string {
  const parts = [`Removed ${plural(removed, 'session')}`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} kept`);
  return `${parts.join('; ')}.`;
}

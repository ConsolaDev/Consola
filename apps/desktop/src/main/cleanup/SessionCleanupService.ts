import * as fs from 'fs';
import * as path from 'path';
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
import { describeError } from '../describeError';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type { PullRequestLookup, PullRequestQuery, PullRequestState } from '../providers/pullRequests';
import type { SessionRemover } from '../SessionRemover';
import { workspacesInScope, type ToolScope } from '../tools/Tool';
import type { WorktreeInspection, WorktreeService } from '../WorktreeService';

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
 * - A session is a candidate only if a PR can be attributed to it: it is
 *   linked to one, or it runs in one of Consola's own worktrees whose branch
 *   has one. A branch is never read from a scope folder — whatever that
 *   checkout has on it now says nothing about why the session exists.
 * - The caller, conductors, and sessions that are working or waiting on a
 *   prompt are kept.
 * - The PR must be in one of the requested states, and no PR for that branch
 *   may be open.
 * - Disk is touched only for a Consola worktree (a direct child of the
 *   worktree root, by real path; never a clone's own checkout, never a folder
 *   that is, or holds, a workspace scope) that is clean and holds no commit
 *   missing from the PR's final head. Anything else keeps the whole session.
 * - A worktree another remaining session still uses stays; only the record
 *   goes. The branch is deleted only with its worktree, and only if it still
 *   points at the commit that was just checked.
 * - Ignored files (build output, dependencies, local env files) go with the
 *   worktree: git does not count them as changes. The Claude transcript is
 *   never touched.
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
    worktrees: Pick<
        WorktreeService,
        'isManagedPath' | 'inspect' | 'commitsArePublished' | 'removeWorktree' | 'deleteBranchAt'
    >;
    remover: Pick<SessionRemover, 'stop' | 'remove'>;
}

/** A session on its way out, with what executing that needs. */
interface Removal {
    workspace: Workspace;
    session: Session;
    verdict: SessionVerdict;
    /** Present exactly when the worktree is to be removed. */
    inspection?: WorktreeInspection;
}

interface Attribution {
    workspace: Workspace;
    session: Session;
    driver: GitProviderDriver;
    query: PullRequestQuery;
    /** Already inspected when the PR was found through the worktree's branch. */
    inspection?: WorktreeInspection;
}

interface Blocker {
    reason: CleanupSkipReason;
    detail: string;
}

const BUSY: ReadonlySet<TerminalStatus> = new Set(['working', 'needs-attention']);

export class SessionCleanupService {
    /**
     * Runs are serialised: two cleanups interleaving over one worktree (an
     * automation firing while an agent cleans up) could each act on the
     * other's half-finished state.
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: SessionCleanupDeps) {}

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
            const { removed, failed, nowBusy } = await this.execute(plan.removals);
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
            if (session.cwd && this.deps.worktrees.isManagedPath(session.cwd)) {
                const inspection = await this.deps.worktrees.inspect(session.cwd);
                if (inspection) {
                    const { pr, env } = await this.prFor(workspace, session);
                    const blocker = await this.checkWorktree(inspection, pr, env);
                    if (blocker) {
                        removal.verdict.worktree = { path: inspection.toplevel, remove: false, keptBecause: blocker.detail };
                    } else {
                        markForRemoval(removal, inspection);
                    }
                }
            }
            const { removed, failed, nowBusy } = await this.execute([removal]);
            if (failed.length > 0) throw new Error(failed[0].error ?? 'Delete failed.');
            if (nowBusy.length > 0) throw new Error(`"${session.name}" became busy; it was not deleted.`);
            return removed[0];
        });
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async plan(
        scope: ToolScope,
        options: StaleOptions
    ): Promise<{ removals: Removal[]; skipped: SessionVerdict[]; unknownSessionIds: string[] }> {
        const { attributed, skipped, unknownSessionIds } = await this.collectCandidates(scope, options);
        const removals: Removal[] = [];
        for (const [workspace, group] of groupByWorkspace(attributed)) {
            let found: { env: NodeJS.ProcessEnv; lookups: PullRequestLookup[] };
            try {
                found = await this.lookup(workspace, group[0].driver, group.map((item) => item.query));
            } catch (error) {
                for (const item of group) {
                    skipped.push(skip(workspace, item.session, 'lookup-failed', describeError(error)));
                }
                continue;
            }
            for (let index = 0; index < group.length; index++) {
                const decided = await this.decide(group[index], found.lookups[index], options, found.env);
                if ('skip' in decided) skipped.push(decided.skip);
                else removals.push(decided.removal);
            }
        }
        this.applySharing(removals);
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
                const attribution = await this.attribute(workspace, session);
                const status = this.deps.status(session.instanceId);
                if (attribution === 'no-provider') {
                    skipped.push(skip(workspace, session, 'no-provider', 'This workspace has no provider that can report pull request state.'));
                } else if (!attribution) {
                    if (requested) skipped.push(skip(workspace, session, 'not-linked', 'No pull request is linked to this session or its worktree branch.'));
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

    /**
     * Which PR could explain this session: the one it is linked to, else the
     * one its Consola worktree's branch was pushed for. Null when neither
     * applies — the session is simply not a cleanup candidate.
     */
    private async attribute(
        workspace: Workspace,
        session: Session
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
        if (!inspection?.isLinkedWorktree || !inspection.remoteBranch || !inspection.originUrl) return null;
        const repo = driver.repoOfRemote?.(inspection.originUrl);
        if (!repo) return null;
        return { workspace, session, driver, query: { repo, headBranch: inspection.remoteBranch }, inspection };
    }

    /** One batched provider call for a workspace, with the env it ran under. Throws as a whole. */
    private async lookup(workspace: Workspace, driver: GitProviderDriver, queries: PullRequestQuery[]) {
        const env = await this.deps.composeEnv(workspace);
        const lookups = await driver.lookupPullRequests!(queries, env);
        return { env, lookups };
    }

    private async decide(
        attribution: Attribution,
        lookup: PullRequestLookup,
        options: StaleOptions,
        env: NodeJS.ProcessEnv
    ): Promise<{ removal: Removal } | { skip: SessionVerdict }> {
        const { workspace, session, query } = attribution;
        const kept = (reason: CleanupSkipReason, detail: string, pr?: PullRequestState) => ({
            skip: { ...skip(workspace, session, reason, detail), ...(pr ? { pullRequest: summarise(query.repo, pr) } : {}) },
        });

        if (lookup.error) return kept('lookup-failed', lookup.error);
        const open = lookup.pullRequests.find((pr) => pr.status === 'open');
        const pr = open ?? lookup.pullRequests[0];
        if (!pr) return kept('no-pr', `No pull request has ${describeQuery(query)}.`);
        if (open) return kept('pr-open', `#${open.number} is still open.`, open);
        if (!options.prStates.includes(pr.status as StalePrStatus)) {
            return kept('pr-state-excluded', `#${pr.number} is ${pr.status}.`, pr);
        }

        const removal: Removal = {
            workspace,
            session,
            verdict: { ...verdictFor(workspace, session), pullRequest: summarise(query.repo, pr) },
        };
        let inspection = attribution.inspection;
        if (!inspection) {
            if (!session.cwd) {
                return kept('not-managed-worktree', 'It runs in its scope folder, which cleanup never touches.', pr);
            }
            const found = await this.deps.worktrees.inspect(session.cwd);
            if (!found) {
                // Linked to a finished PR and nothing left on disk: the
                // record is all there is to remove.
                removal.verdict.detail = 'Its worktree is already gone.';
                return { removal };
            }
            inspection = found;
        }

        const blocker = await this.checkWorktree(inspection, pr, env);
        if (blocker) return kept(blocker.reason, blocker.detail, pr);
        markForRemoval(removal, inspection);
        return { removal };
    }

    /**
     * Why this checkout must stay, or null when removing it can lose nothing:
     * it is one of Consola's own worktrees and no workspace folder, it is
     * clean, and every commit on it exists elsewhere — in the PR's final head
     * when there is a PR, else on a remote-tracking ref.
     */
    private async checkWorktree(
        inspection: WorktreeInspection,
        pr: PullRequestState | null,
        env: NodeJS.ProcessEnv
    ): Promise<Blocker | null> {
        const where = inspection.toplevel;
        if (!inspection.isLinkedWorktree || !this.deps.worktrees.isManagedPath(where)) {
            return { reason: 'not-managed-worktree', detail: `${where} is not a Consola worktree` };
        }
        const scope = this.scopeWithin(where);
        if (scope) {
            return { reason: 'not-managed-worktree', detail: `${where} holds the workspace folder "${scope}"` };
        }
        if (inspection.dirty) return { reason: 'dirty', detail: `${where} has uncommitted changes` };
        const published = await this.deps.worktrees.commitsArePublished(
            inspection,
            pr ? { knownHead: pr.headOid, fetchRef: pr.fetchRef } : {},
            env
        );
        if (published === 'local-commits') {
            return {
                reason: 'local-commits',
                detail: pr ? `${where} has commits that are not in #${pr.number}` : `${where} has commits that exist only locally`,
            };
        }
        if (published === 'unverifiable') {
            return { reason: 'unverifiable', detail: `${where} has commits that could not be confirmed as pushed` };
        }
        return null;
    }

    /** For an explicit delete: the session's PR, if one can be found, and the env to fetch it with. */
    private async prFor(
        workspace: Workspace,
        session: Session
    ): Promise<{ pr: PullRequestState | null; env: NodeJS.ProcessEnv }> {
        try {
            const attribution = await this.attribute(workspace, session);
            if (attribution && attribution !== 'no-provider') {
                const { env, lookups } = await this.lookup(workspace, attribution.driver, [attribution.query]);
                return { pr: lookups[0]?.pullRequests[0] ?? null, env };
            }
            if (workspace.provider) return { pr: null, env: await this.deps.composeEnv(workspace) };
        } catch {
            // No PR to compare with: "pushed to a remote" decides instead.
        }
        return { pr: null, env: process.env };
    }

    /** The name of a scope that is this directory or lies inside it, in any workspace. */
    private scopeWithin(dir: string): string | null {
        for (const workspace of this.deps.getWorkspaces()) {
            for (const scope of workspace.scopes) {
                if (isWithin(realpathOr(scope.path), dir)) return scope.name;
            }
        }
        return null;
    }

    /**
     * A worktree is removed only when every session using it is being removed
     * too. Recomputed right before acting, after any session turned busy.
     */
    private applySharing(removals: Removal[]): void {
        const removing = new Set(removals.map((removal) => removal.session.id));
        const everyone = this.deps.getWorkspaces().flatMap((workspace) => workspace.sessions);
        for (const removal of removals) {
            const worktree = removal.verdict.worktree;
            if (!worktree?.remove) continue;
            const blocker = everyone.find(
                (other) => !removing.has(other.id) && !!other.cwd && isWithin(realpathOr(other.cwd), worktree.path)
            );
            if (blocker) {
                worktree.remove = false;
                worktree.keptBecause = `"${blocker.name}" still uses it`;
                delete removal.verdict.branch;
                delete removal.inspection;
            }
        }
    }

    /**
     * Stop, remove from disk, delete records — in that order, so a worktree
     * never disappears under a live agent, and a worktree git refuses to
     * remove keeps its session (resumable with its conversation intact).
     */
    private async execute(planned: Removal[]): Promise<{
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
                nowBusy.push({ ...removal.verdict, reason: 'busy', detail: `The session became ${status}.` });
            } else {
                acting.push(removal);
            }
        }
        this.applySharing(acting);

        const steps = acting.map((removal) => ({ removal, outcome: outcomeFor(removal) }));
        for (const { removal } of steps) this.deps.remover.stop(removal.session);

        const treeRemovals = new Map<string, Promise<void>>();
        for (const { removal, outcome } of steps) {
            if (!removal.inspection) continue;
            await this.removeOnDisk(removal, removal.inspection, outcome, treeRemovals);
        }

        const removed: SessionOutcome[] = [];
        const failed: SessionOutcome[] = [];
        for (const { removal, outcome } of steps) {
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

    /** The worktree (once, however many sessions share it), then the branch. */
    private async removeOnDisk(
        removal: Removal,
        inspection: WorktreeInspection,
        outcome: SessionOutcome,
        treeRemovals: Map<string, Promise<void>>
    ): Promise<void> {
        const tree = inspection.toplevel;
        if (!treeRemovals.has(tree)) treeRemovals.set(tree, this.deps.worktrees.removeWorktree(inspection));
        try {
            await treeRemovals.get(tree);
        } catch (error) {
            outcome.error = `Worktree not removed, session kept: ${describeError(error)}`;
            return;
        }
        outcome.worktree = 'removed';
        const branch = removal.verdict.branch;
        if (!branch) return;
        const deleted = await this.deps.worktrees.deleteBranchAt(inspection.mainRepo, branch, inspection.head);
        outcome.branch = deleted.deleted ? 'deleted' : 'kept';
        if (!deleted.deleted) outcome.notes.push(`Branch kept: ${deleted.reason}.`);
    }
}

function verdictFor(workspace: Workspace, session: Session): SessionVerdict {
    return {
        sessionId: session.id,
        sessionName: session.name,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
    };
}

function skip(workspace: Workspace, session: Session, reason: CleanupSkipReason, detail?: string): SessionVerdict {
    return { ...verdictFor(workspace, session), reason, ...(detail ? { detail } : {}) };
}

function markForRemoval(removal: Removal, inspection: WorktreeInspection): void {
    removal.verdict.worktree = { path: inspection.toplevel, remove: true };
    if (inspection.branch) removal.verdict.branch = inspection.branch;
    removal.inspection = inspection;
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

function realpathOr(target: string): string {
    try {
        return fs.realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

/** Whether `child` is `parent` or lies below it. Both already resolved. */
function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function describeQuery(query: PullRequestQuery): string {
    return 'number' in query ? `number ${query.number} in ${query.repo}` : `head branch ${query.headBranch} in ${query.repo}`;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function previewSummary(candidates: number, skipped: number): string {
    if (candidates === 0) {
        return skipped === 0 ? 'No sessions with finished pull requests.' : `Nothing to remove; ${plural(skipped, 'session')} kept.`;
    }
    return `Would remove ${plural(candidates, 'session')}${skipped ? `; ${skipped} kept` : ''}.`;
}

function resultSummary(removed: number, failed: number, skipped: number): string {
    const parts = [`Removed ${plural(removed, 'session')}`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} kept`);
    return `${parts.join('; ')}.`;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';
import type { WorktreeCleanupRules } from '../../shared/worktreeCleanup';
import type { PullRequestState } from '../providers/pullRequests';
import type { WorktreeInspection, WorktreeService } from '../WorktreeService';
import type { PathLock } from './PathLock';
import {
  type DiskFacts,
  type JudgeRequest,
  type PullRequestFact,
  type TreeFacts,
  treeBlockers,
  type UserFacts,
  userBlockers,
} from './policy';
import { ProcessCwdIndex, type ProcessSnapshot } from './ProcessCwdIndex';
import type { TreeUser } from './TreeIndex';

/** What the sweep's rules read about a session, beyond what every caller reads. */
export interface RuleSources {
  /** The workspace's effective rules; null when cleanup is off there. */
  rulesFor(workspace: Workspace): WorktreeCleanupRules | null;
  /** When the session went onto the Settled shelf, if it reads settled now. */
  settledAt(session: Session): number | null;
  /** For a session an automation started: when its run ended, null while it is open. */
  runEndedAt(session: Session): number | null | undefined;
}

export interface FactSources {
  getWorkspaces(): Workspace[];
  status(instanceId: string): TerminalStatus;
  /** Whether any window is showing the session, focused or not. */
  isShown(instanceId: string): boolean;
  /** Sessions an open or pending automation run holds. */
  heldSessionIds(): ReadonlySet<string>;
  /** Real activity, from the attention ledger. */
  lastActiveAt(session: Session): number;
  /**
   * The processes Consola itself runs for these sessions: each agent CLI,
   * excused with what it started, and each shell, excused alone — a job the
   * person started in it is theirs, and keeps the folder.
   */
  ownProcessIds(sessions: readonly Session[]): { agents: Set<number>; shells: Set<number> };
  worktrees: Pick<
    WorktreeService,
    | 'managedTreeOf'
    | 'inspect'
    | 'commitsArePublished'
    | 'ignoredAtRisk'
    | 'nestedRepos'
    | 'hiddenChanges'
    | 'isLocked'
  >;
  processes: Pick<ProcessCwdIndex, 'snapshot'>;
  lock: Pick<PathLock, 'recentlyPrepared'>;
  rules?: RuleSources;
}

/** A pull request a caller already resolved for a session. */
export interface ResolvedPullRequest {
  fact: PullRequestFact;
  /** The provider's record, for a finished PR: its final head decides what is published. */
  state?: PullRequestState;
}

export interface GatherOptions {
  request: JudgeRequest;
  /** Rules to judge by instead of the stored ones: what turning a rule on would do. */
  rulesFor?(workspace: Workspace): WorktreeCleanupRules | null;
  pullRequests?: ReadonlyMap<string, ResolvedPullRequest>;
  /** The env a PR's head commit is fetched with, when this clone never saw it. */
  env?: NodeJS.ProcessEnv;
  /** One snapshot shared by every tree in a sweep. Taken fresh when absent. */
  processSnapshot?: ProcessSnapshot;
  /**
   * Read the folder even when a session on it already keeps it. The cleanup
   * tools want this: a session they skip may leave its neighbours on the
   * tree free to go, and they judge again without it.
   */
  thorough?: boolean;
  /**
   * Count every process in the folder, the sessions' own terminals
   * included. The executor sets it after stopping them; before that, their
   * own CLI and shell are expected to be there.
   */
  countOwnProcesses?: boolean;
}

export interface Gathered {
  facts: TreeFacts;
  /** What `inspect` said, for the executor to remove by. */
  inspection: WorktreeInspection | null;
}

/**
 * The facts `judge` decides on, cheapest first: the sessions' own state, then
 * the folder's registration, processes and status, then the slow checks —
 * published commits, hidden edits, ignored files, nested repositories — only
 * for a tree nothing has kept yet.
 */
export class FactGatherer {
  constructor(private readonly sources: FactSources) {}

  public users(tree: string): TreeUser[] {
    const users: TreeUser[] = [];
    for (const workspace of this.sources.getWorkspaces()) {
      for (const session of workspace.sessions) {
        if (session.removedWorktree) continue;
        const uses = [session.cwd, session.agentCwd].some(
          (dir) => !!dir && this.sources.worktrees.managedTreeOf(dir) === tree,
        );
        if (uses) users.push({ workspace, session });
      }
    }
    return users;
  }

  public async gather(tree: string, options: GatherOptions): Promise<Gathered> {
    const users = this.users(tree);
    const held = this.sources.heldSessionIds();
    const userFacts = users.map(({ workspace, session }) =>
      this.userFacts(workspace, session, held, options),
    );
    const disk: DiskFacts = {
      managed: this.sources.worktrees.managedTreeOf(tree) === tree,
      scopeFolder: this.scopeWithin(tree),
      recentlyPrepared: this.sources.lock.recentlyPrepared(tree),
    };
    const facts: TreeFacts = { tree, users: userFacts, disk };
    const done = () => ({ facts, inspection });
    let inspection: WorktreeInspection | null = null;

    const keptByUsers =
      options.request.trigger === 'sweep'
        ? userFacts.some((user) => userBlockers(user, options.request).blockers.length > 0)
        : userFacts.some(
            (user) =>
              !options.request.targets.has(user.sessionId) ||
              userBlockers(user, options.request).blockers.length > 0,
          );
    if (treeBlockers(unreadAsClean(disk)).length > 0) return done();
    if (keptByUsers && !options.thorough) return done();

    inspection = await this.sources.worktrees.inspect(tree);
    disk.head = inspection?.head ?? null;
    disk.branch = inspection?.branch ?? null;
    disk.dirty = inspection ? inspection.dirty : null;
    disk.dirtyFiles = inspection?.dirtyFiles ?? 0;
    if (inspection && (!inspection.isLinkedWorktree || inspection.toplevel !== tree)) {
      // A clone's own checkout, or a folder inside some other checkout.
      disk.managed = false;
      return done();
    }
    if (!inspection) return done();

    const snapshot = options.processSnapshot ?? (await this.sources.processes.snapshot());
    const own = options.countOwnProcesses
      ? { agents: new Set<number>(), shells: new Set<number>() }
      : this.sources.ownProcessIds(users.map((user) => user.session));
    disk.locked = await this.sources.worktrees.isLocked(inspection.mainRepo, tree);
    disk.processes = ProcessCwdIndex.inTree(snapshot, tree, own.agents, own.shells);
    if (treeBlockers(unreadAsClean(disk)).length > 0) return done();

    const finished = this.finishedPullRequest(userFacts, options);
    const [published, hidden, ignored, nested] = await Promise.all([
      this.sources.worktrees.commitsArePublished(
        inspection,
        finished ? { knownHead: finished.headOid, fetchRef: finished.fetchRef } : {},
        options.env ?? process.env,
      ),
      this.sources.worktrees.hiddenChanges(tree),
      this.sources.worktrees.ignoredAtRisk(tree, inspection.mainRepo),
      this.sources.worktrees.nestedRepos(tree),
    ]);
    disk.published = published;
    disk.hidden = hidden;
    disk.ignored = ignored;
    disk.nested = nested;
    return done();
  }

  /** The sessions on the tree now, with their own facts. No git, no processes. */
  public usersNow(tree: string, options: GatherOptions) {
    const held = this.sources.heldSessionIds();
    const users = this.users(tree);
    return {
      sessions: users.map((user) => user.session),
      users: users.map(({ workspace, session }) =>
        this.userFacts(workspace, session, held, options),
      ),
    };
  }

  /** One session's own facts, read cheaply: no git, no processes. */
  public userFactsFor(workspace: Workspace, session: Session, options: GatherOptions): UserFacts {
    return this.userFacts(workspace, session, this.sources.heldSessionIds(), options);
  }

  private userFacts(
    workspace: Workspace,
    session: Session,
    held: ReadonlySet<string>,
    options: GatherOptions,
  ): UserFacts {
    const status = this.sources.status(session.instanceId);
    const facts: UserFacts = {
      sessionId: session.id,
      sessionName: session.name,
      kind: session.kind,
      status: status === 'working' || status === 'needs-attention' ? status : 'idle',
      shown: this.sources.isShown(session.instanceId),
      held: held.has(session.id),
      lastActiveAt: this.sources.lastActiveAt(session),
      optedOut: session.autoRemoveWorktree === 'never',
    };
    const resolved = options.pullRequests?.get(session.id);
    if (resolved) facts.pullRequest = resolved.fact;
    const rules = this.sources.rules;
    if (rules) {
      facts.rules = (options.rulesFor ?? rules.rulesFor)(workspace);
      facts.settledAt = rules.settledAt(session);
      const ended = session.automation ? rules.runEndedAt(session) : undefined;
      if (ended !== undefined) facts.runEndedAt = ended;
    }
    return facts;
  }

  /** The final head of a finished PR a session going with the tree is about. */
  private finishedPullRequest(
    users: UserFacts[],
    options: GatherOptions,
  ): PullRequestState | undefined {
    const usersById = new Set(users.map((user) => user.sessionId));
    for (const [sessionId, resolved] of options.pullRequests ?? []) {
      // A session going with the tree: one of the targets, or one whose
      // record was deleted just before (no longer a user of anything).
      const going =
        options.request.trigger === 'sweep' ||
        options.request.targets.has(sessionId) ||
        !usersById.has(sessionId);
      if (going && resolved.fact.kind === 'finished' && resolved.state) return resolved.state;
    }
    return undefined;
  }

  /** The name of a scope that is this directory or lies inside it, in any workspace. */
  private scopeWithin(dir: string): string | null {
    for (const workspace of this.sources.getWorkspaces()) {
      for (const scope of workspace.scopes) {
        if (isWithin(realpathOr(scope.path), dir)) return scope.name;
      }
    }
    return null;
  }
}

/** Clean placeholders, so `treeBlockers` answers about what has been read so far. */
const CLEAN: Required<
  Omit<DiskFacts, 'managed' | 'scopeFolder' | 'recentlyPrepared' | 'branch' | 'dirtyFiles'>
> = {
  head: 'unread',
  dirty: false,
  published: 'published',
  ignored: { count: 0, paths: [], complete: true },
  nested: { paths: [], complete: true },
  hidden: { kind: 'none' },
  locked: false,
  processes: { kind: 'none' },
};

/** `disk` with every fact not read yet filled in as clean. Only for an early "already kept?" check. */
function unreadAsClean(disk: DiskFacts): DiskFacts {
  const filled: DiskFacts = { ...disk };
  for (const key of Object.keys(CLEAN) as Array<keyof typeof CLEAN>) {
    if (filled[key] === undefined) Object.assign(filled, { [key]: CLEAN[key] });
  }
  return filled;
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

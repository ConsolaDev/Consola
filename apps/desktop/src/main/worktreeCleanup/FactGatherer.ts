import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitFolderProblem } from '@consola/automation-engine';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';
import type { WorktreeCleanupRules } from '../../shared/worktreeCleanup';
import type { PullRequestState } from '../providers/pullRequests';
import type { WorktreeInspection, WorktreeService } from '../WorktreeService';
import type { PathLock } from './PathLock';
import { treeBlockers, treeDue, userBlockers } from './policy';
import type { DiskFacts, JudgeRequest, PullRequestFact, TreeFacts, UserFacts } from './policy';
import { ProcessCwdIndex } from './ProcessCwdIndex';
import type { ProcessSnapshot } from './ProcessCwdIndex';
import type { TreeUser } from './TreeIndex';

/** What the sweep's rules read about a session, beyond what every caller reads. */
export interface RuleSources {
  /** The workspace's effective rules; null when cleanup is off there. */
  rulesFor(workspace: Workspace): WorktreeCleanupRules | null;
  /** When the session went onto the Settled shelf, if it reads settled now. */
  settledAt(session: Session): number | null;
  /** For a session an automation started: when its run ended, null while it is open. */
  runEndedAt(session: Session): number | null | undefined;
  /**
   * The run in history whose own checkout (slice 3-B, `kind: 'run-owned'`)
   * is `tree`: its id, the person's clone its record names (null when that
   * clone is not found in the run's workspace, which keeps the folder), when
   * it ended (null while open) and its workspace. Null when history has no
   * such run.
   */
  runOwnedOf?(tree: string): {
    runId: string;
    source: string | null;
    endedAt: number | null;
    workspaceId?: string;
  } | null;
}

/** What recognising a run's own checkout found: its run, the clone it came from, and its run's place in history. */
interface RunOwnedTree {
  runId: string;
  source: string;
  /** Null while its run is open; undefined once history has no record of it. */
  endedAt: number | null | undefined;
  /** The workspace whose rules apply: the run's, else one whose scope is its clone. */
  workspace: Workspace | null;
}

export interface FactSources {
  getWorkspaces(): Workspace[];
  status(instanceId: string): TerminalStatus;
  /** Whether any window is showing the session, focused or not. */
  isShown(instanceId: string): boolean;
  /** Sessions an open or pending automation run holds. */
  heldSessionIds(): ReadonlySet<string>;
  /**
   * Whether an automation run holds the tree as its checkout, as the engine
   * counts it: a run parked at a gate has no process there and its sessions
   * may have settled, yet its next step works in it.
   */
  runHolds(tree: string): boolean;
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
    | 'runOwnedFolders'
    | 'runOwnedConfig'
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
 * Whether one of the folders automation runs hold (`heldCheckouts`) is
 * `tree` or lies in it, read through the tree's own resolution: a run names
 * its checkout as it built the path, the cleanup by its real one.
 */
export function treeHeldByRun(
  tree: string,
  heldCheckouts: readonly string[],
  worktrees: Pick<WorktreeService, 'managedTreeOf'>,
): boolean {
  return heldCheckouts.some((dir) => worktrees.managedTreeOf(dir) === tree);
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
      heldByRun: this.sources.runHolds(tree),
    };
    const facts: TreeFacts = { tree, users: userFacts, disk };
    const done = () => ({ facts, inspection });
    let inspection: WorktreeInspection | null = null;

    // A run's own checkout (slice 3-B): a clone, so `inspect` would call it a clone's own
    // checkout; it is Consola's only when its run, or its git folder's config, says so (Call 11).
    const runOwned = disk.managed ? await this.recogniseRunOwned(tree) : null;
    if (runOwned === 'refused') {
      disk.managed = false;
      return done();
    }
    if (runOwned) {
      disk.run = {
        endedAt: runOwned.endedAt,
        rules: runOwned.workspace ? this.rulesOf(runOwned.workspace, options) : null,
      };
    }

    const due = treeDue(disk, options.request);
    const keptByUsers =
      options.request.trigger === 'sweep'
        ? userFacts.some((user) => userBlockers(user, options.request, due).blockers.length > 0)
        : userFacts.some(
            (user) =>
              !options.request.targets.has(user.sessionId) ||
              userBlockers(user, options.request).blockers.length > 0,
          );
    if (treeBlockers(unreadAsClean(disk)).length > 0) return done();
    if (keptByUsers && !options.thorough) return done();

    if (runOwned) {
      // Before any git runs in it: `hiddenChanges` and `ignoredAtRisk` find the git folder
      // through the checkout's pointer, which only Consola's check can vouch for (review NS1).
      disk.gitFolder = gitFolderProblem(tree);
      if (disk.gitFolder !== null) return done();
    }

    inspection = await this.sources.worktrees.inspect(
      tree,
      runOwned ? { runId: runOwned.runId, source: runOwned.source } : undefined,
    );
    disk.head = inspection?.head ?? null;
    disk.branch = inspection?.branch ?? null;
    disk.dirty = inspection ? inspection.dirty : null;
    disk.dirtyFiles = inspection?.dirtyFiles ?? 0;
    const ours = runOwned
      ? inspection?.runOwned?.runId === runOwned.runId
      : inspection?.isLinkedWorktree === true;
    if (inspection && (!ours || inspection.toplevel !== tree)) {
      // A clone's own checkout, or a folder inside some other checkout.
      disk.managed = false;
      return done();
    }
    if (!inspection) return done();

    const snapshot = options.processSnapshot ?? (await this.sources.processes.snapshot());
    const own = options.countOwnProcesses
      ? { agents: new Set<number>(), shells: new Set<number>() }
      : this.sources.ownProcessIds(users.map((user) => user.session));
    // A clone has no lock of `git worktree lock`'s kind: nothing to read there.
    disk.locked = runOwned
      ? false
      : await this.sources.worktrees.isLocked(inspection.mainRepo, tree);
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

  /**
   * Every run's own checkout under the worktree root this recognises (Call
   * 11), with the workspace whose rules apply, for the trees no session
   * uses: they join the sweep and Preview on their run's account.
   */
  public async runOwnedTrees(): Promise<Array<{ tree: string; workspaceId: string | null }>> {
    const found: Array<{ tree: string; workspaceId: string | null }> = [];
    for (const tree of this.sources.worktrees.runOwnedFolders()) {
      const owned = await this.recogniseRunOwned(tree);
      if (owned && owned !== 'refused') {
        found.push({ tree, workspaceId: owned.workspace?.id ?? null });
      }
    }
    return found;
  }

  /**
   * Whether `tree` is a run's own checkout, and whose (plan Call 11, review
   * M6). Null for a tree with no git folder in `run-git/`, which is
   * anything else; `refused` for one that has one but that Consola cannot
   * vouch for, which stays "not a worktree Consola created". By its run
   * record first, the record's clone winning: the git folder's
   * `consola.source` must name that clone (on `host` the config is the
   * agent's to write) and `consola.run` that run. Else, once history
   * dropped the run, by the config pair alone. Either way the folder's
   * name must be its run's (`<repo>-run-<run id's first 8>`).
   */
  private async recogniseRunOwned(tree: string): Promise<RunOwnedTree | 'refused' | null> {
    const config = await this.sources.worktrees.runOwnedConfig(tree);
    if (config === null) return null;
    if (config === 'unreadable') return 'refused';
    const named = (runId: string) => path.basename(tree).endsWith(`-run-${runId.slice(0, 8)}`);
    const record = this.sources.rules?.runOwnedOf?.(tree) ?? null;
    if (record) {
      const matches =
        record.source !== null &&
        config.runId === record.runId &&
        realpathOr(config.source) === realpathOr(record.source) &&
        named(record.runId);
      if (!matches) return 'refused';
      const workspace =
        this.sources.getWorkspaces().find((candidate) => candidate.id === record.workspaceId) ??
        this.workspaceOfClone(record.source!);
      return { runId: record.runId, source: record.source!, endedAt: record.endedAt, workspace };
    }
    if (!named(config.runId)) return 'refused';
    return {
      runId: config.runId,
      source: config.source,
      endedAt: undefined,
      workspace: this.workspaceOfClone(config.source),
    };
  }

  /** A workspace one of whose scopes is the clone at `source`, by real path. */
  private workspaceOfClone(source: string): Workspace | null {
    const target = realpathOr(source);
    return (
      this.sources
        .getWorkspaces()
        .find((workspace) => workspace.scopes.some((scope) => realpathOr(scope.path) === target)) ??
      null
    );
  }

  private rulesOf(workspace: Workspace, options: GatherOptions): WorktreeCleanupRules | null {
    const rules = this.sources.rules;
    if (!rules) return null;
    return (options.rulesFor ?? rules.rulesFor)(workspace);
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
  Omit<
    DiskFacts,
    'managed' | 'scopeFolder' | 'recentlyPrepared' | 'heldByRun' | 'branch' | 'dirtyFiles' | 'run'
  >
> = {
  gitFolder: null,
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

import type {
  Blocker,
  BranchDisposal,
  CleanupTrigger,
  TreeVerdict,
  WorktreeCleanupRules,
} from '../../shared/worktreeCleanup';
import type { HiddenChanges } from '../WorktreeService';
import type { AtRiskFiles, NestedRepos } from './localFiles';
import type { ProcessesInTree } from './ProcessCwdIndex';

/**
 * The one decision about one worktree folder: remove it, or keep it and say
 * why. No IO — every caller (the sweep, Preview, the delete dialog, "Clean up
 * now", the MCP tools) gathers facts and asks here, and the executor asks
 * again under the folder's lock right before it removes anything.
 *
 * Any fact that is missing or could not be read keeps the worktree.
 */

const NOT_FULLY_CHECKED = 'it was not fully checked';

/** How recently a session may have been active before its worktree can go. */
export const QUIET_PERIOD_MS = 60 * 60_000;

/** What a pull request says about the session it is attributed to. */
export type PullRequestFact =
  | { kind: 'finished'; number: number; status: 'merged' | 'closed' }
  | { kind: 'open'; number: number }
  | { kind: 'none' }
  | { kind: 'unknown'; detail: string };

/** One session whose agent works in the tree, through `cwd` or `agentCwd`. */
export interface UserFacts {
  sessionId: string;
  sessionName: string;
  kind: 'interactive' | 'conductor';
  /** `working` or `needs-attention` read from its terminal; else `idle`. */
  status: 'working' | 'needs-attention' | 'idle';
  shown: boolean;
  held: boolean;
  lastActiveAt: number;
  optedOut: boolean;
  /** Its workspace's effective rules; null when cleanup is off there. Sweep only. */
  rules?: WorktreeCleanupRules | null;
  /** When it went onto the Settled shelf, if it reads settled now. */
  settledAt?: number | null;
  /** For a session an automation started: when its run ended, null while it is open. */
  runEndedAt?: number | null;
  /** Absent when no pull request can be attributed to it. */
  pullRequest?: PullRequestFact;
}

/**
 * What git and the OS say about the folder. Every optional fact is
 * `undefined` when it was not read — the gatherer stops early once something
 * already keeps the tree — and `null` when it could not be read. Either keeps.
 */
export interface DiskFacts {
  /** A linked worktree directly under Consola's worktree root. */
  managed: boolean;
  /** The name of a workspace folder that is, or lies inside, the tree. */
  scopeFolder: string | null;
  recentlyPrepared: boolean;
  /**
   * An automation run holds it as its checkout: working in it, or parked at a
   * gate or a declared retry, its next step to run there (3-A code review S1).
   */
  heldByRun: boolean;
  head?: string | null;
  branch?: string | null;
  dirty?: boolean | null;
  dirtyFiles?: number;
  /** Every commit on HEAD exists in the finished PR's head, or on a remote. */
  published?: 'published' | 'local-commits' | 'unverifiable' | null;
  ignored?: AtRiskFiles | null;
  nested?: NestedRepos | null;
  hidden?: HiddenChanges | null;
  locked?: boolean | null;
  processes?: ProcessesInTree | null;
  /**
   * A run's own checkout (slice 3-B, plan Call 11): its run, as history has
   * it. `endedAt` is null while the run is open and undefined once history
   * no longer has the run (the folder was recognised by its git folder's
   * config). `rules` are its workspace's, for the sweep; null when cleanup
   * is off there or no workspace holds its clone. Absent for any other tree.
   */
  run?: { endedAt?: number | null; rules?: WorktreeCleanupRules | null };
  /**
   * For a run's own checkout: what `gitFolderProblem` found, or null when
   * its pointer and git folder are as Consola made them. A problem stops
   * every other git fact being read there (review NS1).
   */
  gitFolder?: string | null;
}

export interface TreeFacts {
  tree: string;
  /** Every live session on the tree, in any workspace. */
  users: UserFacts[];
  disk: DiskFacts;
}

/**
 * - `sweep`: the rules. Every user must qualify under one of its workspace's
 *   enabled rules; the session stays.
 * - the delete triggers: `targets` are being deleted; anyone else on the tree
 *   keeps it.
 * - `tool-stale`: `targets` are going; anyone else keeps it.
 */
export interface JudgeRequest {
  trigger: CleanupTrigger | 'sweep';
  targets: ReadonlySet<string>;
  now: number;
  /**
   * For a delete whose record is already gone: whether the deleted session's
   * pull request is finished, which its branch's fate turns on.
   */
  finishedPullRequest?: boolean;
}

const DELETE_TRIGGERS: ReadonlySet<CleanupTrigger | 'sweep'> = new Set([
  'session-deleted',
  'tool-delete',
]);

export function judge(facts: TreeFacts, request: JudgeRequest): TreeVerdict {
  const sessionIds = facts.users.map((user) => user.sessionId);
  const blockers: Blocker[] = [];
  const triggers: CleanupTrigger[] = [];

  const due = treeDue(facts.disk, request);
  for (const user of facts.users) {
    if (request.trigger === 'sweep' || request.targets.has(user.sessionId)) {
      const own = userBlockers(user, request, due);
      if (own.blockers.length > 0) blockers.push(...own.blockers);
      else if (own.trigger) triggers.push(own.trigger);
    } else {
      blockers.push({
        kind: 'shared',
        detail: `"${user.sessionName}" still uses it`,
        sessionId: user.sessionId,
      });
    }
  }
  // Users first: a session's state is the more useful headline.
  const shared = blockers.filter((blocker) => blocker.kind === 'shared');
  const own = blockers.filter((blocker) => blocker.kind !== 'shared');
  // The "not fully checked" net is for a tree nothing else keeps; when a
  // session keeps it, the folder was simply not read, and saying so would
  // bury the real reason.
  const disk = treeBlockers(facts.disk).filter(
    (blocker) => blocker.detail !== NOT_FULLY_CHECKED || own.length + shared.length === 0,
  );
  const all = [...own, ...disk, ...shared];
  if (facts.users.length === 0 && request.trigger === 'sweep') {
    // A run's own checkout is the run's: its rules decide, with no session on it.
    if (!due) all.push({ kind: 'not-due', detail: 'no session uses it' });
    else if ('trigger' in due) triggers.push(due.trigger);
    else if (due.why !== null) all.push({ kind: 'not-due', detail: due.why });
  }

  if (all.length > 0) return { decision: 'keep', tree: facts.tree, sessionIds, blockers: all };
  const trigger = request.trigger === 'sweep' ? triggers[0] : request.trigger;
  if (!trigger) {
    return {
      decision: 'keep',
      tree: facts.tree,
      sessionIds,
      blockers: [{ kind: 'not-due', detail: 'no rule applies' }],
    };
  }
  return {
    decision: 'remove',
    tree: facts.tree,
    sessionIds,
    trigger,
    branch: branchDisposal(facts, request),
  };
}

/**
 * Why one session keeps the tree, and under which rule it would let it go.
 * Exported for the cleanup tools, which skip a session whose own state
 * blocks before they judge its tree.
 */
export function userBlockers(
  user: UserFacts,
  request: Pick<JudgeRequest, 'trigger' | 'now'>,
  /** For a session in a run's own checkout: the tree's rule (`treeDue`), which replaces the session's own. */
  due?: RunOwnedDue,
): { blockers: Blocker[]; trigger?: CleanupTrigger } {
  const blockers: Blocker[] = [];
  const add = (kind: Blocker['kind'], detail: string) =>
    blockers.push({ kind, detail, sessionId: user.sessionId });
  const name = `"${user.sessionName}"`;
  const deleting = DELETE_TRIGGERS.has(request.trigger);

  if (user.kind === 'conductor') add('conductor', `${name} conducts other sessions`);
  if (user.status !== 'idle') {
    add('busy', `${name} is ${user.status === 'working' ? 'working' : 'waiting on you'}`);
  }
  if (user.held) add('held', `an automation run is holding ${name}`);
  // Deleting a session is the person's own decision about it: being open
  // in front of them, or used a minute ago, is not a reason to doubt it.
  if (user.shown && !deleting) add('shown', `${name} is open in a window`);
  if (user.optedOut) add('opted-out', `${name} is set never to remove its worktree`);

  let trigger: CleanupTrigger | undefined;
  let quietMs = QUIET_PERIOD_MS;
  if (request.trigger === 'sweep') {
    const rule = due ?? dueUnder(user, request.now);
    if ('trigger' in rule) {
      trigger = rule.trigger;
      if (rule.quietMs !== undefined) quietMs = rule.quietMs;
    } else if (rule.why !== null) {
      add('not-due', rule.why);
    }
  }
  // The quiet period is for removing on its own. A person deleting a
  // session, or a cleanup tool someone asked for (and in confirm mode
  // approved), acts now; being open in a window, held or busy still keep it.
  if (request.trigger === 'sweep') {
    const idleFor = request.now - user.lastActiveAt;
    if (idleFor < quietMs) add('recent', `${name} was active ${ago(idleFor)}`);
  }
  return blockers.length > 0 ? { blockers } : { blockers, ...(trigger ? { trigger } : {}) };
}

/** The first enabled rule a session qualifies under, or why none applies. */
function dueUnder(
  user: UserFacts,
  now: number,
): { trigger: CleanupTrigger; quietMs?: number } | { why: string } {
  const rules = user.rules;
  if (!rules) return { why: 'cleanup is off for its workspace' };
  const reasons: string[] = [];

  if (rules.prFinished) {
    const pr = user.pullRequest;
    if (pr?.kind === 'finished') return { trigger: 'pr-finished' };
    if (!pr || pr.kind === 'none') reasons.push('it has no pull request');
    else if (pr.kind === 'open') reasons.push(`pull request #${pr.number} is still open`);
    else reasons.push(`its pull request could not be checked (${pr.detail})`);
  }
  if (rules.settledDays > 0) {
    const threshold = rules.settledDays * DAY_MS;
    if (user.settledAt === null || user.settledAt === undefined) {
      reasons.push('it is not settled');
    } else if (now - user.settledAt >= threshold) {
      return { trigger: 'settled' };
    } else {
      reasons.push(
        `it settled ${ago(now - user.settledAt)}; removed after ${plural(rules.settledDays, 'day')}`,
      );
    }
  }
  if (rules.runFinished.enabled && user.runEndedAt !== undefined) {
    const afterMs = rules.runFinished.afterMinutes * 60_000;
    if (user.runEndedAt === null) {
      reasons.push('its automation run is still open');
    } else if (now - user.runEndedAt >= afterMs) {
      // The rule's own delay replaces the quiet period, never "open in a window".
      return { trigger: 'run-finished', quietMs: afterMs };
    } else {
      reasons.push(
        `its automation run ended ${ago(now - user.runEndedAt)}; removed after ${minutes(rules.runFinished.afterMinutes)}`,
      );
    }
  }
  if (reasons.length === 0) return { why: 'no cleanup rule applies to it' };
  return { why: reasons.join('; ') };
}

/** Why a run's own checkout may go under the sweep, or why not; `why: null` when the tree itself already keeps it. */
export type RunOwnedDue = { trigger: CleanupTrigger; quietMs?: number } | { why: string | null };

/**
 * The sweep's rule for a run's own checkout (slice 3-B): `runFinished` once
 * its run ended that long ago (the rule's delay replacing the quiet
 * period, as for a session), `runForgotten` once history has no record of
 * the run. An open run is kept by `treeBlockers` (`run-open`), so it has no
 * reason of its own here.
 */
export function runOwnedDue(
  disk: DiskFacts,
  rules: WorktreeCleanupRules | null,
  now: number,
): RunOwnedDue {
  const ended = disk.run?.endedAt;
  if (ended === null) return { why: null };
  if (!rules) return { why: 'cleanup is off for its workspace' };
  if (ended === undefined) {
    if (rules.runForgotten === true) return { trigger: 'run-forgotten' };
    return { why: 'its automation run is no longer in history' };
  }
  if (rules.runFinished.enabled) {
    const afterMs = rules.runFinished.afterMinutes * 60_000;
    if (now - ended >= afterMs) return { trigger: 'run-finished', quietMs: afterMs };
    return {
      why: `its automation run ended ${ago(now - ended)}; removed after ${minutes(rules.runFinished.afterMinutes)}`,
    };
  }
  return { why: 'no cleanup rule applies to it' };
}

/** The tree's own rule under the sweep, for a run's own checkout; undefined for any other tree or request. */
export function treeDue(
  disk: DiskFacts,
  request: Pick<JudgeRequest, 'trigger' | 'now'>,
): RunOwnedDue | undefined {
  if (!disk.run || request.trigger !== 'sweep') return undefined;
  return runOwnedDue(disk, disk.run.rules ?? null, request.now);
}

/** What the folder itself says. Anything unread keeps it. */
export function treeBlockers(disk: DiskFacts): Blocker[] {
  const blockers: Blocker[] = [];
  const add = (kind: Blocker['kind'], detail: string) => blockers.push({ kind, detail });

  if (!disk.managed) {
    add('not-managed', 'it is not a worktree Consola created');
    return blockers;
  }
  if (disk.scopeFolder !== null) {
    add('scope-folder', `it holds the workspace folder "${disk.scopeFolder}"`);
    return blockers;
  }
  if (disk.locked === true) add('locked', 'git has it locked');
  else if (disk.locked === null) add('unknown', 'git could not say whether it is locked');
  if (disk.recentlyPrepared) add('recently-prepared', 'a session is being started in it');
  if (disk.heldByRun) add('held', 'an automation run is holding it');
  if (disk.run && disk.run.endedAt === null) add('run-open', 'its automation run is still open');
  if (typeof disk.gitFolder === 'string') {
    add('unknown', `its git folder changed (${disk.gitFolder}), so Consola did not read it`);
  }

  const processes = disk.processes;
  if (processes === null || processes?.kind === 'unknown') {
    add('unknown', 'Consola could not check for processes running in it');
  } else if (processes?.kind === 'present') {
    const names = [...new Set(processes.processes.map((entry) => entry.command || 'a process'))];
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    const verb = processes.processes.length === 1 ? 'is' : 'are';
    add('process', `${names.slice(0, 3).join(', ')}${more} ${verb} still running in it`);
  }

  if (disk.dirty === null || disk.head === null) {
    add('unknown', 'git could not read it');
  } else if (disk.dirty === true) {
    const files = disk.dirtyFiles ?? 0;
    add(
      'dirty',
      files > 0
        ? `${plural(files, 'file')} ${files === 1 ? 'has' : 'have'} uncommitted changes`
        : 'it has uncommitted changes',
    );
  }
  if (disk.published === 'local-commits') {
    add('unpublished', 'it has commits that exist only locally');
  } else if (disk.published === 'unverifiable' || disk.published === null) {
    add('unverifiable', 'it has commits that could not be confirmed as pushed');
  }

  if (disk.hidden === null || disk.hidden?.kind === 'unknown') {
    add('unknown', 'git could not check for hidden edits');
  } else if (disk.hidden?.kind === 'some') {
    const verb = disk.hidden.paths.length === 1 ? 'has' : 'have';
    add(
      'hidden-changes',
      `${describePaths(disk.hidden.paths)} ${verb} edits hidden from git status`,
    );
  }
  if (disk.ignored === null) {
    add('unknown', 'its ignored files could not be checked');
  } else if (disk.ignored && disk.ignored.count > 0) {
    const verb = disk.ignored.count === 1 ? 'exists' : 'exist';
    add(
      'ignored-files',
      `${describePaths(disk.ignored.paths, disk.ignored.count)} ${verb} only here, ignored by git`,
    );
  } else if (disk.ignored && !disk.ignored.complete) {
    add('unknown', 'it has too many ignored files to check in time');
  }
  if (disk.nested === null || (disk.nested && !disk.nested.complete)) {
    add('unknown', 'it is too large to check for nested repositories in time');
  } else if (disk.nested && disk.nested.paths.length > 0) {
    add('nested-repo', `it holds another repository (${disk.nested.paths[0]})`);
  }

  // Something left unread with nothing else found: never a reason to remove.
  const read: Array<keyof DiskFacts> = [
    'head',
    'dirty',
    'published',
    'ignored',
    'nested',
    'hidden',
    'locked',
    'processes',
  ];
  // A run's own checkout is read only once its git folder was checked.
  if (disk.run) read.push('gitFolder');
  if (blockers.length === 0 && read.some((key) => disk[key] === undefined)) {
    add('unknown', NOT_FULLY_CHECKED);
  }
  return blockers;
}

function branchDisposal(facts: TreeFacts, request: JudgeRequest): BranchDisposal {
  const branch = facts.disk.branch;
  // A run's own checkout's branch is in its own clone, which goes whole; its commit stays in the keep-ref.
  if (!branch || facts.disk.run) return 'keep';
  switch (request.trigger) {
    case 'tool-stale':
    case 'tool-delete':
      return 'delete-at-head';
    case 'session-deleted': {
      // Only a branch Consola made, or one whose pull request is finished:
      // a person's own branch outlives the session that used it.
      if (branch.startsWith('consola/')) return 'delete-at-head';
      const finished =
        request.finishedPullRequest === true ||
        facts.users.some(
          (user) => request.targets.has(user.sessionId) && user.pullRequest?.kind === 'finished',
        );
      return finished ? 'delete-at-head' : 'keep';
    }
    default:
      // A session that stays is rebuilt from its branch.
      return 'keep';
  }
}

const DAY_MS = 24 * 60 * 60_000;

function describePaths(paths: string[], count = paths.length): string {
  const shown = paths.slice(0, 2).join(', ');
  const rest = count - Math.min(paths.length, 2);
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function minutes(value: number): string {
  if (value % 1440 === 0 && value > 0) return plural(value / 1440, 'day');
  if (value % 60 === 0 && value > 0) return plural(value / 60, 'hour');
  return plural(value, 'minute');
}

/** "3 minutes ago", "2 days ago". */
export function ago(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return 'just now';
  if (safe < 60 * 60_000) return `${plural(Math.floor(safe / 60_000), 'minute')} ago`;
  if (safe < DAY_MS) return `${plural(Math.floor(safe / (60 * 60_000)), 'hour')} ago`;
  return `${plural(Math.floor(safe / DAY_MS), 'day')} ago`;
}

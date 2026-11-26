import { sha256Hex } from './sha256';
import type { Automation, AutomationMode } from './schema';

/**
 * One execution of an automation.
 *
 * The north-star Run record (§3 of "North star · Factories", a Linear
 * document:
 * https://linear.app/consola/document/north-star-factories-the-earlier-direction-11a3fbefdb39),
 * as much of it as a local run has. Same field names and status words, so
 * the cloud runner's rows and these list side by side later. An agent step's
 * cost is the CLI's own estimate, recorded per turn (`StepRun.turn`) and
 * summed on the run (`costUsd`); a legacy agent run's and a tool run's are
 * not recorded (a tool run spends no tokens; a legacy run's tokens are its
 * session's). Not recorded yet, and why: `environment` (the workspace scope
 * is in `attribution` until environments exist locally), `orgId` (personal
 * automations have no org).
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'needs-approval'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'rejected';

/** The runner set grows (an Anthropic-hosted one, say); nothing may assume two values. */
export type RunnerKind = 'local' | 'cloud' | (string & {});

/**
 * A step's status. Like a run's, the set only grows: nothing may assume these
 * nine are all there will be. `waiting`: a gate asking a person, a loop at its
 * exhaustion gate, or a step waiting out a declared retry.
 */
export type StepRunStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'reported'
  | 'not-run';

/**
 * One step of a `steps:` run, as the record keeps it. Light by construction:
 * prompts, commands, env values, logs and artifacts live in the run folder.
 */
export interface StepRun {
  id: string;
  /** `gate` asks a person; `repeat` is a loop's own row, its steps' rows right after it; `uses` calls one MCP tool. */
  kind: 'agent' | 'run' | 'gate' | 'repeat' | 'uses';
  status: StepRunStatus;
  /** 1-based: the nth time this step ran in this run; names its folder. */
  attempt: number;
  /**
   * Inside a loop: the round this execution belongs to. On a loop's own row:
   * the round it is in.
   */
  round?: number;
  /** A loop's row: its `max`, written when round 1 starts, so a list row can say "round 2 of 3". */
  max?: number;
  /**
   * A gate's (or a loop's exhaustion gate's) question: when it was asked, and
   * once answered, the decision, by whom and when. A gate's answer is a
   * person's, given only from Consola's own window.
   */
  gate?: { askedAt: string; decision?: string; by?: 'person'; at?: string };
  /** When a step waiting out a declared retry (`on_failure`) runs again. */
  retryAt?: string;
  /** The declared retries this execution has used; spent once it equals the step's `on_failure.retry`. */
  retries?: number;
  /**
   * One line the status cannot say: how a loop ended, why a step did not run
   * after `then: stop`, a dry run's report of a gate. Shown, never parsed.
   */
  note?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Why it was skipped. */
  skipped?: string;
  /** The latest execution's validated outputs; small by construction. */
  outputs?: Record<string, string | number | boolean>;
  artifacts?: Array<{ name: string; bytes: number }>;
  error?: string;
  sessionId?: string;
  conversation?: { harnessId: string; id: string; cwd?: string };
  reminded?: boolean;
  /** The model the CLI reported in its turn's `system/init`, the latest turn's. */
  model?: string;
  /** The agent file's name (`agents/<name>.md`), when the step named one. */
  agent?: string;
  /**
   * A write step's agent `tools:` (slice 3-B), written when it starts: what
   * a restart reads to fail a write step it cannot resume. Absent: read-only.
   */
  tools?: 'edit' | 'write';
  /**
   * A step in a run's own checkout (slice 3-B): the commit it started from,
   * and once Consola settled it, the commit it ended at, the files changed
   * and the paths flagged for a person's look.
   */
  checkout?: { before: string; after?: string; files?: number; flagged?: string[] };
  /**
   * A write step's environment as it launched (slice 3-B): its isolation,
   * the CLI's version, and which of its `env:` names the person's
   * environment had (`passed`) and lacked (`missing`).
   */
  environment?: {
    name: string;
    isolation: 'host' | 'sandbox';
    cliVersion?: string;
    passed?: string[];
    missing?: string[];
  };
  /**
   * The latest attempt's turns, summed: its first turn, a resume, its
   * reminder. `costUsd` is the CLI's estimate, present only when a turn
   * reported one (a reported 0 is 0); `turns` the turns it took; `maxTurns`
   * the step's own cap, when it has one; `deniedTools` the tools a turn was
   * refused, distinct, in first-seen order.
   */
  turn?: { costUsd?: number; turns?: number; maxTurns?: number; deniedTools?: string[] };
  command?: {
    envNames: string[];
    /** The secrets the command was given, by name (never a value); present only when it named any. */
    secretNames?: string[];
    intentAt?: string;
    exitCode?: number;
    signal?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    truncated?: boolean;
  };
  /** A `uses:` step's call; each field only once it is true. */
  call?: {
    /** A stdio server's process group, written durably as soon as it is spawned; `ended` once Consola ended it. */
    server?: { pgid: number; startedAt: string; ended?: true };
    /** Written durably right before `tools/call` is sent. */
    intentAt?: string;
    /** Written durably as soon as an answer came back. */
    resultAt?: string;
    isError?: true;
    /** A result without `isError`: the call did what it does. */
    landed?: true;
    resultBytes?: number;
    /** Processes it started still alive after it was ended. */
    survivors?: number;
  };
  /**
   * Earlier executions of this step, oldest first; `costUsd` and `turns` are
   * that attempt's `turn.costUsd` and `turn.turns`, when it reported them.
   */
  previous?: Array<{
    attempt: number;
    status: StepRunStatus;
    error?: string;
    finishedAt?: string;
    costUsd?: number;
    turns?: number;
    /** Inside a loop: the round that execution belonged to. */
    round?: number;
    /** A gate's: the answer it was given. */
    decision?: string;
  }>;
}

export type RunSource = 'org' | 'repo' | 'personal' | 'manual';

/** The item an event run is about, as the connection reported it. */
export interface RunItem {
  /** The connection's stable key for it, e.g. `github:acme/api:pr:123`. */
  key: string;
  url: string;
  /** Author-controlled: shown as data, never sent as instructions. */
  title: string;
  /** A snapshot taken at fire time, refreshed once at start. */
  repo?: string;
  number?: number;
  type?: 'pr' | 'issue';
  author?: string;
}

export interface RunTrigger {
  /**
   * What fired it: the schedule, a connection's event, a poll's check, or a
   * request outside all three.
   */
  kind: 'cron' | 'event' | 'poll' | 'manual';
  /** ISO time: the scheduled occurrence, the poll that saw the event, or the request. */
  at: string;
  /** A cron occurrence missed while the runner was down, fired late. */
  catchUp?: boolean;
  /** Who asked, for a manual run. Agents never get `auto`. */
  by?: 'person' | 'agent';
  /** The asking session, when an agent asked. */
  actorId?: string;
  /** For an event: which connection, which of its listed events the item was in, and the item. */
  connection?: string;
  events?: string[];
  item?: RunItem;
}

export interface RunRecord {
  id: string;
  runner: RunnerKind;
  source: RunSource;
  /**
   * The automation's name: its identity in a personal file. A `manual` run
   * no automation made — an agent's call waiting for a person — carries
   * its tool reference here instead.
   */
  automationId: string;
  /** What it runs: a tool reference, an action's name, or `prompt`. */
  actionName: string;
  /** `automationVersion` of the definition this run executed. */
  actionVersion: string;
  /** The mode this run used — `confirm` even for an `auto` entry when it had to ask. */
  mode: AutomationMode;
  trigger: RunTrigger;
  status: RunStatus;
  /** One human sentence: "Removed 3 sessions; 1 kept." */
  summary?: string;
  /** The target's structured result, small enough to keep in history. */
  result?: unknown;
  /**
   * For `needs-approval`: the exact arguments approval executes — the
   * preview narrowed to what the person saw, never a fresh plan.
   */
  approval?: { args: Record<string, unknown> };
  /** The agent session the run started, once it launched. */
  sessionId?: string;
  /**
   * When a person approved it: the end of its wait for them. An approved
   * agent run waits for a slot from here, so a run's wait splits into the
   * two. Absent for a run that never asked, or from before it was recorded.
   */
  approvedAt?: string;
  /**
   * When the run started working: its tool's `run` call, or its agent
   * session's turn. Duration counts from here, not from `createdAt`, which
   * also covers time spent waiting for a person or a slot.
   */
  startedAt?: string;
  /**
   * The session's conversation, recorded at launch so the run stays
   * readable after the session is removed.
   */
  conversation?: { harnessId: string; id: string; cwd?: string };
  /** A `steps:` run's steps, in file order. Absent for a legacy run. */
  steps?: StepRun[];
  /** The run a `previous` reference resolved to. Absent when there was none. */
  previous?: { runId: string };
  /** The run only reported what its commands would do. */
  dryRun?: boolean;
  /**
   * Where the run worked; `head` is the commit it checked out (an item's) or
   * is now at (a checkout the run owns). `kind` is written from slice 3-B
   * on; a record without it reads as slice 1 decided it. A checkout the run
   * owns (slice 3-B) also records its repository, its branch, the commit it
   * cut from (`base`), what people's sessions left there (`byPerson`), the
   * session last seen holding it (`lastHolder`), and, once worktree cleanup
   * removed it, where its commit was kept (`removed`).
   */
  checkout?: {
    cwd: string;
    scopeId?: string;
    head?: string;
    kind?: 'item' | 'scope' | 'run-owned';
    repo?: string;
    branch?: string;
    base?: string;
    byPerson?: Array<{
      /** The session the run last saw holding it; absent when none was seen. */
      session?: string;
      before: string;
      after: string;
      files: number;
      flagged?: string[];
      at: string;
    }>;
    lastHolder?: string;
    removed?: { commit: string; keepRef: string; at: string };
  };
  /**
   * What holds this run before it can start: another run's gate holds its
   * item (`automation`, `run` and `step` name that gate). In a checkout the
   * run owns, a person's session open there (`session`, its id) holds it
   * between steps (slice 3-B).
   */
  waitingFor?: { gate?: { automation: string; run: string; step: string }; session?: string };
  /** Times the run started again by itself (the entry's `on_failure`). */
  retried?: number;
  /** When the entry's own declared retry runs: a wait on the run, since it can come before any step ran. */
  retryAt?: string;
  error?: string;
  /** Every attempt of every step, summed; the CLI's estimate. Absent while none reported one. */
  costUsd?: number;
  attribution: {
    automationId: string;
    actionName: string;
    triggerKind: RunTrigger['kind'];
    workspaceId?: string;
    actorId?: string;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected'];

/**
 * A short, stable hash of what an automation does — what approval binds to:
 * an approved plan is refused if the definition changed under it, and an
 * `auto` entry is trusted to run unasked only at the version a person
 * approved.
 *
 * Covers the target and its arguments or body, the mode, the scope (where),
 * an event trigger (what fires it, and its filter: which items), a poll's
 * check command, identity and `changed:` value and its timeout, and
 * `applies_to`. Not a cron schedule or a poll's `every`, which say when
 * rather than what, and not the workspace, which is where the file lives rather than something it says.
 *
 * A `steps:` entry is covered whole: prompts, action names, agent names,
 * commands, env templates, `if`, outputs, artifacts, reads, timeouts,
 * `dry_run`, a command's `secrets` and `permissions`, and its loops, gates
 * and retries, which its steps carry. Its
 * `checkout`, `budget` and `on_failure` are covered only when written, so an
 * entry without them hashes as before. Its `resolvedBody` is
 * `stepsResolvedBody`'s: the bodies of the actions its steps name and, when a
 * step names one, its agents' hashes.
 *
 * `resolvedBody` is what the runner resolved the target to — an action's
 * prompt, which lives in the workspace's settings rather than the file — so
 * editing the Review action makes an `auto` automation that runs it ask
 * again.
 */
export function automationVersion(
  automation: Pick<Automation, 'run' | 'steps' | 'mode' | 'trigger'> &
    Partial<Pick<Automation, 'scope' | 'appliesTo' | 'checkout' | 'budget' | 'onFailure'>>,
  resolvedBody?: string,
): string {
  const { trigger } = automation;
  const canonical = stableStringify({
    run: automation.run,
    // Absent on a legacy entry, and stableStringify drops undefined, so its hash does not move.
    steps: automation.steps,
    mode: automation.mode,
    scope: automation.scope,
    event:
      trigger.kind === 'event'
        ? { connection: trigger.connection, events: trigger.events, filter: trigger.filter }
        : undefined,
    // A poll's check is what Consola runs as the person, so it is what they approved.
    // `every` is not here: it says when, like a cron schedule.
    poll:
      trigger.kind === 'poll'
        ? {
            run: trigger.run,
            key: trigger.key,
            item: trigger.item,
            changed: trigger.changed,
            timeoutMs: trigger.timeoutMs,
            // By name: where each is bound is the runner's, not the file's (absent, dropped).
            secrets: trigger.secrets,
          }
        : undefined,
    // Which items a run on demand takes.
    appliesTo: automation.appliesTo,
    // Where a run works, what it may spend, and how often it starts again by itself (slice 3).
    checkout: automation.checkout,
    budget: automation.budget,
    onFailure: automation.onFailure,
    resolvedBody,
  });
  return sha256Hex(canonical).slice(0, 16);
}

/**
 * A steps entry's `resolvedBody`: today's `stableStringify({ <stepId>: <action body> })`, or undefined, when no step
 * names an agent, names an environment or calls a factory server; `stableStringify({ actions, agents: { <agent>:
 * <agentHash> }, environments: { <name>: <environmentHash> }, servers: { <server>: <serverHash> } })` when one does,
 * each key present only when non-empty: a shape no entry without an agent, an environment or a server can have (an
 * action map's values are strings). Every runner hashes an entry through this.
 *
 * So an entry no step of which names an agent or calls a server (every slice-1 entry) hashes byte for byte as
 * before, and an agent file, a skill it names, a server it names, or a server definition a call uses changes the
 * version of exactly the entries that use it. The servers ride in an options object, never a third positional
 * record: the third parameter, `environmentHashes`, is a record of the same type (5a-2's Call 13).
 */
export function stepsResolvedBody(
  actionBodies: Readonly<Record<string, string>>,
  agentHashes: Readonly<Record<string, string>>,
  environmentHashes?: Readonly<Record<string, string>>,
  options?: { servers: Readonly<Record<string, string>> },
): string | undefined {
  const actions = Object.keys(actionBodies).length > 0 ? actionBodies : undefined;
  const agents = Object.keys(agentHashes).length > 0 ? agentHashes : undefined;
  // An environment a write agent names is in the version too (slice 3-B); none moves no hash.
  const environments =
    environmentHashes !== undefined && Object.keys(environmentHashes).length > 0
      ? environmentHashes
      : undefined;
  const servers = options && Object.keys(options.servers).length > 0 ? options.servers : undefined;
  if (agents === undefined && environments === undefined && servers === undefined) {
    return actions === undefined ? undefined : stableStringify(actions);
  }
  return stableStringify({ actions, agents, environments, servers });
}

/** JSON with sorted keys and undefined dropped, so equal definitions hash equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

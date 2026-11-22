import { createHash } from 'node:crypto';
import {
  ARTIFACT_NAME_PATTERN,
  AUTOMATION_NAME_PATTERN,
  automationEntryText,
  automationFileText,
  automationItemText,
  automationVersion,
  factoryFilesOf,
  flatSteps,
  isStepsEntry,
  leafSteps,
  nextCronOccurrence,
  parseAutomationEntry,
  parseFactory,
  parseFactorySpec,
  skillHash,
  stableStringify,
  STEP_ID_PATTERN,
  stepItemFieldProblems,
  stepsResolvedBody,
  TERMINAL_RUN_STATUSES,
  type AgentDefinition,
  type AgentStep,
  type Automation,
  type AutomationMode,
  type CronTrigger,
  type ExprValue,
  type FactoryFiles,
  type FactoryNotice,
  type FactoryParseResult,
  type FactorySpecIssue,
  type PollTrigger,
  type RunItem,
  type RunRecord,
  type RunStatus,
  type RunTrigger,
  type SkillDefinition,
  type Step,
  type StepRun,
  type StepsAutomation,
  type Trigger,
} from '@consola/factory-spec';
import { describeCapabilities, type AutomationCapabilities } from './capabilities';
import {
  resolveEventSource,
  scheduledPrompt,
  workItemSource,
  type EventSource,
} from './connections';
import { advanceSeen, forgetFired, heldRevision, markFired, type OpenState } from './seenRecord';
import {
  agentToolContext,
  CONSOLA_NAMESPACE,
  describeError,
  fallbackWorkItemTitle,
  SESSION_OPENED_MESSAGE,
  SessionOpenedError,
  StartedByHandError,
} from './support';
import {
  ASSIGNED_REVIEWS_NAME,
  assignedReviewsEntry,
  EMPTY_FACTORY_FILE,
  factoryTemplate,
} from './factoryTemplates';
import {
  describeEvery,
  describeKind,
  describeRun,
  describeSteps,
  describeTriggerAsWritten,
  dryRunStarts,
} from './describeEntry';
import { describeSchedule } from './describeSchedule';
import {
  agentIssues,
  agentQuery,
  appliedSkills,
  appliedTexts,
  decideApply,
  describeAppliedAt,
  standingMessage,
  type ApplyDecision,
} from './factory/apply';
import type {
  AgentHarnessAnswer,
  AgentHarnessQuery,
  AgentLaunchRequest,
  AppliedFactory,
  AppliedFactoryStore,
  AppliedSkill,
  CheckoutKind,
  CommandPort,
  CommandResult,
  CommandSpec,
  EngineTool,
  EngineToolContext,
  EngineToolResult,
  FactoryFolderHandle,
  LaunchedSession,
  RunFolderPort,
  WorkItemPort,
  RunningCommand,
  ToolsPort,
} from './ports';
import { filterRuns, NO_RUN_FILTER, type RunListFilter } from './runFilter';
import { SNAPSHOT_ENDED_RUNS } from './views';
import type {
  ConversationTarget,
  ActionView,
  FactoryStanding,
  GateView,
  EntryAgentsView,
  AgentRunPreview,
  AutomationsSnapshot,
  AutomationView,
  CheckView,
  InboxItemView,
  ItemRef,
  ItemSnapshot,
  ItemTarget,
  ItemTargetRow,
  ItemTargets,
  ListRunsQuery,
  RunKind,
  RunListEntry,
  RunListPage,
  SavedAutomation,
  ScopeView,
  SessionView,
  TemplateView,
  TurnInitView,
  TurnOutcome,
  TurnReportView,
  WorkspaceView,
} from './views';
import type { RunStore } from './RunStore';
import { AUTOMATION_TEMPLATES, coversAssignedReviews, GITHUB, templateViews } from './templates';
import {
  actionTypeRefusal,
  agentStepLaunch,
  endedWithout,
  itemRefOf,
  stepCap,
} from './steps/agentStep';
import { MAX_CHECK_STDOUT_BYTES, readCheckResult, type PolledItem } from './sources/checkResult';
import { runItemSource, type ItemSource, type SourceItem } from './sources/itemSource';
import { polledSourceItem, pollSource } from './sources/pollSource';
import { resolvePrevious } from './sources/previous';
import {
  afterFailure,
  afterSuccess,
  checkSpec,
  dueNow,
  latestResult,
  MAX_CONCURRENT_CHECKS,
  nextCheckAt,
  type CheckState,
} from './sources/pollRunner';
import { reminderPrompt } from './steps/stepPrompt';
import {
  initProblem,
  reminderCap,
  reportedFailure,
  requiredServers,
  strayServerProblem,
  stepHarnessQuery,
  runCostOf,
  turnFailure,
  uncheckedInitProblem,
  withTurnRecorded,
} from './steps/turnReport';
import {
  entryCheckoutKind,
  entryReadsItems,
  prCheckoutProblem,
  runCheckoutKind,
  type CheckoutPort,
  type CheckoutRequest,
  type PreparedCheckout,
} from './steps/checkout';
import { describeFailure, LOG_CAP_BYTES, maskSecrets, utf8Bytes } from './steps/commandIO';
import {
  commandOutcome,
  commandSpec,
  createOutputFile,
  describeReason,
  neverStarted,
  prepareCommand,
  withCommandIntent,
  writeCommandFile,
  type PreparedCommand,
} from './steps/commandStep';
import {
  agentRequirements,
  MAX_ARTIFACT_BYTES,
  skillMarkdown,
  withKnownTools,
  type AgentRequirements,
  type CommandFile,
  type LogTail,
  type RunDefinition,
  type StepDetail,
  type StepsRunPreview,
} from './steps/definition';
import { isEngineRun, isStepsRun } from './steps/recover';
import { flowNotYet } from './steps/flowLater';
import { advanceSteps, type Lane, type StepUpdate } from './steps/sequence';
import {
  closeSteps,
  holdsWhileWaiting,
  isLoopRow,
  laneOfRecord,
  retrySteps,
  retryTargetOf,
  stepRecordsOf,
  waitingGateOf,
  withAttemptStarted,
  withGateAnswered,
  withGateAsked,
  withNextAttempt,
  withStep,
  withUpdate,
} from './steps/stepRecords';
import {
  gateMaterialRefs,
  gateOffer,
  gateRefusal,
  notWaitingForYou,
  renderGateAsk,
} from './steps/gate';
import { NO_TURN_TO_STOP, stopAction, stoppedBefore } from './steps/stop';
import { StepIO } from './steps/stepTools';

/**
 * The runner for personal automations: one `factory.yml` per workspace, whose
 * automations act on that workspace and nothing else. The host decides where
 * those files live and when the engine runs; the desktop is one such host.
 *
 * Trigger → target, in a mode. A target is a tool, run in-process, or an
 * agent session — one of the workspace's actions or a prompt of the
 * automation's own — started headless, read-only, as an ordinary tab the
 * person can watch, steer and resume. Triggers are a cron, a host timer, or
 * a connection's event: a change between two successful polls of
 * the Inbox. Consola detects; the agent acts — nothing is spent while nothing
 * is new. Automations run only while the host is running (on the desktop, while
 * Consola is open); what was missed while it was stopped fires once on the
 * next start, never once per occurrence. No
 * run ever starts another run (no workflow engine).
 *
 * Nothing a person did not approve runs unasked: `confirm` is the default; an
 * agent asking for an `auto` automation gets `confirm`; and an `auto` entry
 * runs on its own only at a version a person approved once — a new or edited
 * one asks first, whoever wrote the file, and so does one whose action was
 * edited in settings. Approving runs exactly what the preview showed, and
 * nothing if the definition changed since.
 *
 * Agent runs share one machine and one subscription, so at most a few of
 * their sessions work at once across every workspace; the rest wait as
 * `queued`, first in, first out.
 *
 * It also holds what agents ask to delete. An agent never runs a destructive
 * tool directly: its call becomes a run here (`source: 'manual'`), waiting in
 * its workspace beside the automations' approvals and approved or dismissed
 * the same way.
 */

export interface AutomationNotice {
  title: string;
  body: string;
  /** The run it is about: a click opens it. */
  runId?: string;
  /** The automation it is about, when no run is: a click opens its page. */
  automation?: string;
  /** Whose Automations panel a click opens. */
  workspaceId: string;
  needsApproval: boolean;
  /** The session a run started: a click opens it instead of the panel. */
  sessionId?: string;
}

/** How `saveEntry` writes: whether it may replace an entry of the same name, and the session that asked. */
export interface SaveEntryOptions {
  replace: boolean;
  by?: { sessionId: string; sessionName: string };
}

export interface AutomationServiceDeps {
  /** A workspace's factory folder; asked for once, when the workspace is first seen. */
  folderFor(workspaceId: string): FactoryFolderHandle;
  /**
   * Each folder's last applied version: what keeps running while a file has
   * a problem, across restarts. Read once per workspace, at its first load.
   */
  appliedStore: AppliedFactoryStore;
  store: RunStore;
  /** Each run's folder: its definition snapshot and its steps' documents. */
  runFolder: RunFolderPort;
  /** The host's identity of work items. */
  workItems: WorkItemPort;
  registry: ToolsPort;
  getWorkspaces(): WorkspaceView[];
  now(): Date;
  newId(): string;
  notify(notice: AutomationNotice): void;
  broadcast(workspaceId: string, snapshot: AutomationsSnapshot): void;
  /** setInterval, as a seam; returns a canceller. */
  every(ms: number, run: () => void): () => void;
  /** How often the tick runs; `TICK_MS` unless the host sets it (end-to-end tests do). */
  tickMs?: number;
  /** A workspace's latest Inbox snapshot, or null before its first fetch. */
  inboxSnapshot(workspaceId: string): ItemSnapshot | null;
  /** Fetch a workspace's Inbox now — an event automation's "Check now". */
  refreshInbox(workspaceId: string): Promise<void>;
  /**
   * Start an agent run's session, its first turn unattended; throws with the reason it could not.
   * Contract: the session it resolves with must already appear in `getWorkspaces()`
   * (`syncWorkspaces` and `honourStop` read it from there). A launch the person beat
   * to it must throw the engine's own `StartedByHandError`, which the runner checks
   * with `instanceof`.
   */
  launchAgent(request: AgentLaunchRequest): Promise<LaunchedSession>;
  /**
   * Run `prompt` as an unattended turn in a recorded automation session; throws with the reason
   * it could not. `maxTurns` caps this turn alone (a step's reminder, resumed under its own
   * cap); without it the turn runs under the record's.
   */
  resumeAgent(session: SessionView, prompt: string, maxTurns?: number): Promise<void>;
  /**
   * Run a step's one reminder turn: its session's exited terminal relaunched in place, or
   * resumed if it has none, unattended, with `prompt` as its turn; throws with the reason
   * it could not. It never refreshes the step's checkout. `maxTurns` caps the reminder
   * turn (`reminderCap`).
   */
  remindAgent(session: SessionView, prompt: string, maxTurns: number): Promise<void>;
  /** Whether a session has a terminal whose process is still running: someone opened it. */
  hasLiveTerminal(session: SessionView): boolean;
  /**
   * The workspace's default harness, or, given `agent`, the harness that
   * agent runs on (its `harness:`, else the default): its display name, and
   * why it cannot run a read-only unattended session (null when it can).
   * `stepProblem`: why its steps' reporting turns would not launch as Consola
   * compiles them (its extra arguments override a flag they need, `--model`
   * when the agent sets one); absent or null, they would. For an agent,
   * `agentProblem` (why it cannot run there at all) and `warning` (shown,
   * never blocking) too, and, of the servers it names for its entry's
   * checkout kind (`agent.checkout`): `serversProblem`, a server refused
   * against what the harness's CLI said (blocking like `agentProblem`);
   * `serversPending`, the CLI is being asked (a changed entry waits for the
   * answer, an unchanged one keeps running); `serversUnknown`, it could not
   * be asked (the entry's problem, never the folder's); `serverWarnings`,
   * notices that block nothing.
   */
  agentHarness(workspaceId: string, agent?: AgentHarnessQuery): AgentHarnessAnswer;
  /**
   * The host's harnesses, by id: what an agent writing automations is told
   * an agent file's `harness:` may name (only the enabled, unarchived ones),
   * each with the MCP servers its CLI last said it has (`servers`, absent
   * until it has been asked; listing them never asks). Absent, it is told none.
   */
  listHarnesses?(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    archived: boolean;
    servers?: string[];
  }>;
  /** End a running unattended turn the way Ctrl+C does. False when none is running. */
  stopAgent(session: SessionView, reason: string): boolean;
  /** Agent sessions automations may have working at once, across every workspace. */
  maxConcurrentAgents?: number;
  /** The host's platform, as `process.platform` says it. `run:` steps need a POSIX shell, which `win32` lacks. */
  platform: NodeJS.Platform;
  /** Where an item run's automation checkout is, and bringing it to the item's head. */
  checkout: CheckoutPort;
  /** Whether a session is running in `dir`, launched there or moved in since: a run on that checkout waits for it. */
  checkoutBusy(dir: string): boolean;
  /** Whether a step's working folder (its item's checkout, or its scope's folder) is still there. */
  folderExists(dir: string): boolean;
  /** Runs a `run:` step's command; the engine's `startCommand` (its Node adapter) is the one that spawns. */
  commands: CommandPort;
  /**
   * What a workspace's commands start from: the login environment and, for
   * a workspace with a bound account, its token under the provider's
   * variable, listed in `secrets` so the logs mask it. Rejects when that
   * token cannot be borrowed; a workspace with no bound account gets none.
   */
  commandEnv(workspaceId: string): Promise<{ env: NodeJS.ProcessEnv; secrets: string[] }>;
  /** Commands automations may have running at once, across every workspace. */
  maxConcurrentCommands?: number;
}

/** A `steps:` entry's problem on a host whose platform is `win32`. */
const NO_POSIX_SHELL = 'run: steps need a POSIX shell, which Windows does not have';

/** What a run says while another run, or a session, holds its item's checkout. The renderer reads it by its text. */
export const WAITING_FOR_CHECKOUT = "waiting for this item's checkout";

/** What a retry is refused with while another run, or a session, holds its item's checkout. */
const RETRY_HELD = 'Another run on this item is working; retry once it ends.';

/** What a retry of a run that never started is refused with: there is no step it got to, and its approval did not cover a start. */
const NEVER_STARTED = 'It never started; run it again.';

/** Why an agent's run waits, and what approving it does: it never accepts the entry. */
const AN_AGENT_ASKED = 'An agent asked for this run: approving runs this run only.';

/**
 * What a run of a poll entry not allowed yet says when it asks: approving it
 * runs that run, and only Allow lets the entry check.
 */
const NOT_CHECKING_YET =
  'It is not checking yet: approving runs this run only. Allow it on its page to let it check and run on its own.';

/** Why an unattended turn whose run ended under it is ended at once: nothing would record what it did. */
const RUN_ENDED = 'its run had ended';

/** How a step a restart cut off is remembered when it could not resume in its own session. */
const RESUME_SESSION_GONE = 'Consola quit while it ran, and its session is gone.';
const RESUME_SESSION_OPENED = 'Consola quit while it ran, and you opened its session.';

/** Commands automations may have running at once, across every workspace, by default. */
export const DEFAULT_MAX_CONCURRENT_COMMANDS = 2;

/** What a step's detail carries of each log: the end of it. */
const STEP_TAIL_BYTES = 64 * 1024;
/** The lanes slots are counted in: agent turns, and commands, each with a cap of its own. */
const LANES: readonly Lane[] = ['agent', 'command'];

/** The turn an automation session gets when Consola quit before its first one finished. */
export const INTERRUPTED_PROMPT =
  'Consola closed before you finished. Continue where you left off.';

/** How often the scheduler looks at the clock. Coarse on purpose: cron is per-minute. */
export const TICK_MS = 30_000;

/** Automation sessions working at once, across every workspace, by default. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 2;

/** Results bigger than this are summarised away rather than kept in history. */
const MAX_RESULT_CHARS = 20_000;

/** Requests one agent session may leave waiting before it must wait for the person. */
export const MAX_WAITING_PER_SESSION = 10;

/**
 * A run that has not finished: one more of these for the same thing would be a duplicate. A run
 * `waiting` at a gate or a declared retry is one (Call 11): it holds no process, and it is not over.
 */
export const OPEN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'needs-approval',
  'waiting',
];

/**
 * What a run asks of the person, as the attention queue sees it; null means
 * it has no row of its own. A running run is represented by its session, so
 * only a run waiting for approval, or waiting at a gate for an answer, wants
 * the person; one waiting out a retry does not. Run statuses only ever grow,
 * so one this build does not know is null rather than an error.
 */
export function runAttention(run: Pick<RunRecord, 'status' | 'steps'>): 'needs-attention' | null {
  if (run.status === 'needs-approval') return 'needs-attention';
  return waitingGateOf(run) ? 'needs-attention' : null;
}

interface Resolved {
  workspaceId: string;
  automation: Automation;
  /** `automationVersion`, the action's body included: what approvals bind to. */
  version: string;
  /** A tool run's tool and validated arguments. */
  tool?: EngineTool;
  args?: Record<string, unknown>;
  /** An agent run: the body it renders, and how its session is labelled and placed. */
  agent?: {
    body: string;
    /** The session's `workItemAction` for an item run: the action's name, or the automation's. */
    label?: string;
    groupId?: string;
    /** A scheduled run's scope. */
    scope?: ScopeView;
    /** "Review action", "Prompt" — for previews. */
    runs: string;
    /** The action's item types, when the entry's items may be of another (a poll's with `item:`): a run on one fails. */
    appliesTo?: Array<'pr' | 'issue'>;
  };
  /** A `steps:` entry that can run: what a run of it executes, as of now, and what firing one needs to know. */
  steps?: {
    definition: RunDefinition;
    /** A scheduled run's scope. */
    scope?: ScopeView;
    hasAgentStep: boolean;
    /** Even a dry run (`notify`) would start something: an agent step, or a `dry_run: run` command. */
    startsInDryRun: boolean;
    /** The first agent step's action, when it is one: the label a session started by hand on the item carries. */
    byHandLabel?: string;
    /** Every skill a step's agent names, from the version it resolved against: what a fired run copies into its folder. */
    skills: Readonly<Record<string, SkillDefinition>>;
  };
  /**
   * Where its runs' items come from (roadmap contract 4): the event source,
   * a poll's, or the work items of a run on demand with `applies_to`.
   * Absent when its runs have no item, and when it has a problem.
   */
  source?: ItemSource;
  /** An event trigger, resolved against the entry's filter: the Inbox's part of `source`, which is the same object. */
  event?: EventSource;
  /** Set when the entry parsed but cannot run: the reason it will not. */
  problem?: string;
  /** Its problem came from asking a harness's CLI about servers: its row offers Check again. */
  recheck?: true;
  /** Its problem is that the CLI could not be asked at all: machine state, which refuses no save. */
  unasked?: true;
  /** A `steps:` entry's: the agents it was resolved against, by name (its node names their harness and model). */
  agents?: Readonly<Record<string, AgentDefinition>>;
  /** A `steps:` entry's: the skills of the version it was resolved against, by name (the Allow card's `SKILL.md`s). */
  skills?: Readonly<Record<string, SkillDefinition>>;
  /** What the host said of its agents that stops nothing: a model the harness does not list. */
  warnings?: FactoryNotice[];
}

/** A workspace's factory folder as last read: whether `factory.yml` exists, the texts, and their parse. */
interface FactoryRead {
  exists: boolean;
  files: FactoryFiles;
  parse: FactoryParseResult;
}

/** One workspace's factory folder as last read, and what its entries resolved to. */
interface WorkspaceFactory {
  folder: FactoryFolderHandle;
  read: FactoryRead;
  resolved: Resolved[];
  /** The resolved entries' warnings, each once: the snapshot's notices after the read's own. */
  warnings: FactoryNotice[];
  /** Whether the store was read: once, at the folder's first load. Until then nothing is decided. */
  storeRead: boolean;
  /** The last applied version, kept with its parse; only `reapply` replaces it (the store is read once). */
  applied: { record: AppliedFactory; parse: FactoryParseResult } | null;
  /** Present while the folder does not apply: why, and when the version that runs applied. */
  standing?: { decision: Extract<ApplyDecision, { kind: 'keeps' }>; appliedAt: string };
}

/**
 * A folder whose read or parse threw: one issue, on factory.yml, and every
 * file counted as not read whole, so the applied version keeps running with
 * nothing removed. `exists` is the last read's.
 */
function unreadFolder(exists: boolean, error: unknown): FactoryRead {
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();
  const read = notRead();
  return {
    ...read,
    exists,
    parse: {
      ...read.parse,
      issues: [
        {
          message: `Could not read this factory's folder: ${reason.replace(/\.$/, '')}.`,
          file: 'factory.yml',
          path: '',
        },
      ],
      unreadable: ['factory.yml', 'automations/', 'agents/', 'skills/'],
    },
  };
}

/** A folder not read yet: nothing in it. */
function notRead(): FactoryRead {
  return {
    exists: false,
    files: {
      factoryYml: null,
      automations: {},
      agents: {},
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    },
    parse: {
      automations: [],
      agents: {},
      skills: {},
      issues: [],
      notices: [],
      present: [],
      unreadable: [],
    },
  };
}

/** An automation's identity: its name, within its workspace. */
function automationKey(entry: {
  workspaceId: string;
  automation: Pick<Automation, 'name'>;
}): string {
  return `${entry.workspaceId} ${entry.automation.name}`;
}

function cronOf(entry: Resolved): CronTrigger | null {
  return entry.automation.trigger.kind === 'cron' ? entry.automation.trigger : null;
}

function pollOf(entry: Resolved): PollTrigger | null {
  return entry.automation.trigger.kind === 'poll' ? entry.automation.trigger : null;
}

/** A schedule's identity: a renamed automation or an edited cron starts afresh rather than catching up. */
function scheduleKey(entry: Resolved): string {
  return `${automationKey(entry)} ${cronOf(entry)?.cron ?? ''}`;
}

/**
 * Which list an event or poll automation watches: its trigger and filter,
 * and whose Inbox it is — the account and org the workspace is bound to
 * decide what the searches return, and a check runs as that account.
 * Changing any of them re-baselines, so binding another org never reads as
 * every request in it arriving at once. A poll's interval is when it looks,
 * not what it sees, so changing only `every` keeps its record.
 */
export function listDefinition(
  entry: { automation: Automation },
  provider: WorkspaceView['provider'],
): string {
  const { filter } = entry.automation;
  const trigger = withoutInterval(entry.automation.trigger);
  const account = provider
    ? { id: provider.id, login: provider.accountLogin, org: provider.org }
    : null;
  return createHash('sha256')
    .update(stableStringify({ trigger, filter, account }))
    .digest('hex')
    .slice(0, 16);
}

/** A trigger as a list definition hashes it: a poll's without its interval, any other as written. */
function withoutInterval(trigger: Trigger): Trigger | Omit<PollTrigger, 'everyMs'> {
  if (trigger.kind !== 'poll') return trigger;
  const { everyMs: _interval, ...watched } = trigger;
  return watched;
}

/** A run's item source, and the polled object its fields are read from, or why that object could not be read. */
type RunItemOf =
  | { source: ItemSource | undefined; polled: Record<string, unknown> | undefined }
  | { source: ItemSource | undefined; error: string };

/** The check a `CheckState` says is running: what its result is matched against when it lands. */
type CheckRunning = NonNullable<CheckState['running']>;

/** How a check ended: with items, failed and why (masked), or dropped before it spawned, its entry no longer the one it was started for. */
type CheckEnd =
  | { ok: true; items: PolledItem[] }
  | { ok: false; error: string }
  | { dropped: true };

/**
 * Whether a queued run may start: with its item as its source has it now,
 * when it has one; or it waits; or it ends without starting, and `giveBack`
 * says Consola itself turned it away, so its item fires again (Call 12).
 */
type QueueVerdict =
  | { go: true; item?: SourceItem }
  | { go: false; wait: true }
  | { go: false; wait?: false; status: 'rejected' | 'failed'; message: string; giveBack?: true };

/**
 * A run waiting in a lane's line for a slot. One that has started (a legacy
 * turn a quit interrupted, or a steps run with a queued step, `stepId`) is
 * ahead of every one that has not.
 */
interface Waiting {
  run: RunRecord;
  lane: Lane;
  started: boolean;
  stepId?: string;
}

/** Started runs first, oldest start first; then the rest, by when each joined the line. */
function byPlaceInLine(a: Waiting, b: Waiting): number {
  if (a.started !== b.started) return a.started ? -1 : 1;
  const at = (waiting: Waiting) =>
    waiting.started ? (waiting.run.startedAt ?? waiting.run.updatedAt) : waiting.run.updatedAt;
  return at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0;
}

export class AutomationService {
  private readonly factories = new Map<string, WorkspaceFactory>();
  private stopTicking: (() => void) | null = null;
  /** Tool runs in progress: by automation key, or a request's own id. One at a time per automation. */
  private readonly inFlight = new Set<string>();
  private ticking = false;
  private started = false;
  private pumping = false;
  /**
   * Running runs with something in flight that a stop cannot reach yet: a
   * legacy run's session being launched or resumed; a steps run's checkout
   * being prepared, or its step's session being launched, resumed or
   * reminded. A steps run starts one thing at a time, so its id is the key.
   */
  private readonly starting = new Set<string>();
  /** Of those, the ones a person asked to stop; honoured as soon as what started has. */
  private readonly stopRequested = new Set<string>();
  /**
   * Steps runs started from the line whose first step is not running yet
   * (preparing their item's checkout, or that step queued), and the lane it
   * runs in. Each holds a slot there from the moment it starts, and its
   * first step takes that slot: no other run can take it meanwhile.
   */
  private readonly admitted = new Map<string, Lane>();
  /** Each run's command now running, from its spawn until its step settles: what a stop or a quit reaches. */
  private readonly runningCommands = new Map<string, RunningCommand>();
  /** Commands a quit let go of: whatever they report afterwards is dropped, so their steps keep their intent. */
  private readonly abandoned = new WeakSet<RunningCommand>();
  /**
   * Failed item runs whose retry is preparing their checkout: each claims its
   * folder and item (`checkoutHeld`) until it is done, while the run itself
   * stays as it was until the preparation succeeds.
   */
  private readonly retrying = new Map<string, { dir: string; itemKey?: string }>();
  /**
   * A step turn whose `init` failed its check, by session: the engine's words
   * for why, which become the step's error when the turn it stopped ends.
   * Memory only: the turn is stopped at once.
   */
  private readonly initFailures = new Map<string, string>();
  private pumpAgain = false;
  /** Each workspace's last save, settled either way: the next one waits for it. */
  private readonly saving = new Map<string, Promise<void>>();
  /**
   * Every poll entry's version that was told it needs Allow (`<key> <version>`),
   * so none is told twice. In memory: a launch records what it finds quietly
   * (`announceAllows`). Allowing one forgets it, so taking it back asks again.
   */
  private readonly allowsAnnounced = new Set<string>();
  /** Whether a version that needs Allow is announced when first seen: once start-up's first sync is done. */
  private announcingAllows = false;
  /**
   * Each poll entry's checks since start-up, by automation key: when the
   * next is due, the one running, what the last found. Memory only: a
   * launch checks every allowed entry at its first tick.
   */
  private readonly checks = new Map<string, CheckState>();
  /** How many checks of each automation have ended since launch, whatever they came to. */
  private readonly checksEnded = new Map<string, number>();
  /** A run on a chosen item waiting for a check: how many had ended when it first came up to start. */
  private readonly checkAwaitedFrom = new Map<string, number>();
  /** Each running check's command, by automation key: what a quit, or deleting its workspace, stops. */
  private readonly checkCommands = new Map<string, RunningCommand>();
  private io: StepIO | undefined;
  constructor(private readonly deps: AutomationServiceDeps) {}

  /** The step tools' logic, over these runs and their folders; the host mounts it on each step session's MCP server. */
  public stepIO(): StepIO {
    this.io ??= new StepIO({
      store: this.deps.store,
      folder: this.deps.runFolder,
      definitionOf: (run) => {
        const workspaceId = run.attribution.workspaceId;
        return workspaceId ? this.deps.runFolder.readDefinition(workspaceId, run.id) : null;
      },
      sessionOf: (sessionId) =>
        this.deps
          .getWorkspaces()
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === sessionId),
      previousOf: (run) => (run.previous ? this.deps.store.get(run.previous.runId) : undefined),
    });
    return this.io;
  }

  public async start(): Promise<void> {
    this.deps.store.load(this.iso());
    this.sweepRunFolders();
    this.started = true;
    await this.syncWorkspaces();
    // A gate that waited while Consola was closed still waits: say so again, once.
    for (const run of this.deps.store.runs()) if (waitingGateOf(run)) this.noticeGate(run);
    this.announcingAllows = true;
    this.stopTicking = this.deps.every(this.deps.tickMs ?? TICK_MS, () => void this.tick());
    // Catch up on anything missed while Consola was closed, and resume
    // whatever was queued when it quit.
    await this.tick();
  }

  /**
   * Remove the run folders history no longer names: once, after the load
   * that applies retention, never as runs are added. Only a workspace that
   * held a steps run can have any. A failure costs disk, not the start.
   */
  private sweepRunFolders(): void {
    const named = new Map<string, Set<string>>();
    for (const run of this.deps.store.runs()) {
      const { workspaceId } = run.attribution;
      if (!workspaceId) continue;
      const names = named.get(workspaceId) ?? new Set<string>();
      names.add(run.id);
      // An unfinished run reads its previous run's folder, even once history dropped that record.
      if (run.previous && !TERMINAL_RUN_STATUSES.includes(run.status))
        names.add(run.previous.runId);
      named.set(workspaceId, names);
    }
    for (const workspaceId of this.deps.store.workspacesWithStepsRuns()) {
      try {
        this.deps.runFolder.sweep(workspaceId, named.get(workspaceId) ?? new Set());
      } catch (error) {
        console.error(`Could not sweep ${workspaceId}'s run folders.`, error);
      }
    }
  }

  /**
   * Quit: let go of every running command, then stop it (SIGTERM to its
   * group, without waiting), so none outlives the app to post after a
   * person retried it. Let go of first, so its exit during the quit is not
   * recorded as a stop: its step keeps its intent-only record, which the
   * next start fails as interrupted. Stop every running check too: what it
   * reports afterwards is dropped, as Consola is no longer running. Then
   * stop ticking and let go of every workspace's folder.
   */
  public shutdown(): void {
    for (const running of this.runningCommands.values()) {
      this.abandoned.add(running);
      running.stop();
    }
    this.runningCommands.clear();
    for (const check of this.checkCommands.values()) check.stop();
    this.checkCommands.clear();
    this.checks.clear();
    this.started = false;
    this.stopTicking?.();
    this.stopTicking = null;
    for (const factory of this.factories.values()) factory.folder.unwatch();
    this.factories.clear();
  }

  /**
   * Follow the workspace list. A new workspace's folder is read and watched; a
   * deleted one's is let go — its schedules stop, and anything waiting in it
   * is dismissed, since there is nowhere left to approve or run it. Every
   * other workspace's entries are resolved again, because what they resolve
   * against — actions, scopes, the provider binding — lives on the record.
   */
  public async syncWorkspaces(): Promise<void> {
    if (!this.started) return;
    const current = new Set(this.deps.getWorkspaces().map((workspace) => workspace.id));

    const removed = [...this.factories.keys()].filter((id) => !current.has(id));
    for (const workspaceId of removed) {
      const factory = this.factories.get(workspaceId)!;
      factory.folder.unwatch();
      this.factories.delete(workspaceId);
      // Its checks have nowhere to report either: their results are dropped, as their entries are gone.
      for (const [key, check] of this.checkCommands)
        if (key.startsWith(`${workspaceId} `)) check.stop();
      for (const run of this.deps.store.runs()) {
        if (
          run.attribution.workspaceId === workspaceId &&
          (run.status === 'needs-approval' || run.status === 'queued')
        ) {
          this.finish(run.id, 'rejected', { summary: 'Its workspace was deleted.' });
        }
        // Its record goes with the workspace: a command it was running has nowhere to report, so it ends.
        if (run.attribution.workspaceId === workspaceId) this.runningCommands.get(run.id)?.stop();
      }
      // A workspace whose file checks has check logs, whether or not a run ever came of them.
      const hasFolders =
        this.deps.store.workspacesWithStepsRuns().has(workspaceId) ||
        factory.resolved.some((entry) => pollOf(entry) !== null);
      this.deps.store.forgetWorkspace(workspaceId);
      // Its applied version goes too, as its run records do.
      try {
        this.deps.appliedStore.forget(factory.folder.folderPath);
      } catch (error) {
        console.error(`Could not forget ${workspaceId}'s applied factory.`, error);
      }
      if (hasFolders) {
        try {
          this.deps.runFolder.removeAll(workspaceId);
        } catch (error) {
          console.error(`Could not remove ${workspaceId}'s run folders.`, error);
        }
      }
    }

    // Registered before anything is awaited, so a second sync arriving
    // meanwhile sees the workspace as known rather than adding it twice.
    const added = [...current].filter((id) => !this.factories.has(id));
    for (const workspaceId of added) {
      const folder = this.deps.folderFor(workspaceId);
      this.factories.set(workspaceId, {
        folder,
        read: notRead(),
        resolved: [],
        warnings: [],
        storeRead: false,
        applied: null,
      });
      folder.watch(() => {
        this.reload(workspaceId).catch((error: unknown) => {
          console.error(`Could not reload ${workspaceId}'s factory folder.`, error);
        });
      });
    }

    // Settings and harness edits re-check without touching the files: a
    // harness turned off can stop a changed entry from applying, and turned
    // on again, let it. Broadcast only what changed: this runs on every
    // workspace write, session clicks included, and reads nothing of the
    // applied version. A template's `missing` follows the same settings, and
    // a harness's answer can change only the notices (a server that needs a
    // sign-in), which the windows must hear too.
    const settingsView = (workspaceId: string, factory: WorkspaceFactory) =>
      stableStringify([
        this.list(workspaceId),
        this.templatesOf(workspaceId, factory),
        factory.standing?.decision ?? null,
        factory.warnings,
      ]);
    const runningOf = (factory: WorkspaceFactory) =>
      stableStringify(factory.resolved.map(scheduleKey));
    let runningChanged = false;
    for (const [workspaceId, factory] of this.factories) {
      if (added.includes(workspaceId)) continue;
      const before = settingsView(workspaceId, factory);
      const running = runningOf(factory);
      this.reapply(workspaceId, factory);
      if (runningOf(factory) !== running) runningChanged = true;
      if (settingsView(workspaceId, factory) !== before) this.broadcast(workspaceId);
    }

    // Every file is read before schedules are reconciled: reconciling
    // while one is unread would forget its fire times, and with them the
    // catch-up for whatever it missed while Consola was closed. A re-check
    // that changed what runs reconciles too: an entry that just applied
    // starts its schedule now.
    // One workspace's folder never stops another's: a load that throws is logged, and the rest go on.
    const loads = await Promise.allSettled(added.map((workspaceId) => this.load(workspaceId)));
    loads.forEach((load, index) => {
      if (load.status === 'rejected')
        console.error(`Could not load ${added[index]}'s factory folder.`, load.reason);
    });
    if (added.length > 0 || removed.length > 0 || runningChanged) this.settleSchedules();
    // A settings edit can change a poll entry's version too: an action a step names.
    for (const workspaceId of this.factories.keys()) this.announceAllows(workspaceId);
    for (const workspaceId of added) this.broadcast(workspaceId);
    // A session closed mid-turn never reports its exit (closing drops the
    // terminal's listeners): its run ends here, and its slot frees.
    for (const run of this.deps.store.runs()) {
      if (run.status === 'running' && run.sessionId && isAgentRun(run) && !this.sessionOf(run)) {
        this.finish(run.id, 'failed', { error: 'Its session was closed before it finished.' });
      }
    }
    // The same for a step's session, whatever its definition says: its slot
    // frees either way. A started steps run whose definition went with its
    // folder has nothing left to run: it ends here too. One whose
    // definition fails to read now is left as it is: a later look may
    // read it.
    for (const run of this.deps.store.runs()) {
      if (run.status !== 'running' || !isStepsRun(run)) continue;
      const closed = run.steps?.find(
        (step) =>
          step.kind === 'agent' &&
          step.status === 'running' &&
          step.sessionId &&
          !this.sessionNamed(run, step.sessionId),
      );
      // The person closed it: as for a one-step run, there is nothing to tell them.
      if (closed) {
        this.settleStep(
          run.id,
          closed.id,
          { status: 'failed', error: 'Its session was closed before it finished.' },
          { quiet: true },
        );
        continue;
      }
      const loaded = this.definitionOf(run);
      if ('problem' in loaded) {
        if (loaded.gone) this.failRun(run.id, loaded.problem);
        else
          console.error(
            `Run ${run.id}'s definition could not be read; it is left as it is.`,
            loaded.error,
          );
      }
    }
    void this.pump();
  }

  /** Re-read one workspace's folder: when a file in it changes, and after "Open file" creates factory.yml. */
  public async reload(workspaceId: string): Promise<void> {
    if (!(await this.load(workspaceId))) return;
    this.settleSchedules();
    this.announceAllows(workspaceId);
    this.broadcast(workspaceId);
  }

  /** Check again: re-read the folder and re-check what applies, as a change to one of its files would. */
  public async recheck(workspaceId: string): Promise<void> {
    await this.reload(workspaceId);
  }

  /**
   * Tell the person, once per (automation, version), that a poll entry is
   * not checking until they allow it: "changed" when an earlier version
   * was allowed, else "needs your OK". At start-up a version is recorded
   * without a notice, unless an earlier one was allowed (it was edited
   * while Consola was closed): one never allowed was announced in the
   * session it appeared in, so a launch does not nag about it again.
   */
  private announceAllows(workspaceId: string): void {
    for (const entry of this.factories.get(workspaceId)?.resolved ?? []) {
      if (!this.needsAllow(entry)) continue;
      const key = automationKey(entry);
      const announced = `${key} ${entry.version}`;
      if (this.allowsAnnounced.has(announced)) continue;
      this.allowsAnnounced.add(announced);
      const allowedBefore = this.deps.store.acceptedVersion(key) !== undefined;
      if (!allowedBefore && !this.announcingAllows) continue;
      const name = entry.automation.name;
      this.deps.notify({
        title: allowedBefore
          ? `\`${name}\` changed, and has stopped checking until you allow it`
          : `\`${name}\` needs your OK to start checking`,
        body: 'Review it in Consola.',
        workspaceId,
        automation: name,
        needsApproval: false,
      });
    }
  }

  /**
   * Whether a poll entry's check command waits for a person's Allow: it has
   * no problem, and the version they allowed (if any) is not this one. It
   * does not check meanwhile, in any mode.
   */
  private needsAllow(entry: Resolved): boolean {
    return (
      pollOf(entry) !== null &&
      !entry.problem &&
      this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version
    );
  }

  /**
   * The workspace's file, created from the template when missing; for
   * "Open file". The file it creates holds no live automation, whatever the
   * workspace has (decision 11): review-assigned-prs is there commented out,
   * ready to uncomment. An existing file is opened as it is.
   */
  public async ensureFile(workspaceId: string): Promise<string> {
    const filePath = await this.factoryOf(workspaceId).folder.ensureExists(
      factoryTemplate({ reviewsLive: false }),
    );
    await this.reload(workspaceId);
    return filePath;
  }

  /**
   * One of the folder's own files, for "Open": `factory.yml` through
   * `ensureFile` (created from the template when missing, as before), any
   * other file by its path in the folder. A path that is none of the folder's
   * own files (`../x`, `runs/r1`) is refused, never resolved.
   */
  public async factoryFilePath(workspaceId: string, relative = 'factory.yml'): Promise<string> {
    if (relative === 'factory.yml') return this.ensureFile(workspaceId);
    const filePath = this.factoryOf(workspaceId).folder.pathOf(relative);
    if (filePath === null) throw new Error(`Not a file of this factory: \`${relative}\`.`);
    return filePath;
  }

  /**
   * The panel's "Review PRs assigned to me automatically": add
   * review-assigned-prs to the workspace's file — the template, with the
   * entry live, when there is no file; otherwise one more entry at the end,
   * every other line left as it was. The one place Consola writes it live,
   * because the person asked. In `auto`, so it asks once before the first
   * review, with every command shown.
   */
  public async addAssignedReviews(workspaceId: string): Promise<void> {
    if (!this.hasReviewAccount(workspaceId)) throw new Error(`${GITHUB.missing} first.`);
    const { folder } = this.factoryOf(workspaceId);
    // Read now: wherever an entry of that name is written, by name as written.
    const where = await folder.whereIs(ASSIGNED_REVIEWS_NAME);
    if (where !== null) {
      throw new Error(
        `${homeFile(ASSIGNED_REVIEWS_NAME, where)} already has ${ASSIGNED_REVIEWS_NAME}.`,
      );
    }
    if ((await folder.readText()) !== null) await folder.appendAutomation(assignedReviewsEntry());
    else await folder.ensureExists(factoryTemplate({ reviewsLive: true }));
    await this.reload(workspaceId);
  }

  /** Whether the workspace has the account automatic reviews post as: the template's own need, so the banner and the card agree. */
  private hasReviewAccount(workspaceId: string): boolean {
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    return workspace !== undefined && GITHUB.met(workspace);
  }

  /**
   * Whether to offer automatic reviews: the workspace can run them (a GitHub
   * account; the entry needs no action), its factory.yml loads, and nothing in
   * its folder already reviews requests or assignments — or goes by that name.
   */
  private assignedReviewsSuggestion(workspaceId: string, factory: WorkspaceFactory): boolean {
    if (!this.hasReviewAccount(workspaceId)) return false;
    const { parse } = factory.read;
    if (parse.issues.some((issue) => issue.file === 'factory.yml' && !isEntryIssue(issue)))
      return false;
    return !parse.automations.some(coversAssignedReviews);
  }

  /**
   * Add or replace one entry in a workspace's factory folder: an agent's
   * `save_automation`, and a template's "Add". The entry is checked the way
   * the runner checks it — parsed on its own, then resolved against this
   * workspace and the folder's agents, harnesses included — and refused,
   * with every reason, if it would not run; a refusal leaves every file as
   * it was. A new entry goes to factory.yml; a name already in the folder
   * is replaced where it lives (in factory.yml, or its own automation file)
   * only when `replace` says so. Saves in one workspace run one at a time,
   * each reading what the last one wrote.
   *
   * Whatever it writes asks once before its next unattended run, even a
   * schedule-only change the version would not notice; a hand edit keeps
   * asking only when what the entry does changed. With `by`, the entry is
   * marked as that session's addition until a person looks at it.
   */
  public saveEntry(
    workspaceId: string,
    entryYaml: string,
    options: SaveEntryOptions,
  ): Promise<SavedAutomation> {
    const previous = this.saving.get(workspaceId) ?? Promise.resolve();
    const saved = previous.then(() => this.writeEntry(workspaceId, entryYaml, options));
    const settled = saved.then(
      () => undefined,
      () => undefined,
    );
    this.saving.set(workspaceId, settled);
    void settled.then(() => {
      if (this.saving.get(workspaceId) === settled) this.saving.delete(workspaceId);
    });
    return saved;
  }

  private async writeEntry(
    workspaceId: string,
    entryYaml: string,
    options: SaveEntryOptions,
  ): Promise<SavedAutomation> {
    const parsed = parseAutomationEntry(entryYaml);
    if (!parsed.ok) throw notSaved(parsed.issues.map(describeIssue));
    const { automation, item } = parsed;
    const { name } = automation;
    const factory = this.factoryOf(workspaceId);
    const { folder } = factory;
    // Read now, not as last loaded: the person may have edited it since.
    const text = await folder.readText().catch((error: unknown) => {
      throw notSaved([describeError(error)]);
    });
    const broken =
      text === null ? [] : parseFactorySpec(text).issues.filter((issue) => !isEntryIssue(issue));
    if (broken.length > 0) {
      throw notSaved([
        `factory.yml does not load (${broken.map(describeIssue).join('; ')}); fix it by hand first`,
      ]);
    }
    // Against the folder's agents as last read: an agent its steps name must be there, and valid.
    const troubled = agentWithProblems(automation, factory.read.parse);
    if (troubled) throw notSaved([troubled]);
    const resolved = this.resolve(
      workspaceId,
      automation,
      factory.read.parse.agents,
      factory.read.parse.skills,
    );
    // A CLI that could not be asked is no fault of the entry: it is saved, and shows that problem.
    if (resolved.problem && !resolved.unasked) throw notSaved([resolved.problem]);
    // By name as written, so an entry that fails to load still holds its name.
    const where = await folder.whereIs(name).catch((error: unknown) => {
      throw notSaved([describeError(error)]);
    });
    if (where !== null && !options.replace) {
      throw notSaved([
        `${homeFile(name, where)} already has an automation named "${name}"; pass replace: true to replace it, or choose another name`,
      ]);
    }
    try {
      // An entry in a file of its own is replaced there, whole.
      if (where === 'file') await folder.writeAutomationFile(name, automationFileText(item));
      else {
        // A file of its own, not "Open file"'s template: nothing is added beside the entry unasked.
        if (text === null) await folder.ensureExists(EMPTY_FACTORY_FILE);
        if (where === 'factory.yml') await folder.replaceAutomation(name, item);
        else await folder.appendAutomation(item);
      }
    } catch (error) {
      throw notSaved([describeError(error)]);
    }
    const key = automationKey({ workspaceId, automation });
    this.deps.store.revokeAcceptance(key);
    this.deps.store.markRevoked(key, this.iso());
    if (options.by) this.deps.store.markAdded(key, { ...options.by, at: this.iso() });
    await this.reload(workspaceId);
    // Again once it is live: a run fired while the file was being reloaded was of the entry before.
    this.deps.store.markRevoked(key, this.iso());
    const after = this.factories.get(workspaceId);
    // Saved but not running: the folder does not apply, and the version before keeps running.
    const standing = after?.standing;
    const live = standing
      ? undefined
      : after?.resolved.find((candidate) => candidate.automation.name === automation.name);
    const line = live?.automation.line;
    // A poll entry it wrote does not check until a person allows it, whoever saved it.
    const waits = live !== undefined && this.needsAllow(live);
    return {
      name,
      file: homeFile(name, where ?? 'factory.yml'),
      replaced: where !== null,
      entry: item,
      ...(line ? { line } : {}),
      ...(waits ? { needsAllow: true as const } : {}),
      ...(standing
        ? {
            notApplied: {
              // What blocks it, then what it waits for: a check under way is said too, never silence.
              issues: [...standing.decision.blocking, ...(standing.decision.waiting ?? [])].map(
                describeBlocking,
              ),
              since: describeAppliedAt(standing.appliedAt, this.deps.now()),
            },
          }
        : {}),
    };
  }

  /**
   * The Templates tab's "Add": the template's entry, as-is, through
   * `saveEntry`. Refused while the workspace lacks what it needs.
   */
  public async addTemplate(workspaceId: string, templateId: string): Promise<void> {
    const template = AUTOMATION_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) throw new Error(`There is no template "${templateId}".`);
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}.`);
    const missing = template.missing(workspace);
    if (missing) throw new Error(`Not added: ${missing}.`);
    await this.saveEntry(workspaceId, template.entry(workspace), { replace: false });
  }

  /**
   * One entry exactly as its file has it: a factory.yml entry as its
   * `- name: …` item, and an entry in `automations/<name>.yaml` as that whole
   * file, so its lines are the file's own. Null when there is no such entry.
   * While the folder does not apply, the entry as the running version has
   * it, not the live file: Allow accepts that version, so the person reads
   * exactly what they accept.
   */
  public async entryText(workspaceId: string, name: string): Promise<string | null> {
    const factory = this.factoryOf(workspaceId);
    if (factory.standing && factory.applied) return appliedEntryText(factory.applied, name);
    const live = await this.liveEntry(workspaceId, name);
    return live === null ? null : live.text;
  }

  /**
   * The agents an entry's steps run as, each once in step order, as the
   * version it lists has them (`version`, what Allow accepts): while the
   * folder does not apply, the applied version's agents, never the live
   * files. Null when there is no such entry.
   */
  public entryAgents(workspaceId: string, name: string): EntryAgentsView | null {
    const entry = this.factoryOf(workspaceId).resolved.find(
      (candidate) => candidate.automation.name === name,
    );
    if (!entry) return null;
    const agents: EntryAgentsView['agents'] = [];
    if (isStepsEntry(entry.automation)) {
      for (const step of leafSteps(entry.automation.steps)) {
        if (step.kind !== 'agent' || step.agent === undefined) continue;
        if (agents.some((agent) => agent.name === step.agent)) continue;
        const agent = entry.agents?.[step.agent];
        if (!agent || !Object.prototype.hasOwnProperty.call(entry.agents, step.agent)) continue;
        agents.push({
          name: agent.name,
          file: `agents/${agent.name}.md`,
          ...(agent.description !== undefined ? { description: agent.description } : {}),
          ...(agent.harness !== undefined ? { harnessId: agent.harness } : {}),
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
          body: agent.body,
          mcpServers: agent.mcpServers.map((server) => ({
            name: server.name,
            ...(server.tools !== undefined ? { tools: [...server.tools] } : {}),
          })),
          skills: [...agent.skills],
          // Each skill as the version holds it, so the card shows what Allow accepts (review M4).
          ...(agent.skills.length > 0
            ? {
                skillTexts: agent.skills.flatMap((skill) => {
                  const held = entry.skills?.[skill];
                  return held && Object.prototype.hasOwnProperty.call(entry.skills, skill)
                    ? [{ name: skill, text: skillMarkdown(held.files) }]
                    : [];
                }),
              }
            : {}),
        });
      }
    }
    return { version: entry.version, readsItems: entryReadsItems(entry.automation), agents };
  }

  /**
   * One entry as a `- name: …` item, read from the live file: what an agent
   * changing it is shown, to save back with `replace: true`. An automation
   * file's entry is that file as an item (`automationItemText`).
   */
  public async entryItem(workspaceId: string, name: string): Promise<string | null> {
    const live = await this.liveEntry(workspaceId, name);
    if (live === null) return null;
    return live.where === 'factory.yml' ? live.text : automationItemText(name, live.text);
  }

  /** An entry as its file has it now, wherever it lives: factory.yml first, as `whereIs` decides. */
  private async liveEntry(
    workspaceId: string,
    name: string,
  ): Promise<{ where: 'factory.yml' | 'file'; text: string } | null> {
    const { folder } = this.factoryOf(workspaceId);
    const yml = await folder.readText();
    const item = yml === null ? null : automationEntryText(yml, name);
    if (item !== null) return { where: 'factory.yml', text: item };
    // A name that is no name has no file: never a path.
    if (!AUTOMATION_NAME_PATTERN.test(name)) return null;
    const text = await folder.readAutomationFile(name);
    return text === null ? null : { where: 'file', text };
  }

  /** A person opened an agent-added entry's details: it is no longer new. */
  public acknowledge(workspaceId: string, name: string): void {
    const key = automationKey({ workspaceId, automation: { name } });
    const added = this.deps.store.addedBy(key);
    if (!added || added.seen) return;
    this.deps.store.acknowledgeAdded(key);
    this.broadcast(workspaceId);
  }

  /** What an agent writing an entry for this workspace needs to know: `automation_capabilities`. */
  public capabilities(workspaceId: string): AutomationCapabilities {
    const factory = this.factoryOf(workspaceId);
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    const { parse } = factory.read;
    // An entry that fails to load still holds its name.
    const named = [
      ...parse.automations.map((automation) => automation.name),
      ...parse.issues.flatMap((issue) => issue.automation ?? []),
    ];
    return describeCapabilities({
      filePath: factory.folder.filePath,
      fileExists: factory.read.exists,
      folderPath: factory.folder.folderPath,
      // The folder's agents as last read: what a step's `agent:` may name.
      agents: Object.values(parse.agents).map((agent) => ({
        name: agent.name,
        ...(agent.description !== undefined ? { description: agent.description } : {}),
        ...(agent.harness !== undefined ? { harness: agent.harness } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
        mcpServers: agent.mcpServers.map((server) => server.name),
        skills: [...agent.skills],
      })),
      harnesses: (this.deps.listHarnesses?.() ?? [])
        .filter((harness) => harness.enabled && !harness.archived)
        .map((harness) => ({
          id: harness.id,
          name: harness.name,
          ...(harness.servers !== undefined ? { servers: [...harness.servers] } : {}),
        })),
      tools: this.deps.registry.list().filter((tool) => tool.automatable),
      actions: workspace?.actions ?? [],
      scopes: workspace?.scopes ?? [],
      taken: [...new Set(named)],
      boundConnection: workspace?.provider?.id ?? null,
      harness: {
        name: this.deps.agentHarness(workspaceId).name,
        problem: this.harnessProblem(workspaceId),
        stepProblem:
          this.harnessProblem(workspaceId) === null ? this.stepHarnessProblem(workspaceId) : null,
      },
    });
  }

  /** The templates as this workspace's Templates tab shows them. */
  private templatesOf(workspaceId: string, factory: WorkspaceFactory): TemplateView[] {
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    return workspace
      ? templateViews(workspace, factory.read.parse.automations, this.deps.now())
      : [];
  }

  /** Start the checks that are due, fire everything else that is, and start what the queue has room for. Public so wake-from-sleep can call it. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.runDueChecks();
      const now = this.deps.now();
      for (const entry of this.allResolved()) {
        // A run still in progress keeps the occurrence for a later
        // tick rather than silently consuming it.
        if (!cronOf(entry) || entry.problem || this.inFlight.has(automationKey(entry))) continue;
        if (!this.factories.has(entry.workspaceId)) continue; // Deleted mid-tick.
        const due = this.nextDue(entry, now);
        if (!due || due.getTime() > now.getTime()) continue;
        // Recorded before running, so a slow run or a crash can never
        // make the same occurrence fire twice.
        this.deps.store.setLastFired(scheduleKey(entry), now.toISOString());
        const catchUp = now.getTime() - due.getTime() > 2 * TICK_MS;
        await this.fire(entry, {
          kind: 'cron',
          at: due.toISOString(),
          ...(catchUp ? { catchUp } : {}),
        }).catch((error) =>
          console.error(`Automation ${entry.automation.name} could not start.`, error),
        );
      }
    } finally {
      this.ticking = false;
    }
    await this.pump();
  }

  /**
   * One workspace's Inbox, freshly fetched: each event automation's set,
   * every item in any of its events' views, fires under the one rule polls
   * follow too (`fireFromSet`). A failed fetch — the last good list carried
   * forward with an error — says nothing about what changed, so it fires
   * nothing and moves nothing. An Inbox item carries no revision: a record
   * from before revisions reads as it did.
   */
  public observeInbox(snapshot: ItemSnapshot): void {
    if (!this.started || snapshot.error || snapshot.fetchedAt === 0) return;
    const factory = this.factories.get(snapshot.workspaceId);
    if (!factory) return;
    const at = new Date(snapshot.fetchedAt).toISOString();
    for (const entry of factory.resolved) {
      const { event } = entry;
      // An entry with a problem is paused: its record stays where it
      // was, so fixing it catches up rather than forgetting.
      if (!event || entry.problem) continue;
      const inSet = new Map<string, SourceItem>();
      for (const item of snapshot.items) {
        // The set, not the filter: a draft is in it, and fires once it is ready.
        if (event.inSet(item))
          inSet.set(event.keyOf(item), event.toSourceItem(item, event.passesFilter(item)));
      }
      this.fireFromSet(entry, [...inSet.values()], at);
    }
    void this.pump();
  }

  /**
   * One successful look at an entry's source (an Inbox fetch, or a check),
   * whatever the source: its set, compared with what it held last time
   * (`advanceSeen`). An item fires when it passes and is new to the set, or
   * its revision moved; one whose run on it is still open is absorbed by a
   * run waiting for a person or a slot, or held until a working one ends
   * (`openStates`). Each item fired is one run.
   *
   * The seen record is written before any run is created, so a crash can
   * never fire one change twice. An entry with no record of its own — new,
   * or with what it watches edited — records what is there and fires
   * nothing: turning one on never works through the backlog already
   * waiting, the same rule as a new schedule never firing for a past
   * occurrence. A record that survived a restart is diffed as usual, so what
   * arrived while Consola was closed fires once. Returns how many fired, and
   * whether this look only recorded what is there.
   */
  private fireFromSet(
    entry: Resolved,
    current: SourceItem[],
    at: string,
  ): { fired: number; baseline: boolean } {
    const key = automationKey(entry);
    const provider = this.deps
      .getWorkspaces()
      .find((workspace) => workspace.id === entry.workspaceId)?.provider;
    const definition = listDefinition(entry, provider);
    const previous = this.deps.store.seen(key);
    const open = this.openStates(entry);
    const { record, fire } = advanceSeen(
      previous,
      definition,
      current.map((item) => ({
        key: item.key,
        passes: item.passes,
        ...(item.rev !== undefined ? { rev: item.rev } : {}),
        ...(open.has(item.key) ? { open: open.get(item.key) } : {}),
      })),
      at,
    );
    this.deps.store.setSeen(key, record);
    const byKey = new Map(current.map((item) => [item.key, item]));
    // Only a record of the same list fires anything, so `previous` is there.
    for (const itemKey of fire)
      this.fireItem(entry, byKey.get(itemKey)!, {
        since: previous!.at,
        at,
        firedUnder: definition,
      });
    return { fired: fire.length, baseline: previous?.definition !== definition };
  }

  /**
   * Each item's open run of this automation (Call 11): the newest one not
   * ended. `not-started` while it waits for a person's approval, or in line
   * without ever having started (it absorbs a new revision); `working` once
   * started, a turn a quit interrupted and now waiting to resume included,
   * and a run `waiting` at a gate or a declared retry (it holds the
   * revision). Firing reads the status, the safer default (review M3): in
   * 3-A every `waiting` run is one that holds (`holdsWhileWaiting`); slice
   * 4's waits that consume what they waited for must read the case here.
   */
  private openStates(entry: Resolved): Map<string, OpenState> {
    const open = new Map<string, OpenState>();
    // Newest first: the first one seen for a key is its newest.
    for (const run of this.deps.store.runs()) {
      const itemKey = run.trigger.item?.key;
      if (itemKey === undefined || open.has(itemKey) || !isRunOf(run, entry)) continue;
      if (run.status === 'needs-approval' || (run.status === 'queued' && !run.startedAt))
        open.set(itemKey, 'not-started');
      else if (run.status === 'running' || run.status === 'queued' || run.status === 'waiting')
        open.set(itemKey, 'working');
    }
    return open;
  }

  /**
   * A session's unattended turn ended: its run, or its step, is done one
   * way or the other, and its slot is free. The run is the session's
   * `running` one — a later exit of the same session, the person
   * continuing it, is not.
   * Says whether the run completed, which is a result waiting to be looked at.
   * A step's session never is: its run goes on, and what it found is the run's.
   */
  public turnEnded(sessionId: string, outcome: TurnOutcome): { completed: boolean } {
    const step = this.runningStepOf(sessionId);
    if (step) {
      this.stepTurnEnded(step.run, step.record, outcome, sessionId);
      return { completed: false };
    }
    const run = this.deps.store
      .runs()
      .find(
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.status === 'running' &&
          isAgentRun(candidate),
      );
    if (!run) return { completed: false };
    const name = this.sessionOf(run)?.name ?? 'its session';
    let notice: { title: string; body: string };
    let completed = false;
    const error = turnFailure(outcome);
    if (error) {
      this.finish(run.id, 'failed', { error });
      notice = { title: `${run.automationId} did not finish`, body: error };
    } else {
      this.finish(run.id, 'completed', { summary: `Ready in “${name}”.` });
      completed = true;
      const item = (run.result as AgentRunPreview).item?.label;
      notice = {
        title: `${run.automationId}: ready`,
        body: `${item ?? name} — the findings are waiting. Click to open them.`,
      };
    }
    // The click opens the session, where the findings — or the reason — are.
    const { workspaceId } = run.attribution;
    if (workspaceId)
      this.deps.notify({ ...notice, runId: run.id, workspaceId, needsApproval: false, sessionId });
    void this.pump();
    return { completed };
  }

  /**
   * A step's turn printed its `system/init`. The model it names goes on the
   * step at once, so the run page shows it while the turn runs. Every server
   * the step's agent grants must be there and connected: the CLI would run
   * the turn without one, so the turn is stopped, and the step fails in the
   * engine's words when it ends (`initFailures`). So it is when the turn
   * loaded a server it was not given (review M3). Only a running step's
   * session is heard; anything else is ignored, and so is a run whose
   * definition cannot be read, which fails when its turn ends.
   */
  public turnStarted(sessionId: string, init: TurnInitView): void {
    const step = this.runningStepOf(sessionId);
    if (!step) return;
    const { run, record } = step;
    if (init.model !== undefined) {
      this.writeSteps(run.id, withStep(this.stepsOf(run.id), record.id, { model: init.model }));
      this.broadcastRun(run.id);
    }
    const loaded = this.definitionOf(run);
    if (!('definition' in loaded)) return;
    const required = requiredServers(loaded.definition, record.id);
    if (required.length === 0) return;
    // A server it was not given comes first: the CLI started it beside the step (review M3).
    const stray = strayServerProblem(required, init);
    const problem =
      stray ?? initProblem(required, init, this.stepHarnessName(run, loaded.definition, record.id));
    if (!problem) return;
    this.initFailures.set(sessionId, problem);
    const session = this.sessionNamed(run, sessionId);
    if (session)
      this.deps.stopAgent(
        session,
        stray ? 'it loaded a server it was not given' : 'a server it needs was not connected',
      );
  }

  /**
   * The display name of the harness a step ran on: its agent's (from its
   * definition snapshot, asked with nothing to compile, so it starts no
   * probe), else the workspace's default. What the `init` check's words name.
   */
  private stepHarnessName(run: RunRecord, definition: RunDefinition, stepId: string): string {
    return this.deps.agentHarness(
      run.attribution.workspaceId ?? '',
      stepHarnessQuery(definition, stepId),
    ).name;
  }

  /**
   * Run one of a workspace's automations now: its panel's Run now or Run
   * on…, Run again, or an agent's `run_automation`. With a target, it runs
   * on that item (`runOn`), whatever fires it otherwise. An entry whose
   * runs take an item never runs without one: a person's Run now on an
   * event or poll automation is its "Check now", which fetches the Inbox or
   * runs its check (refused until it is allowed), and only what is new
   * fires, so it returns null; one on demand asks for an item; and an agent
   * is told which argument names one.
   */
  public async trigger(
    workspaceId: string,
    name: string,
    actor: { sessionId?: string } = {},
    target?: ItemTarget,
  ): Promise<RunRecord | null> {
    const factory = this.factoryOf(workspaceId);
    const entry = factory.resolved.find((candidate) => candidate.automation.name === name);
    if (!entry) throw new Error(`No automation named "${name}" in ${factory.folder.filePath}.`);
    if (entry.problem) throw new Error(`${name} cannot run: ${entry.problem}`);
    if (target !== undefined) return this.runOn(entry, target, actor);
    const { source } = entry;
    if (source) {
      if (actor.sessionId) {
        const argument =
          source.connection === undefined ? 'item_key' : 'work_item { repo, number, type }';
        throw new Error(`${name} runs on an item: pass ${argument}`);
      }
      if (entry.automation.trigger.kind === 'manual') throw new Error('Pick an item to run it on.');
      if (pollOf(entry)) this.checkNow(entry);
      else if (entry.event) await this.deps.refreshInbox(workspaceId);
      return null;
    }
    // An agent never replaces a plan a person may be reviewing, nor
    // notifies them again about it: it gets the waiting run back.
    if (actor.sessionId) {
      const pending = this.deps.store
        .runs()
        .find((run) => isRunOf(run, entry) && run.status === 'needs-approval');
      if (pending) return pending;
    }
    return this.fire(entry, {
      kind: 'manual',
      at: this.iso(),
      by: actor.sessionId ? 'agent' : 'person',
      ...(actor.sessionId ? { actorId: actor.sessionId } : {}),
    });
  }

  /**
   * A run on the item a person or an agent picked, through the entry's
   * mode (`effectiveMode`): `confirm` previews and waits, and an agent's
   * request always waits. While a run of this automation on the item is
   * open, that run is returned instead. The filter is not applied, nor the
   * still-in-the-set and started-by-hand checks: the person chose this
   * item. It counts as the item's fire: when the item is in the trigger's
   * set, its seen record marks it fired at its current revision (or keeps
   * the one it had, when none is known), written before the run exists, as
   * a source's fire is. Its trigger is `manual`, so it is never given back.
   */
  private runOn(entry: Resolved, target: ItemTarget, actor: { sessionId?: string }): RunRecord {
    const { source } = entry;
    if (!source) throw new Error(`${entry.automation.name} takes no item.`);
    const item = this.targetItem(entry, source, target);
    const open = this.deps.store
      .runs()
      .find((run) => isRunOf(run, entry) && run.trigger.item?.key === item.key && isLiveRun(run));
    if (open) return open;
    const trigger: RunTrigger = {
      kind: 'manual',
      at: this.iso(),
      by: actor.sessionId ? 'agent' : 'person',
      ...(actor.sessionId ? { actorId: actor.sessionId } : {}),
      ...(item.workItem && source.connection !== undefined
        ? { connection: source.connection }
        : {}),
      item: source.runItem(item),
    };
    const key = automationKey(entry);
    const record = this.deps.store.seen(key);
    if (record?.items.includes(item.key))
      this.deps.store.setSeen(key, markFired(record, item.key, item.rev));
    return entry.steps
      ? this.fireSteps(entry, trigger, item)
      : this.fireAgentOnItem(entry, trigger, item);
  }

  /**
   * The item a target names, as the entry's source has it now, or why the
   * entry does not take it. A poll with `key:` takes the key of an item in
   * its last successful check. Every other entry takes a work item of its
   * connection, by identity or by URL, of a type its items have: for a poll
   * with `item:`, the object its last check printed for it; for an event or
   * a run on demand, the Inbox's item. When the source does not have it,
   * the work item's identity alone, titled as Consola titles one ("PR
   * #51"); a poll's run writes that identity as its `item.json`, since
   * every `run:` step of it is told where that file is.
   */
  private targetItem(entry: Resolved, source: ItemSource, target: ItemTarget): SourceItem {
    const { name } = entry.automation;
    const notTaken = () => new Error(`${name} takes ${itemsInWords(source)}.`);
    const lastCheck = () => latestResult(this.checks.get(automationKey(entry)), entry.version);
    const { connection } = source;
    if (connection === undefined) {
      if (!('key' in target) || typeof target.key !== 'string') throw notTaken();
      const items = lastCheck();
      if (!items) throw new Error('No successful check yet: Check now first.');
      const polled = items.find((candidate) => candidate.key === target.key);
      if (!polled) throw new Error(`No item with key "${target.key}" in its last check.`);
      return polledSourceItem(polled, true);
    }
    const ref = this.targetRef(connection, target);
    if (!ref) throw notTaken();
    if (!source.itemTypes.includes(ref.type)) {
      const noun = ref.type === 'pr' ? 'a pull request' : 'an issue';
      throw new Error(
        `${ref.repo}#${ref.number} is ${noun}; ${name} takes ${itemsInWords(source)}.`,
      );
    }
    // Refused before anything is marked or started, so it fires once the repository is cloned.
    const notCloned = this.notClonedReason(entry.workspaceId, ref);
    if (notCloned) throw new Error(notCloned);
    const key = this.deps.workItems.keyOf(ref);
    const poll = pollOf(entry);
    if (poll) {
      const polled = lastCheck()?.find((candidate) => candidate.key === key);
      if (polled) return polledSourceItem(polled, true);
    } else {
      const inbox = this.deps
        .inboxSnapshot(entry.workspaceId)
        ?.items.find((candidate) => candidate.key === key);
      if (inbox) return inboxSourceItem(inbox);
    }
    const url = this.deps.workItems.urlOf(ref);
    const identity: SourceItem = {
      key,
      passes: true,
      title: fallbackWorkItemTitle(ref),
      url,
      workItem: ref,
    };
    return poll
      ? { ...identity, object: { key, url, repo: ref.repo, number: ref.number, type: ref.type } }
      : identity;
  }

  /** Why Run on… cannot take a work item: its repository is in none of the workspace's scopes. Null when it can. */
  private notClonedReason(workspaceId: string, ref: ItemRef): string | null {
    return this.deps.workItems.inWorkspace(workspaceId, ref)
      ? null
      : `${ref.repo} is not cloned in this workspace.`;
  }

  /** The work item a target names on `connection`; null for one that names none (a key, or a work item of no shape). */
  private targetRef(connection: string, target: ItemTarget): ItemRef | null {
    if ('url' in target && typeof target.url === 'string') {
      const ref = this.deps.workItems.parseUrl(connection, target.url);
      if (!ref) throw new Error(`That is not a ${connection} pull request or issue URL.`);
      return ref;
    }
    if (!('workItem' in target)) return null;
    // Checked here as well as where it came in: an agent's arguments and IPC reach this one way or another.
    const named: { repo?: unknown; number?: unknown; type?: unknown } = target.workItem ?? {};
    const { repo, number, type } = named;
    if (
      typeof repo !== 'string' ||
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number <= 0
    )
      return null;
    if (type !== 'pr' && type !== 'issue') return null;
    return { provider: connection, repo, number, type };
  }

  /**
   * What Run on… offers for an automation whose runs take an item: its
   * poll's last successful check, in its order, and, for one on work items,
   * the Inbox's items of a type it takes; each with this automation's
   * newest run on it. Read from memory and run history only: opening the
   * picker starts nothing.
   */
  public listRunTargets(workspaceId: string, name: string): ItemTargets {
    const factory = this.factoryOf(workspaceId);
    const entry = factory.resolved.find((candidate) => candidate.automation.name === name);
    if (!entry) throw new Error(`No automation named "${name}" in ${factory.folder.filePath}.`);
    if (entry.problem) throw new Error(`${name} cannot run: ${entry.problem}`);
    const { source } = entry;
    const takesItem = takesItemOf(entry);
    if (!source || !takesItem) throw new Error(`${name} takes no item.`);
    const lastRuns = new Map<string, NonNullable<ItemTargetRow['lastRun']>>();
    // Newest first: the first one seen for a key is its newest.
    for (const run of this.deps.store.runs()) {
      const itemKey = run.trigger.item?.key;
      if (itemKey === undefined || lastRuns.has(itemKey) || !isRunOf(run, entry)) continue;
      lastRuns.set(itemKey, {
        id: run.id,
        status: run.status,
        at: run.finishedAt ?? run.createdAt,
      });
    }
    const row = (target: ItemTarget, item: SourceItem): ItemTargetRow => {
      const lastRun = lastRuns.get(item.key);
      const unavailable = item.workItem ? this.notClonedReason(workspaceId, item.workItem) : null;
      return {
        target,
        label: source.label(item),
        url: item.url,
        ...(lastRun ? { lastRun } : {}),
        ...(unavailable ? { unavailable } : {}),
      };
    };
    const asTarget = (item: SourceItem): ItemTarget =>
      item.workItem
        ? {
            workItem: {
              repo: item.workItem.repo,
              number: item.workItem.number,
              type: item.workItem.type,
            },
          }
        : { key: item.key };
    const checked = pollOf(entry)
      ? (latestResult(this.checks.get(automationKey(entry)), entry.version) ?? [])
      : [];
    const items = checked.map((polled) => {
      const item = polledSourceItem(polled, true);
      return row(asTarget(item), item);
    });
    const { connection } = source;
    const onWorkItems = connection !== undefined && source.itemTypes.length > 0;
    const inbox = !onWorkItems
      ? []
      : (this.deps.inboxSnapshot(workspaceId)?.items ?? [])
          .filter(
            (candidate) =>
              candidate.workItem.provider === connection &&
              source.itemTypes.includes(candidate.workItem.type),
          )
          .map((candidate) => {
            const item = inboxSourceItem(candidate);
            return row(asTarget(item), item);
          });
    return {
      takesItem,
      acceptsUrl: onWorkItems && this.deps.workItems.canParseUrls(connection),
      items,
      inbox,
    };
  }

  /**
   * An agent's destructive call, made a run that waits for a person:
   * previewed now with the agent's own authority, and run — exactly what the
   * preview showed — only when a person approves it. Asking again for the
   * same plan returns the waiting run instead of notifying twice; a plan
   * with nothing to do records nothing.
   */
  public async requestApproval(
    toolName: string,
    raw: unknown,
    sessionId: string,
  ): Promise<{ preview: EngineToolResult; run: RunRecord | null }> {
    const tool = this.deps.registry.get(toolName);
    if (!tool) throw new Error(`No Consola tool named "${toolName}".`);
    const workspaces = this.deps.getWorkspaces();
    const context = agentToolContext(sessionId, workspaces);
    const preview = await this.deps.registry.invoke(tool.name, raw, context, 'preview');
    if (preview.actionable === 0) return { preview, run: null };

    const validated = this.deps.registry.validate(tool, raw);
    const args = preview.approvalArgs ?? (validated.ok ? validated.args : {});
    const ref = `${CONSOLA_NAMESPACE}#${tool.name}`;
    const version = requestVersion(ref, args);
    const waitingFromCaller = this.deps.store
      .runs()
      .filter(
        (run) =>
          isAgentRequest(run) &&
          run.status === 'needs-approval' &&
          run.trigger.actorId === sessionId,
      );
    const same = waitingFromCaller.find(
      (run) => run.actionName === ref && run.actionVersion === version,
    );
    if (same) return { preview, run: same };
    if (waitingFromCaller.length >= MAX_WAITING_PER_SESSION) {
      throw new Error(
        `${waitingFromCaller.length} requests from this session are already waiting for the person; ` +
          'ask them to review those in Consola first.',
      );
    }

    const asker = workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === sessionId);
    const summary = `${preview.summary} Asked by "${asker?.name ?? sessionId}".`;
    const workspaceId = context.caller.workspaceId;
    const now = this.iso();
    const run: RunRecord = {
      id: this.deps.newId(),
      runner: 'local',
      source: 'manual',
      automationId: ref,
      actionName: ref,
      actionVersion: version,
      mode: 'confirm',
      trigger: { kind: 'manual', at: now, by: 'agent', actorId: sessionId },
      status: 'needs-approval',
      summary,
      result: compact(preview.data),
      approval: { args },
      attribution: {
        automationId: ref,
        actionName: ref,
        triggerKind: 'manual',
        workspaceId,
        actorId: sessionId,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.add(run);
    this.broadcast(workspaceId);
    this.deps.notify({
      title: `"${asker?.name ?? 'A session'}" needs your approval`,
      body: `${summary} Review it in Consola.`,
      runId: run.id,
      workspaceId,
      needsApproval: true,
    });
    return { preview, run };
  }

  /**
   * Approve a run waiting for a person. Runs exactly what its preview showed
   * — every safety rule checked again, nothing added — and refuses if the
   * automation changed since. An agent or steps run joins the queue, so
   * approving one never steps past the cap. Approving a new or edited `auto`
   * entry (or a `notify` one whose dry run starts something) also lets it
   * run on its own from now on, unless it is a poll entry: only Allow lets
   * one check, so approving its run starts that run and nothing else.
   */
  public async approve(runId: string): Promise<RunRecord> {
    const run = this.waiting(runId);
    if (isAgentRequest(run)) return this.approveRequest(run);
    const entry = this.entryOf(run);
    const problem = !entry
      ? 'it is no longer in its workspace’s factory'
      : (entry.problem ??
        (entry.version !== run.actionVersion
          ? `${entry.automation.file ?? 'factory.yml'} changed since this preview; run it again`
          : undefined));
    if (!entry || problem) {
      this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
      throw new Error(`Not run: ${problem}.`);
    }
    const key = automationKey(entry);
    const approvedAt = this.iso();
    if (entry.agent || entry.steps) {
      this.deps.store.update(run.id, { status: 'queued', approvedAt, updatedAt: approvedAt });
      this.acceptApproved(key, entry, run);
      this.broadcastRun(run.id);
      // As approved: in line. The queue may start it at once.
      const queued = { ...this.deps.store.get(run.id)! };
      void this.pump();
      return queued;
    }
    this.assertIdle(key, entry.automation.name);
    this.deps.store.update(run.id, {
      status: 'running',
      approvedAt,
      startedAt: this.iso(),
      updatedAt: this.iso(),
    });
    return this.guarded(
      key,
      run.id,
      async () => {
        const args = run.approval?.args ?? entry.args;
        const result = await this.deps.registry.invoke(
          entry.tool!.name,
          args,
          this.contextFor(entry),
          'run',
        );
        this.finish(run.id, 'completed', { result });
        // Checked now, not at approval: a save may have landed while it ran.
        this.acceptApproved(key, entry, run);
      },
      entry.automation.name,
    );
  }

  /**
   * An approved run of an entry that asks until accepted (`asksUntilAccepted`)
   * lets it run on its own from now on — unless `saveEntry` wrote the entry
   * since the run was asked for, or in the same instant: that approval was
   * for the entry before. Only Allow accepts a poll entry: otherwise an
   * agent could save one, ask for a run, and have the person's approval of
   * that run start a check command they never saw. And no run an agent asked
   * for accepts any entry: approving it runs that run only, so trust is given
   * only when a person approves a run that really is unattended.
   */
  private acceptApproved(key: string, entry: Resolved, run: RunRecord): void {
    if (!asksUntilAccepted(entry) || pollOf(entry)) return;
    // An agent asked for it: approving runs that run only (the user's decision of 2026-11-21).
    if (run.trigger.by === 'agent') return;
    const revoked = this.deps.store.revokedAt(key);
    if (revoked !== undefined && !(Date.parse(run.createdAt) > Date.parse(revoked))) return;
    this.deps.store.accept(key, entry.version);
  }

  /** Turn down a run waiting for approval, or take a queued one out of the line. */
  public dismiss(runId: string): RunRecord {
    const run = this.deps.store.get(runId);
    if (run?.status !== 'queued') this.waiting(runId);
    this.finish(runId, 'rejected', {});
    return this.deps.store.get(runId)!;
  }

  /**
   * A person's Allow on a poll entry's page: its check command may run as
   * them, at the version they looked at, in every mode. Refused once the
   * entry is no longer that version, and while it cannot check. The first
   * check runs at once.
   */
  public allow(workspaceId: string, name: string, version: string): void {
    const factory = this.factoryOf(workspaceId);
    const entry = factory.resolved.find((candidate) => candidate.automation.name === name);
    if (!entry) throw new Error(`No automation named "${name}" in ${factory.folder.filePath}.`);
    if (!pollOf(entry)) throw new Error(`${name} has no check command to allow.`);
    if (entry.version !== version) throw new Error('It changed since you looked; review it again.');
    if (entry.problem)
      throw new Error(`${name} can't check while it has a problem: ${entry.problem}.`);
    const key = automationKey(entry);
    this.deps.store.accept(key, version);
    // Settled: should something take it back, that asks again.
    this.allowsAnnounced.delete(`${key} ${version}`);
    // Its first check at this version is due at once, and starts a run of failures of its own.
    this.checks.set(key, { ...dueNow(this.checkStateOf(key)), failures: 0 });
    this.broadcast(workspaceId);
    this.runDueChecks();
  }

  /**
   * A person's Check now on a poll entry: its check runs at once when the
   * lane has room, else as soon as a slot frees. One already running is the
   * check asked for. Refused until the entry is allowed at this version.
   */
  private checkNow(entry: Resolved): void {
    const key = automationKey(entry);
    if (this.deps.store.acceptedVersion(key) !== entry.version) {
      throw new Error(`\`${entry.automation.name}\` is not checking yet: allow it first.`);
    }
    const state = this.checkStateOf(key);
    if (state.running) return;
    this.checks.set(key, dueNow(state));
    this.runDueChecks();
  }

  /** A poll entry's trigger when its check may run: it has no problem, and its version is the one a person allowed, in every mode. */
  private mayCheck(entry: Resolved): PollTrigger | null {
    const trigger = pollOf(entry);
    if (!trigger || entry.problem) return null;
    return this.deps.store.acceptedVersion(automationKey(entry)) === entry.version ? trigger : null;
  }

  /**
   * Whether a run on a chosen item, about to start, still waits for a check:
   * on a poll that may check, it starts only once a check has ended since it
   * first came up to start (its Run on…, or its approval), asking for one if
   * none is running or due. That check's result is absorbed into the waiting
   * run, so the record marks the item at what the run reads. A failed check
   * ends too. A count of ended checks, not a clock: a check ending in the same
   * instant still counts. An entry not allowed yet is never checked for this.
   */
  private awaitsCheck(entry: Resolved, run: RunRecord): boolean {
    if (!this.mayCheck(entry)) return false;
    const ended = this.checksEnded.get(automationKey(entry)) ?? 0;
    const since = this.checkAwaitedFrom.get(run.id);
    if (since === undefined) this.checkAwaitedFrom.set(run.id, ended);
    else if (ended > since) {
      this.checkAwaitedFrom.delete(run.id);
      return false;
    }
    if (!this.checkPending(entry)) this.checkNow(entry);
    return true;
  }

  /** Whether a check of the entry is running or due now: one its result will soon say more than the last. */
  private checkPending(entry: Resolved): boolean {
    if (!this.mayCheck(entry)) return false;
    const state = this.checkStateOf(automationKey(entry));
    return state.running !== undefined || state.lastEndedAt === undefined;
  }

  private checkStateOf(key: string): CheckState {
    return this.checks.get(key) ?? { failures: 0 };
  }

  /**
   * Start every check that is due, in file order, while the lane has room:
   * at most `MAX_CONCURRENT_CHECKS` across every workspace, and one per
   * automation. A check never takes an agent or a command slot. Only an
   * entry that may check is ever started.
   */
  private runDueChecks(): void {
    if (!this.started) return;
    const now = this.deps.now().getTime();
    let running = [...this.checks.values()].filter((state) => state.running).length;
    for (const entry of this.allResolved()) {
      if (running >= MAX_CONCURRENT_CHECKS) return;
      const trigger = this.mayCheck(entry);
      if (!trigger) continue;
      const key = automationKey(entry);
      const state = this.checkStateOf(key);
      if (state.running) continue;
      const due = nextCheckAt(state, trigger.everyMs);
      if (due !== 'now' && due > now) continue;
      const started: CheckRunning = {
        version: entry.version,
        acceptedVersion: this.deps.store.acceptedVersion(key),
        startedAt: this.iso(),
      };
      // Running before anything is awaited, so neither a second pass nor Check now starts it twice.
      this.checks.set(key, { ...state, running: started });
      running++;
      void this.runCheck(entry, trigger, started);
    }
  }

  /**
   * One check, from start to what it came to. Whatever happens on the way,
   * it stops counting as running when it ends, and the lane it frees goes
   * to the next check that is due: no path leaves an automation that never
   * checks again. Nothing awaits this, so nothing may escape it.
   */
  private async runCheck(
    entry: Resolved,
    trigger: PollTrigger,
    running: CheckRunning,
  ): Promise<void> {
    const key = automationKey(entry);
    let ended: CheckEnd;
    try {
      ended = await this.check(entry, trigger, running);
    } catch (error) {
      // What `check` did not foresee fails the check too, rather than nothing at all.
      ended = { ok: false, error: describeReason(error) };
    }
    try {
      if (!('dropped' in ended)) {
        const current = this.entryCheckedBy(entry, running);
        if (current) this.checkEnded(current, ended);
      }
    } catch (error) {
      console.error(`Automation ${entry.automation.name}'s check could not be recorded.`, error);
    } finally {
      const state = this.checks.get(key);
      if (state?.running === running) {
        const { running: _ended, ...rest } = state;
        this.checks.set(key, rest);
      }
      this.checksEnded.set(key, (this.checksEnded.get(key) ?? 0) + 1);
      this.runDueChecks();
      // A run on a chosen item may be waiting for this check, whatever it came to.
      void this.pump();
    }
  }

  /**
   * Run a check's command and read what it printed. It runs as the person:
   * the workspace's command environment, in the workspace's folder, its
   * logs overwritten. Every failure on the way to a result is the check's
   * failure, its reason masked; one whose entry changed, or Consola quit,
   * while its environment was prepared never spawns.
   */
  private async check(
    entry: Resolved,
    trigger: PollTrigger,
    running: CheckRunning,
  ): Promise<CheckEnd> {
    const { workspaceId } = entry;
    const name = entry.automation.name;
    let base: { env: NodeJS.ProcessEnv; secrets: string[] };
    try {
      base = await this.deps.commandEnv(workspaceId);
    } catch (error) {
      return {
        ok: false,
        error: `Its environment could not be prepared (${describeReason(error)}); nothing ran.`,
      };
    }
    if (!this.entryCheckedBy(entry, running)) return { dropped: true };
    const fail = (error: string): CheckEnd => ({
      ok: false,
      error: maskSecrets(error, base.secrets),
    });
    // What the steps below did not foresee (the host's work-item port, say) is a failure too, masked like theirs.
    try {
      let spec: CommandSpec;
      try {
        const logs = this.deps.runFolder.checkFiles(workspaceId, name);
        this.deps.runFolder.ensureEmptyFile(logs.stdout);
        this.deps.runFolder.ensureEmptyFile(logs.stderr);
        spec = checkSpec({
          trigger,
          automation: name,
          cwd: this.deps.runFolder.workspaceDir(workspaceId),
          logs,
          base,
        });
      } catch (error) {
        return fail(`Could not create its logs (${describeReason(error)}); nothing ran.`);
      }

      const key = automationKey(entry);
      let result: CommandResult;
      try {
        const command = this.deps.commands.start(spec);
        this.checkCommands.set(key, command);
        result = await command.result;
      } catch (error) {
        return fail(`The command could not start (${describeReason(error)}); nothing ran.`);
      } finally {
        this.checkCommands.delete(key);
      }
      if (result.exitCode !== 0 || result.timedOut || result.stopped)
        return fail(describeFailure(result, trigger.timeoutMs));

      let stdout: string | null;
      try {
        stdout = this.deps.runFolder.readText(spec.stdoutPath, MAX_CHECK_STDOUT_BYTES + 1);
      } catch (error) {
        return fail(`Could not read its stdout (${describeReason(error)}).`);
      }
      if (stdout === null) return fail('Its stdout log is gone, so it has no output.');
      // Over the limit by what it wrote, not by whether a log was cut: its stderr may be the one that was.
      const truncated =
        result.stdoutBytes > MAX_CHECK_STDOUT_BYTES || utf8Bytes(stdout) > MAX_CHECK_STDOUT_BYTES;
      const read = readCheckResult({ stdout, truncated, trigger, workItems: this.deps.workItems });
      return read.ok ? { ok: true, items: read.items } : fail(read.problem);
    } catch (error) {
      return fail(describeReason(error));
    }
  }

  /**
   * The entry a check's result speaks for, or null when it no longer does
   * (Call 16): Consola quit, the check is not its automation's running one
   * any more, or the entry is gone, has a problem, or is not the version,
   * allowed the same way, that it was when the check started. A result
   * that does not speak for it fires nothing and moves nothing.
   */
  private entryCheckedBy(started: Resolved, running: CheckRunning): Resolved | null {
    if (!this.started) return null;
    const key = automationKey(started);
    if (this.checks.get(key)?.running !== running) return null;
    const entry = this.factories
      .get(started.workspaceId)
      ?.resolved.find((candidate) => candidate.automation.name === started.automation.name);
    if (!entry || !pollOf(entry) || entry.problem) return null;
    if (
      entry.version !== running.version ||
      this.deps.store.acceptedVersion(key) !== running.acceptedVersion
    )
      return null;
    return entry;
  }

  /**
   * A check that counts ended: its items go to its source, or its failure
   * is recorded, with one notice per run of failures, never one per check.
   * A failed check fires nothing and moves nothing else.
   */
  private checkEnded(entry: Resolved, ended: Exclude<CheckEnd, { dropped: true }>): void {
    const key = automationKey(entry);
    const state = this.checkStateOf(key);
    const at = this.iso();
    if (ended.ok) {
      this.checks.set(key, afterSuccess(state, at));
      this.observeSource(entry, ended.items, at);
    } else {
      this.checks.set(key, afterFailure(state, at, ended.error));
      if (state.failures === 0) {
        const name = entry.automation.name;
        this.deps.notify({
          title: `\`${name}\` can't check: ${ended.error}`,
          body: 'Review it in Consola.',
          workspaceId: entry.workspaceId,
          automation: name,
          needsApproval: false,
        });
      }
    }
    this.broadcast(entry.workspaceId);
  }

  /**
   * A poll's check succeeded with `items`. They are kept as its latest
   * result at this version, which a queued run's item is checked against
   * and Run on… lists, before anything fires (a run fired here may be
   * checked at once), then fired as its set (`fireFromSet`), and summed up
   * as its outcome. A work item whose repository the workspace does not
   * hold does not pass: it fires nothing and is not marked fired, so it
   * fires once the repository is cloned, and it counts as skipped. Then the
   * line moves, since a run waiting for a first check may start now.
   */
  private observeSource(entry: Resolved, items: PolledItem[], at: string): void {
    const key = automationKey(entry);
    this.checks.set(key, {
      ...this.checkStateOf(key),
      result: { at, version: entry.version, items },
    });
    let skipped = 0;
    const current = items.map((item) => {
      const passes =
        !item.workItem || this.deps.workItems.inWorkspace(entry.workspaceId, item.workItem);
      if (!passes) skipped++;
      return polledSourceItem(item, passes);
    });
    const { fired, baseline } = this.fireFromSet(entry, current, at);
    this.checks.set(key, {
      ...this.checkStateOf(key),
      outcome: { at, items: items.length, fired, skipped, baseline },
    });
    void this.pump();
  }

  /** A workspace's automations as its panel and `list_automations` show them. */
  public list(workspaceId: string): AutomationView[] {
    const now = this.deps.now();
    return (this.factories.get(workspaceId)?.resolved ?? []).map((entry) => {
      const { automation } = entry;
      const cron = cronOf(entry);
      const next = cron && !entry.problem ? this.nextDue(entry, now) : null;
      const added = this.deps.store.addedBy(automationKey(entry));
      const { trigger } = automation;
      const takesItem = takesItemOf(entry);
      return {
        name: automation.name,
        mode: automation.mode,
        trigger:
          entry.source?.describe ??
          (cron
            ? describeSchedule(cron.cron)
            : trigger.kind === 'manual'
              ? 'On demand'
              : describeTriggerAsWritten(automation)),
        ...(cron ? { schedule: cron.cron } : {}),
        source: trigger.kind,
        onEvent: trigger.kind === 'event' || trigger.kind === 'poll',
        ...(takesItem ? { takesItem } : {}),
        ...(trigger.kind === 'poll' ? { check: this.checkView(entry, trigger, now) } : {}),
        ...(this.needsAllow(entry) ? { needsAllow: true as const, version: entry.version } : {}),
        kind: describeKind(automation),
        runs: describeRun(automation),
        target: automation.run?.ref ?? 'steps',
        ...(isStepsEntry(automation)
          ? { steps: describeSteps(automation.steps, entry.agents) }
          : {}),
        file: automation.file,
        ...(automation.line ? { line: automation.line } : {}),
        // A due-but-unfired occurrence reads as "now", not as a time in the past.
        nextRunAt: next ? new Date(Math.max(next.getTime(), now.getTime())).toISOString() : null,
        // As `effectiveMode` decides: the same entries, until the same version.
        ...(asksUntilAccepted(entry) &&
        this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version
          ? { asksFirst: true }
          : {}),
        ...(entry.problem ? { problem: entry.problem } : {}),
        ...(entry.recheck ? { recheck: true as const } : {}),
        ...(added
          ? {
              addedBy: {
                sessionName: added.sessionName,
                sessionId: added.sessionId,
                isNew: !added.seen,
              },
            }
          : {}),
      };
    });
  }

  /**
   * A poll's check as its page shows it: as written, how the last check
   * that counted went, and, while it checks and none is running, when the
   * next is due (now, for one that is).
   */
  private checkView(entry: Resolved, trigger: PollTrigger, now: Date): CheckView {
    const state = this.checks.get(automationKey(entry));
    const view = checkViewOf(trigger, state?.outcome);
    if (this.mayCheck(entry) && !state?.running) {
      const due = nextCheckAt(state ?? { failures: 0 }, trigger.everyMs);
      view.nextAt = new Date(
        due === 'now' ? now.getTime() : Math.max(due, now.getTime()),
      ).toISOString();
    }
    return view;
  }

  /** A run's definition snapshot, whole; null for a run without one (a legacy run, or one the history dropped). */
  public getRunDefinition(runId: string): RunDefinition | null {
    return this.readSteps(runId)?.definition ?? null;
  }

  /**
   * One step's latest attempt: its record, definition, an agent step's agent,
   * a command's `command.json` and the last 64 KB of each log. Read from the
   * record and the run folder only —
   * nothing starts, and nothing is broadcast. Log text is passed on as stored.
   */
  public getStepDetail(runId: string, stepId: string): StepDetail | null {
    const found = this.stepOf(runId, stepId);
    if (!found) return null;
    const { run, workspaceId, definition, step, record } = found;
    const detail: StepDetail = { runId, step, record };
    // A gate runs nothing: no agent, no command, no logs.
    if (step.kind === 'gate') return detail;
    if (step.kind !== 'run') {
      const agent = definition.agents?.[step.id];
      return agent
        ? { ...detail, agent, ...this.runSkillTexts(workspaceId, run.id, definition, agent.skills) }
        : detail;
    }
    const dir = this.deps.runFolder.attemptDir(workspaceId, run.id, step.id, record.attempt);
    const command = this.readCommandFile(`${dir}/command.json`);
    const stdout = this.readTail(`${dir}/stdout.log`, STEP_TAIL_BYTES);
    const stderr = this.readTail(`${dir}/stderr.log`, STEP_TAIL_BYTES);
    return {
      ...detail,
      ...(command ? { command } : {}),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
    };
  }

  /**
   * Each of `names` by its `SKILL.md` as the run's own copy holds it, when
   * that copy hashes to its definition's (`stepSkillsOf`'s check, without
   * starting anything); else why not. Nothing for no skills.
   */
  private runSkillTexts(
    workspaceId: string,
    runId: string,
    definition: RunDefinition,
    names: readonly string[],
  ): Pick<StepDetail, 'skillTexts' | 'skillsProblem'> {
    if (names.length === 0) return {};
    let held: ReturnType<RunFolderPort['readSkills']>;
    try {
      held = this.deps.runFolder.readSkills(workspaceId, runId, names);
    } catch (error) {
      const reason = describeError(error).trim().replace(/\.$/, '');
      return { skillsProblem: `Its skills could not be read from the run folder (${reason}).` };
    }
    const changed = names.find((name) => {
      const files = held[name];
      return !files || skillHash(files) !== definition.skills?.[name];
    });
    if (changed !== undefined)
      return {
        skillsProblem: `Its skills in the run folder are not the ones its version holds (skills/${changed}).`,
      };
    return { skillTexts: names.map((name) => ({ name, text: skillMarkdown(held[name]!) })) };
  }

  /** "Show all": up to the 1 MB a log holds. Null when the step, the attempt's folder or the log is not there. */
  public readStepLog(runId: string, stepId: string, stream: 'stdout' | 'stderr'): LogTail | null {
    const found = this.stepOf(runId, stepId);
    if (!found || (stream !== 'stdout' && stream !== 'stderr')) return null;
    const dir = this.deps.runFolder.attemptDir(
      found.workspaceId,
      runId,
      stepId,
      found.record.attempt,
    );
    return this.readTail(`${dir}/${stream}.log`, LOG_CAP_BYTES);
  }

  /**
   * An artifact of the step's latest attempt, only one the step declares (or
   * `handover` or `output`), by a name that is a token: so `outputs.env`,
   * which is raw on disk, and anything outside the folder are unreachable.
   */
  public readArtifact(
    runId: string,
    ref: { step: string; name: string },
  ): { content: string; bytes: number } | null {
    const name = ref?.name;
    if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) return null;
    const found = this.stepOf(runId, ref.step);
    if (!found) return null;
    const declared = found.step.kind === 'agent' ? found.step.artifacts : [];
    if (name !== 'handover' && name !== 'output' && !declared.includes(name)) return null;
    const content = this.deps.runFolder.readArtifact(
      found.workspaceId,
      runId,
      found.step.id,
      found.record.attempt,
      name,
    );
    return content === null ? null : { content, bytes: utf8Bytes(content) };
  }

  /**
   * What `readRunConversation` needs to read one step's transcript: the run's
   * own fields, with the step's pointer, session and window in place of the
   * run's. Null for a step that is not there. Reads nothing itself.
   */
  public stepConversationTarget(runId: string, stepId: string): ConversationTarget | null {
    const run = this.deps.store.get(runId);
    const record =
      typeof stepId === 'string'
        ? run?.steps?.find((candidate) => candidate.id === stepId)
        : undefined;
    if (!run || !record) return null;
    return {
      conversation: record.conversation,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      createdAt: run.createdAt,
      attribution: run.attribution,
    };
  }

  /**
   * A steps run's workspace and definition, read from its folder. Null only
   * for genuine absence (no such run, or no definition: a legacy run, or one
   * history dropped); a definition that cannot be read throws, so the caller
   * hears why rather than being told there is nothing.
   */
  private readSteps(
    runId: string,
  ): { run: RunRecord; workspaceId: string; definition: RunDefinition } | null {
    if (typeof runId !== 'string') return null;
    const run = this.deps.store.get(runId);
    const workspaceId = run?.attribution.workspaceId;
    if (!run || !workspaceId) return null;
    const loaded = this.definitionOf(run);
    if ('definition' in loaded) return { run, workspaceId, definition: loaded.definition };
    if (loaded.gone) return null;
    throw loaded.error instanceof Error ? loaded.error : new Error(loaded.problem);
  }

  /** A step of a steps run, by an id that is a step id: its record's latest attempt and its definition. */
  private stepOf(
    runId: string,
    stepId: string,
  ): {
    run: RunRecord;
    workspaceId: string;
    definition: RunDefinition;
    step: Step;
    record: StepRun;
  } | null {
    if (typeof stepId !== 'string' || !STEP_ID_PATTERN.test(stepId)) return null;
    const read = this.readSteps(runId);
    // A leaf: a loop's own row runs nothing and has no step to show.
    const step = read
      ? leafSteps(read.definition.automation.steps).find((candidate) => candidate.id === stepId)
      : undefined;
    const record = read?.run.steps?.find((candidate) => candidate.id === stepId);
    return read && step && record
      ? { run: read.run, workspaceId: read.workspaceId, definition: read.definition, step, record }
      : null;
  }

  /** `command.json`; undefined when there is none, and a throw when it is there but unreadable or not a command file. */
  private readCommandFile(file: string): CommandFile | undefined {
    const text = this.deps.runFolder.readText(file, LOG_CAP_BYTES);
    if (text === null) return undefined;
    const { cwd, command, env } = JSON.parse(text) as Partial<CommandFile>;
    if (typeof cwd !== 'string' || typeof command !== 'string' || !Array.isArray(env)) {
      throw new Error('command.json is not a command file.');
    }
    return {
      cwd,
      command,
      env: env.map((row) => ({
        name: String(row?.name),
        template: String(row?.template),
        value: String(row?.value),
      })),
    };
  }

  private readTail(file: string, bytes: number): LogTail | null {
    return this.deps.runFolder.tail(file, bytes);
  }

  /** One run, whole: its result and approval too, which the activity list leaves out. */
  public getRun(runId: string): RunRecord | null {
    return this.deps.store.get(runId) ?? null;
  }

  /**
   * End a running agent turn, as Ctrl+C would. The turn's own end then
   * fails the run ("It stopped before finishing: you stopped it."); when
   * no turn is running any more, nothing will report, so the run ends here.
   * An agent or steps run that already ended — its turn beat the click — is
   * left as it ended. A steps run is stopped in whatever state it is in
   * (`stopSteps`).
   */
  public stop(runId: string): void {
    const run = this.deps.store.get(runId);
    if (run && isStepsRun(run)) {
      this.stopSteps(run);
      return;
    }
    if (run && isEngineRun(run) && TERMINAL_RUN_STATUSES.includes(run.status)) return;
    if (run?.status !== 'running' || !isAgentRun(run))
      throw new Error(`Run ${runId} is not a running agent run.`);
    if (this.starting.has(runId)) {
      // No turn exists yet: remember, and end it the moment it does.
      this.stopRequested.add(runId);
      return;
    }
    const session = this.sessionOf(run);
    if (session && this.deps.stopAgent(session, 'you stopped it')) return;
    this.finish(runId, 'failed', { error: 'Stopped: its session was no longer running.' });
    void this.pump();
  }

  /**
   * Stop a steps run, as `stopAction` decides. A running turn or command is
   * ended, and its own end fails its step, as for a one-step run; one still
   * starting is stopped once it has (`stopRequested`); a step that has not
   * started fails at once, saying so; a run that has not started is
   * dismissed. Whichever, the steps it had not reached are `not-run`. A
   * failure the click made at once tells no one: the person made it.
   */
  private stopSteps(run: RunRecord): void {
    const action = stopAction(run, { starting: this.starting.has(run.id) });
    switch (action.kind) {
      case 'none':
        return;
      case 'dismiss':
        this.dismiss(run.id);
        return;
      case 'defer':
        this.stopRequested.add(run.id);
        return;
      case 'end-turn': {
        const session = this.sessionNamed(run, action.sessionId);
        if (session && this.deps.stopAgent(session, 'you stopped it')) return; // Its turn's end fails the step.
        this.settleStep(
          run.id,
          action.stepId,
          { status: 'failed', error: NO_TURN_TO_STOP },
          { quiet: true },
        );
        return;
      }
      case 'stop-command':
        // Its result fails the step. A running command always has its handle here until a
        // quit lets go of it, and then nothing is recorded: its step keeps its intent for
        // the next start to fail as interrupted.
        this.runningCommands.get(run.id)?.stop();
        return;
      case 'fail-step':
        this.settleStep(
          run.id,
          action.stepId,
          { status: 'failed', error: action.error },
          { quiet: true },
        );
        return;
      case 'fail-next':
        // The sequencer names the step it would start; `advance` fails it there instead.
        this.stopRequested.add(run.id);
        try {
          this.advance(run.id, { quiet: true });
        } finally {
          this.stopRequested.delete(run.id);
        }
        return;
      case 'end-wait': {
        // Parked with no process: it ends here. A gate fails with the stop; a step waiting out its retry goes back
        // to the failure that made it wait; the entry's own wait leaves its rows as they are.
        const now = this.iso();
        const steps = this.stepsOf(run.id).map((record): StepRun => {
          if (record.id !== action.stepId) return record;
          if (record.gate === undefined) {
            const { retryAt: _retryAt, ...rest } = record;
            return { ...rest, status: 'failed' };
          }
          return { ...record, status: 'failed', error: action.error, finishedAt: now };
        });
        this.finish(run.id, 'failed', { error: action.error }, [], steps);
        void this.pump();
        return;
      }
    }
  }

  /**
   * Retry a failed steps run from its step: the one it failed at, or, when
   * it ended before reaching one, the first it did not run. `stepId` must
   * name that step, so a page out of date cannot retry another. The click is
   * the approval: it runs the run's own snapshot, whatever the file says now.
   * So only a run that started can be retried: one refused at approval (its
   * file changed or lost the entry) or turned away in line never did, and
   * retrying it would step past that refusal.
   *
   * The step gets its next attempt (`retrySteps`): a new folder and, for an
   * agent step, a new session, with what it did before kept in `previous`;
   * later steps run again, earlier ones keep what they recorded. An item
   * run's retry is refused while another run or a session holds its
   * checkout. One whose step is an agent step, or that never prepared its
   * checkout, prepares it again first, claiming it before the fetch; a
   * failed preparation throws and leaves the run as it was. A command runs
   * in the checkout as it is, with the `head` the run recorded.
   */
  public async retry(runId: string, stepId?: string): Promise<RunRecord> {
    const run = this.deps.store.get(runId);
    if (!run || !isStepsRun(run) || run.status !== 'failed')
      throw new Error(`Run ${runId} is not a failed steps run.`);
    // Refused at approval or turned away in line: its approval never covered a start, so the click must not be one.
    if (!run.startedAt) throw new Error(NEVER_STARTED);
    if (this.retrying.has(runId)) throw new Error(`Run ${runId} is already being retried.`);
    const loaded = this.definitionOf(run);
    if ('problem' in loaded) throw new Error(loaded.problem);
    const target = retryTargetOf(run.steps ?? []);
    if (!target) throw new Error(`Run ${runId} has no step to retry.`);
    if (stepId !== undefined && stepId !== target.id)
      throw new Error(`Run ${runId} can be retried only from ${target.id}.`);

    let prepared: PreparedCheckout | undefined;
    const workItem = loaded.definition.automation.scope ? undefined : itemRefOf(run);
    if (workItem) {
      const workspaceId = run.attribution.workspaceId!;
      const itemKey = run.trigger.item?.key;
      const dir = run.checkout?.cwd ?? this.deps.checkout.pathFor(workspaceId, workItem);
      if (this.checkoutHeld(dir, itemKey) || this.deps.checkoutBusy(dir))
        throw new Error(RETRY_HELD);
      if (target.kind === 'agent' || !run.checkout?.head) {
        this.retrying.set(runId, { dir, itemKey });
        try {
          prepared = await this.deps.checkout.prepare({ workspaceId, workItem });
          if (this.deps.store.get(runId)?.status !== 'failed')
            throw new Error(
              `Run ${runId} changed while its checkout was prepared; it was not retried.`,
            );
        } catch (error) {
          this.retrying.delete(runId);
          // A run on the item that waited for the claim may start now.
          void this.pump();
          throw error;
        }
        // Let go of only as the run takes the checkout over, below: nothing runs between the two.
        this.retrying.delete(runId);
      }
    }

    const now = this.iso();
    const current = this.deps.store.get(runId)!;
    this.deps.store.update(runId, {
      status: 'running',
      error: undefined,
      finishedAt: undefined,
      startedAt: current.startedAt ?? now,
      updatedAt: now,
      steps: retrySteps(current.steps ?? [], target.id, now, loaded.definition.automation.steps),
      ...(prepared
        ? { checkout: { cwd: prepared.cwd, scopeId: prepared.scopeId, head: prepared.head } }
        : {}),
    });
    this.broadcastRun(runId);
    this.advance(runId);
    return { ...this.deps.store.get(runId)! };
  }

  /**
   * One page of a workspace's history, newest first, narrowed by the panel's
   * own filter before it is paged, so a search covers every run kept.
   */
  public listRuns(workspaceId: string, query: ListRunsQuery): RunListPage {
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit)));
    const after = this.historyAfter(workspaceId, query.before, {
      query: query.query ?? '',
      kind: query.kind ?? 'all',
      automation: query.automation ?? null,
    });
    return { runs: after.slice(0, limit), hasOlder: after.length > limit };
  }

  /** The runs `listRuns` would list after `before` (all of them without one), newest first; none for a `before` it does not list. */
  private historyAfter(
    workspaceId: string,
    before: string | undefined,
    filter: RunListFilter,
  ): RunListEntry[] {
    const entries = this.deps.store
      .runs()
      .filter((run) => run.attribution.workspaceId === workspaceId)
      .map(toListEntry);
    const ordered = filterRuns(entries, filter, this.deps.now()).sort(newestFirst);
    if (before === undefined) return ordered;
    const at = ordered.findIndex((run) => run.id === before);
    return at < 0 ? [] : ordered.slice(at + 1);
  }

  public snapshot(workspaceId: string): AutomationsSnapshot {
    const factory = this.factoryOf(workspaceId);
    const all = this.deps.store.runs().filter((run) => run.attribution.workspaceId === workspaceId);
    // Every live run, and the newest ended ones; the rest are `listRuns`'s.
    const ended = all.filter((run) => !isLiveRun(run)).sort(newestFirst);
    const left = new Set(ended.slice(SNAPSHOT_ENDED_RUNS));
    const runs = all.filter((run) => !left.has(run)).map(toListEntry);
    // A place in its lane's line, which every workspace shares.
    const queue: Record<string, number> = {};
    const { lines } = this.waitingRuns();
    for (const lane of LANES) {
      lines[lane].forEach(({ run }, index) => {
        if (run.attribution.workspaceId === workspaceId) queue[run.id] = index + 1;
      });
    }
    return {
      filePath: factory.folder.filePath,
      fileExists: factory.read.exists,
      automations: this.list(workspaceId),
      // While the folder does not apply, every reason it does not: a changed entry's harness too.
      issues: factory.standing ? factory.standing.decision.blocking : factory.read.parse.issues,
      notices: [...factory.read.parse.notices, ...factory.warnings],
      runs,
      // True only when `listRuns` would hand over an ended run after the oldest one shown.
      hasOlder:
        left.size > 0 &&
        this.historyAfter(workspaceId, ended[SNAPSHOT_ENDED_RUNS - 1].id, NO_RUN_FILTER).some(
          (run) => !LIVE_RUN_STATUSES.has(run.status),
        ),
      queue,
      suggestAssignedReviews: this.assignedReviewsSuggestion(workspaceId, factory),
      templates: this.templatesOf(workspaceId, factory),
      ...(factory.standing ? { standing: this.standingView(factory.standing) } : {}),
    };
  }

  /** The banner, worded now: a banner left overnight names the day its version applied. */
  private standingView(standing: NonNullable<WorkspaceFactory['standing']>): FactoryStanding {
    const { decision, appliedAt } = standing;
    return {
      message: standingMessage(decision, appliedAt, this.deps.now()),
      appliedAt,
      removed: [...decision.removed],
    };
  }

  /**
   * Start what waits while its lane has room: in each lane's line, runs
   * that started first, then the rest, oldest first, each checked once more
   * right before it starts. A steps run whose every step would skip needs
   * no slot: it settles as soon as it is checked. A started run that
   * nothing is advancing (a restart cut it off between steps) is picked up
   * first, so its next step is in line ahead of runs that have not started.
   * Re-entrant calls fold into one more pass rather than racing the one in
   * progress.
   */
  private async pump(): Promise<void> {
    if (!this.started) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const stalled = this.stalledRuns();
        for (const run of stalled) this.pickUp(run);
        const { lines, settling } = this.waitingRuns();
        for (const run of settling) {
          if (this.deps.store.get(run.id)?.status !== 'queued') continue;
          const verdict = this.checkQueued(run);
          if (verdict.go) this.startStepsRun(run, verdict.item, null);
          else if (!verdict.wait) this.endUnstarted(run, verdict);
        }
        await this.startInLine(lines);
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * One pass down each lane's line. Once a run in it must wait for a slot,
   * only runs that already hold one start behind it, so nothing overtakes
   * it. A start that set something else going (a step queued, a slot
   * freed, a run ended), whether while it was awaited or by itself, leaves
   * the rest of the pass to a line taken afresh: this one is out of date.
   */
  private async startInLine(lines: Record<Lane, Waiting[]>): Promise<void> {
    for (const lane of LANES) {
      let full = false;
      for (const waiting of lines[lane]) {
        // A run dismissed, dropped or started since the line was taken is not in line.
        if (!this.stillWaiting(waiting)) continue;
        // A run started from the line already holds the slot its first step takes.
        if (this.admitted.get(waiting.run.id) !== lane) {
          full ||= this.slotsInUse(lane) >= this.capacityOf(lane);
          if (full) continue;
        }
        await this.startWaiting(waiting);
        if (this.pumpAgain) return;
      }
    }
  }

  /** Start one run at its turn in line: a queued step of a started run, or a run, checked first. */
  private async startWaiting(waiting: Waiting): Promise<void> {
    const { run, lane, stepId } = waiting;
    if (stepId) {
      // Only a restart leaves a queued step naming a session: it is picked up there, or runs again.
      if (this.stepsOf(run.id).find((step) => step.id === stepId)?.sessionId)
        await this.resumeStep(run.id, stepId);
      else if (lane === 'agent') await this.startAgentStep(run.id, stepId);
      else await this.startCommandStep(run.id, stepId);
      return;
    }
    const verdict = this.checkQueued(run);
    if (!verdict.go) {
      if (!verdict.wait) this.endUnstarted(run, verdict);
      return;
    }
    if (isStepsRun(run)) this.startStepsRun(run, verdict.item, lane);
    else await this.startAgentRun(run, verdict.item);
  }

  /**
   * A queued run the check turned away: it ends without starting. When
   * Consola itself turned it away because its automation changed, the item
   * it fired for is given back: nothing had started, so it fires again under
   * the new version once that is allowed (Call 12). Given back only to the
   * record it fired under: an edit to what the entry watches re-baselines,
   * and the record a check or a fetch wrote since then (its own checks may
   * land while this run waits for a slot) counts the item as handled. A run
   * that does not say which record it fired under gets nothing back.
   */
  private endUnstarted(run: RunRecord, verdict: Extract<QueueVerdict, { status: string }>): void {
    this.finish(
      run.id,
      verdict.status,
      verdict.status === 'failed' ? { error: verdict.message } : { summary: verdict.message },
    );
    const itemKey = run.trigger.item?.key;
    const key = automationKeyOf(run);
    if (!verdict.giveBack || itemKey === undefined || key === undefined || !firedBySource(run))
      return;
    const record = this.deps.store.seen(key);
    const { firedUnder } = (run.result ?? {}) as { firedUnder?: unknown };
    if (record && firedUnder !== undefined && record.definition === firedUnder)
      this.deps.store.setSeen(key, forgetFired(record, itemKey));
  }

  /** Whether a run is still where the line saw it: queued, or, for a started run, with the same step queued. */
  private stillWaiting(waiting: Waiting): boolean {
    const run = this.deps.store.get(waiting.run.id);
    if (!waiting.stepId) return run?.status === 'queued';
    return (
      run?.status === 'running' &&
      run.steps?.find((step) => step.id === waiting.stepId)?.status === 'queued'
    );
  }

  /**
   * Every run waiting for a slot, each in its lane's line, in order; and the
   * steps runs that need none, because every step they would run skips (or
   * the first fails at once).
   */
  private waitingRuns(): { lines: Record<Lane, Waiting[]>; settling: RunRecord[] } {
    const waiting: Waiting[] = [];
    const settling: RunRecord[] = [];
    // Oldest first, so runs joining at the same instant keep the order they joined in.
    for (const run of [...this.deps.store.runs()].reverse()) {
      if (run.status === 'queued' && isAgentRun(run)) {
        waiting.push({ run, lane: 'agent', started: !!run.sessionId });
      } else if (run.status === 'running' && isStepsRun(run)) {
        const step = run.steps?.find((candidate) => candidate.status === 'queued');
        if (step) waiting.push({ run, lane: laneOfRecord(step), started: true, stepId: step.id });
      } else if (run.status === 'queued' && isStepsRun(run)) {
        const lane = this.firstLaneOf(run);
        if (lane) waiting.push({ run, lane, started: false });
        else settling.push(run);
      }
    }
    waiting.sort(byPlaceInLine);
    const lines: Record<Lane, Waiting[]> = { agent: [], command: [] };
    for (const entry of waiting) lines[entry.lane].push(entry);
    return { lines, settling };
  }

  /**
   * Started steps runs with no step queued or running and nothing starting:
   * nothing will advance them. Every transition queues the next step in the
   * same breath, so only a restart leaves one: cut off between two lines, or
   * while it prepared its checkout.
   */
  private stalledRuns(): RunRecord[] {
    return this.deps.store
      .runs()
      .filter(
        (run) =>
          run.status === 'running' &&
          isStepsRun(run) &&
          !this.starting.has(run.id) &&
          !(run.steps ?? []).some((step) => step.status === 'queued' || step.status === 'running'),
      );
  }

  /**
   * A stalled run goes on: an item run with no `head` prepares its checkout
   * first, as its start would have, which it still holds; any other
   * advances from its record.
   */
  private pickUp(run: RunRecord): void {
    const loaded = this.definitionOf(run);
    const definition = 'definition' in loaded ? loaded.definition : undefined;
    const workItem = definition && !definition.automation.scope ? itemRefOf(run) : undefined;
    if (!definition || !workItem || run.checkout?.head) {
      // A definition that cannot be read fails it there: nothing else would.
      this.advance(run.id);
      return;
    }
    // As at its start: a source fired it and its first agent step is an action, so a review the person started by hand wins.
    const first = leafSteps(definition.automation.steps).find((step) => step.kind === 'agent');
    const label = first ? definition.actions[first.id]?.name : undefined;
    const byHand =
      firedBySource(run) && label ? { startedByHand: { label, since: run.createdAt } } : {};
    void this.prepareCheckout(run.id, {
      workspaceId: run.attribution.workspaceId!,
      workItem,
      ...byHand,
    });
  }

  /**
   * The lane of the first step a steps run that has not started would run,
   * asked of the sequencer over its pending record; null when it would run
   * none. A gate as its first move takes the command lane (Call 9, review
   * B2): the run waits in line, claims and prepares its checkout (or records
   * its scope's folder) as for a first command, then parks holding it,
   * giving the slot back. One whose automation changed waits where its first
   * step would: its check rejects it when its turn comes, as for any other
   * run.
   */
  private firstLaneOf(run: RunRecord): Lane | null {
    const records = run.steps ?? [];
    const entry = this.entryOf(run);
    if (!entry?.steps || entry.version !== run.actionVersion)
      return records[0] ? laneOfRecord(records[0]) : null;
    // At this version the entry's definition is the run's snapshot, and its source the one the run builds. A
    // guess at its lane: an `item.json` that cannot be read reads as none here, and fails the run when it starts.
    const itemOf = this.itemOfSource(run, entry.source);
    const next = advanceSteps({
      steps: entry.steps.definition.automation.steps,
      records,
      dryRun: run.dryRun === true,
      ...stepItemOf(run, itemOf),
    });
    if (next.kind === 'start') return next.lane;
    return next.kind === 'ask' ? 'command' : null;
  }

  /**
   * Whether a queued run may start now, and its item as its source has it
   * now. Its automation must still say the same thing. An event run's item
   * must still be in the Inbox's set, and a run on a poll entry's item is
   * refreshed from its latest result (Call 13); a fired run whose item is
   * no longer there is turned away, and one that fired before a review the
   * person did by hand is not done twice. An item the runner cannot check
   * yet (no Inbox, or no check, since launch) waits. A run a person or an
   * agent started on an item (`manual`) is never turned away for its item
   * nor for a review by hand: it takes the item as its source has it now
   * when the source has it (the last check's object, or the Inbox's item),
   * and otherwise goes on with what it recorded.
   */
  private checkQueued(run: RunRecord): QueueVerdict {
    // A turn cut off by a quit resumes in its session, whatever the file
    // says now: it was approved, and it belongs to that conversation.
    if (run.sessionId) {
      const session = this.sessionOf(run);
      if (!session) return { go: false, status: 'rejected', message: 'Its session was closed.' };
      if (this.deps.hasLiveTerminal(session)) {
        return { go: false, status: 'rejected', message: SESSION_OPENED_MESSAGE };
      }
      return { go: true };
    }
    const entry = this.entryOf(run);
    if (!entry)
      return {
        go: false,
        status: 'rejected',
        message: 'It is no longer in its workspace’s factory.',
      };
    if (entry.problem)
      return { go: false, status: 'failed', message: `Not run: ${entry.problem}.` };
    if (entry.version !== run.actionVersion) {
      return {
        go: false,
        status: 'rejected',
        message: 'Its automation changed since it was queued.',
        giveBack: true,
      };
    }
    const wanted = run.trigger.item;
    const { source, event } = entry;
    if (!wanted || !source) return { go: true };
    const fired = firedBySource(run);
    let item: SourceItem;
    if (pollOf(entry)) {
      // A run on a chosen item reads the item as a check finds it once the run is about to start.
      if (!fired && this.awaitsCheck(entry, run)) return { go: false, wait: true };
      // Its latest result at this version: one taken at another may have come from another command.
      const items = latestResult(this.checks.get(automationKey(entry)), entry.version);
      const polled = items?.find((candidate) => candidate.key === wanted.key);
      if (polled) item = polledSourceItem(polled, true);
      else if (!fired) return { go: true, item: recordedItem(run, wanted) };
      else if (!items) return { go: false, wait: true };
      else return { go: false, status: 'rejected', message: source.goneReason };
    } else if (event && fired) {
      const snapshot = this.deps.inboxSnapshot(entry.workspaceId);
      if (!snapshot || snapshot.fetchedAt === 0) return { go: false, wait: true };
      const inbox = snapshot.items.find((candidate) => event.keyOf(candidate) === wanted.key);
      // The set, not the filter: a queued review is not dropped for going back to draft.
      if (!inbox || !event.inSet(inbox))
        return { go: false, status: 'rejected', message: source.goneReason };
      item = event.toSourceItem(inbox, event.passesFilter(inbox));
    } else {
      // A run on a chosen item has no set to leave: the Inbox's item when it holds it, else what it recorded.
      const inbox = this.deps
        .inboxSnapshot(entry.workspaceId)
        ?.items.find((candidate) => candidate.key === wanted.key);
      return { go: true, item: inbox ? inboxSourceItem(inbox) : recordedItem(run, wanted) };
    }
    const byHand = fired ? this.startedByHand(entry, wanted.key, run.createdAt) : undefined;
    if (byHand)
      return {
        go: false,
        status: 'rejected',
        message: `Already started by hand: “${byHand.name}”.`,
      };
    return { go: true, item };
  }

  /**
   * Start a queued agent run. Its status is `running` from here until its
   * turn ends (`turnEnded`): the run is the turn, and what holds a slot. A
   * run on a poll's item takes its title as last checked, in the same
   * update; its prompt stays the one its preview showed.
   */
  private async startAgentRun(run: RunRecord, item: SourceItem | undefined): Promise<void> {
    // An interrupted run picked up again keeps the time it first started.
    this.deps.store.update(run.id, {
      status: 'running',
      startedAt: run.startedAt ?? this.iso(),
      updatedAt: this.iso(),
      ...(item?.object !== undefined ? refreshedTrigger(run, item) : {}),
    });
    this.broadcastRun(run.id);
    this.starting.add(run.id);
    try {
      if (run.sessionId) return await this.resumeAgentRun(run);
      await this.launchAgentRun(run, item);
    } finally {
      this.starting.delete(run.id);
      this.stopRequested.delete(run.id);
    }
  }

  /** Whether the run is still the one running: it may have ended, or its workspace been forgotten, while a launch was awaited. */
  private stillRunning(runId: string): boolean {
    return this.deps.store.get(runId)?.status === 'running';
  }

  /**
   * A stop asked for while the turn was starting: end it now that there is
   * one to end. By now the run names its session, which is looked up as
   * `stop` looks it up.
   */
  private honourStop(runId: string): void {
    if (!this.stopRequested.delete(runId)) return;
    const session = this.sessionOf(this.deps.store.get(runId)!);
    if (session && this.deps.stopAgent(session, 'you stopped it')) return; // Its exit records the stop.
    this.finish(runId, 'failed', { error: 'Stopped: its session was no longer running.' });
    void this.pump();
  }

  private async launchAgentRun(run: RunRecord, item: SourceItem | undefined): Promise<void> {
    const entry = this.entryOf(run)!;
    const agent = entry.agent!;
    const name = entry.automation.name;
    try {
      const session = await this.deps.launchAgent({
        workspaceId: entry.workspaceId,
        run: { id: run.id, automation: name },
        prompt: String(run.approval?.args.prompt ?? ''),
        // A work item runs in a worktree of its own; anything else, a poll's keyed item included, in its scope.
        ...(item?.workItem
          ? {
              item: {
                workItem: item.workItem,
                title: item.title,
                label: agent.label ?? name,
                ...(agent.groupId ? { groupId: agent.groupId } : {}),
                // A run a person or an agent asked for on the item is theirs to have: the host asks after a review by hand only for a fired one.
                ...(firedBySource(run) ? { startedByHandSince: run.createdAt } : {}),
              },
            }
          : { scopeId: agent.scope?.id }),
      });
      if (!this.stillRunning(run.id)) return;
      const scopePath = this.deps
        .getWorkspaces()
        .find((workspace) => workspace.id === entry.workspaceId)
        ?.scopes.find((scope) => scope.id === session.scopeId)?.path;
      this.deps.store.update(run.id, {
        sessionId: session.id,
        conversation: {
          harnessId: session.harnessId,
          id: session.claudeSessionId,
          cwd: session.cwd ?? scopePath ?? agent.scope?.path,
        },
        summary: runningIn(session.name),
        updatedAt: this.iso(),
      });
      this.broadcastRun(run.id);
      this.honourStop(run.id);
    } catch (error) {
      // The person got there first: nothing failed, the review exists.
      if (error instanceof StartedByHandError) {
        this.finish(run.id, 'rejected', { summary: error.message });
        return;
      }
      this.finish(run.id, 'failed', { error: describeError(error) });
      this.notify(`${name} could not start`, describeError(error), run.id);
    }
  }

  /** Pick an interrupted turn up where it stopped. Needs its session, never its entry, which may be gone. */
  private async resumeAgentRun(run: RunRecord): Promise<void> {
    const session = this.sessionOf(run);
    try {
      if (!session) throw new Error('Its session was closed.');
      await this.deps.resumeAgent(session, INTERRUPTED_PROMPT);
      if (!this.stillRunning(run.id)) return;
      this.deps.store.update(run.id, { summary: runningIn(session.name), updatedAt: this.iso() });
      this.broadcastRun(run.id);
      this.honourStop(run.id);
    } catch (error) {
      this.finish(run.id, 'failed', { error: describeError(error) });
      this.notify(`${run.automationId} could not continue`, describeError(error), run.id);
    }
  }

  /** The session an agent run started, while its workspace still has it. */
  private sessionOf(run: RunRecord): SessionView | undefined {
    return run.sessionId ? this.sessionNamed(run, run.sessionId) : undefined;
  }

  /**
   * A lane's slots in use. The agent lane's: legacy agent runs whose turn
   * is running or being launched, and running agent steps, each one
   * process. The command lane's: running commands. A steps run started
   * from the line holds a slot in its first step's lane until that step
   * runs (`admitted`).
   */
  private slotsInUse(lane: Lane): number {
    let used = 0;
    for (const [runId, reserved] of this.admitted) {
      // One that ended, or went with its workspace, holds nothing.
      if (reserved === lane && this.stillRunning(runId)) used++;
    }
    for (const run of this.deps.store.runs()) {
      if (run.status !== 'running') continue;
      if (isAgentRun(run)) used += lane === 'agent' ? 1 : 0;
      else if (run.steps)
        used += run.steps.filter(
          (step) => step.status === 'running' && laneOfRecord(step) === lane,
        ).length;
    }
    return used;
  }

  private capacityOf(lane: Lane): number {
    return lane === 'agent'
      ? (this.deps.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS)
      : (this.deps.maxConcurrentCommands ?? DEFAULT_MAX_CONCURRENT_COMMANDS);
  }

  /**
   * Whether a started, unfinished steps run holds `dir`: its checkout is
   * there, or it is on the item `itemKey`. Every workspace's runs count:
   * one service serves them all, and the folder is one per item. A run
   * parked at a gate or a declared retry holds it as a running one does,
   * with no process (`holdsWhileWaiting`), and a retry preparing a failed
   * run's checkout holds it too.
   */
  public checkoutHeld(dir: string, itemKey?: string): boolean {
    for (const claim of this.retrying.values()) {
      if (claim.dir === dir || (itemKey !== undefined && claim.itemKey === itemKey)) return true;
    }
    return this.checkoutHolder(dir, itemKey) !== undefined;
  }

  /** The steps run that holds `dir` (or the item `itemKey`): running, or parked holding it. */
  private checkoutHolder(dir: string, itemKey?: string): RunRecord | undefined {
    return this.deps.store
      .runs()
      .find(
        (run) =>
          (run.status === 'running' || holdsWhileWaiting(run)) &&
          isStepsRun(run) &&
          (run.checkout?.cwd === dir ||
            (itemKey !== undefined && run.trigger.item?.key === itemKey)),
      );
  }

  /**
   * Start a queued steps run, checked (`checkQueued`) and at the head of
   * its first step's lane (`lane`; null for one whose every step skips).
   *
   * An item run's checkout must be free: one another run works in, or a
   * session runs in, makes it wait, saying so. Then one update marks it
   * running, refreshes its item from its source (the Inbox, or a poll's
   * latest result, whose object it also writes over `item.json`: a run that
   * absorbed a change reads the item as it is now), and claims its
   * checkout, before anything is awaited, so no second run on the item
   * slips in while this one is still fetching. From here it holds a slot in
   * its first step's lane until that step runs (`admitted`), so no run
   * behind it in line starts in the same pass. An item run then prepares
   * its checkout, for the work item it recorded; a schedule's is its
   * scope's folder. Then it advances.
   */
  private startStepsRun(run: RunRecord, item: SourceItem | undefined, lane: Lane | null): void {
    const entry = this.entryOf(run)!;
    const { scope, byHandLabel, definition } = entry.steps!;
    const workItem = lane && !scope ? itemRefOf(run) : undefined;
    const dir = workItem ? this.deps.checkout.pathFor(entry.workspaceId, workItem) : undefined;
    if (dir && (this.checkoutHeld(dir, run.trigger.item?.key) || this.deps.checkoutBusy(dir))) {
      this.waitForCheckout(run, dir);
      return;
    }
    if (item?.object !== undefined) {
      try {
        this.deps.runFolder.writeItem(entry.workspaceId, run.id, item.object);
      } catch (error) {
        // It would read the item as it fired, not as it is: it does not start.
        const reason = describeReason(error);
        this.finish(run.id, 'failed', { error: `Could not write its item: ${reason}.` });
        this.notify(
          `${run.automationId} could not start`,
          `Could not write its item: ${reason}.`,
          run.id,
        );
        return;
      }
    }
    const now = this.iso();
    const preview = run.result as StepsRunPreview;
    // Resolved once, as this run starts its first step; a retry never comes back here, so it keeps the run it read.
    const earlier = resolvePrevious(this.deps.store.runs(), run);
    const previous = earlier ? { runId: earlier.id } : undefined;
    this.deps.store.update(run.id, {
      status: 'running',
      ...(previous ? { previous } : {}),
      startedAt: now,
      updatedAt: now,
      ...(run.summary === WAITING_FOR_CHECKOUT
        ? {
            summary: stepsRunLine(
              definition.automation,
              preview.item ? { item: preview.item.label } : { scope: preview.scope },
            ),
          }
        : {}),
      ...(item ? refreshedTrigger(run, item) : {}),
      // What it waited for is over: it starts.
      ...(run.waitingFor ? { waitingFor: undefined } : {}),
      ...(lane && scope ? { checkout: { cwd: scope.path, scopeId: scope.id } } : {}),
      ...(dir ? { checkout: { cwd: dir } } : {}),
    });
    this.broadcastRun(run.id);
    if (lane) this.admitted.set(run.id, lane);
    if (!lane || !workItem) {
      this.advance(run.id);
      return;
    }
    // A source fired it and its first agent step is an action: a review the person started by hand meanwhile wins.
    const byHand =
      firedBySource(run) && byHandLabel
        ? { startedByHand: { label: byHandLabel, since: run.createdAt } }
        : {};
    void this.prepareCheckout(run.id, { workspaceId: entry.workspaceId, workItem, ...byHand });
  }

  /**
   * A run whose item's checkout is held waits, saying so, and, while the
   * run that holds it is parked at a gate, naming that gate (`waitingFor`,
   * review S3). Both are worked out on every look and written only when
   * either changed, so it follows the holder as it parks and as it is
   * answered, one line per change and none per look.
   */
  private waitForCheckout(run: RunRecord, dir: string): void {
    const current = this.deps.store.get(run.id) ?? run;
    const holder = this.checkoutHolder(dir, current.trigger.item?.key);
    const gate = holder ? waitingGateOf(holder) : undefined;
    const waitingFor =
      holder && gate
        ? { gate: { automation: holder.automationId, run: holder.id, step: gate.id } }
        : undefined;
    const same = JSON.stringify(current.waitingFor) === JSON.stringify(waitingFor);
    if (current.summary === WAITING_FOR_CHECKOUT && same) return;
    // Not `updatedAt`: that is its place in line.
    this.deps.store.update(run.id, { summary: WAITING_FOR_CHECKOUT, waitingFor });
    this.broadcastRun(run.id);
  }

  /**
   * Bring an item run's checkout to its head and record what it got, then
   * advance. A failure fails the run before its first step, saying why; a
   * review the person started by hand rejects it, as at the launch. A stop
   * asked for meanwhile waits for the fetch to end, since it is moving the
   * checkout, then fails the run before its first step (`advance`),
   * however the fetch ended.
   *
   * Nothing awaits this, so nothing may escape it: whatever goes wrong
   * after the preparation is logged and fails the run, and the pump runs
   * again either way.
   */
  private async prepareCheckout(runId: string, request: CheckoutRequest): Promise<void> {
    this.starting.add(runId);
    try {
      let prepared: PreparedCheckout;
      try {
        prepared = await this.deps.checkout.prepare(request);
      } catch (error) {
        if (!this.stillRunning(runId)) return;
        if (this.stopRequested.has(runId)) this.advance(runId);
        else this.checkoutRefused(runId, error);
        return;
      }
      if (!this.stillRunning(runId)) return;
      const { cwd, scopeId, head } = prepared;
      this.deps.store.update(runId, { checkout: { cwd, scopeId, head }, updatedAt: this.iso() });
      this.broadcastRun(runId);
      this.advance(runId);
    } catch (error) {
      console.error(`Run ${runId} could not go on after preparing its checkout.`, error);
      try {
        if (this.stillRunning(runId)) this.failRun(runId, describeError(error));
      } catch (failing) {
        console.error(`Run ${runId} could not be recorded as failed.`, failing);
      }
    } finally {
      this.doneStarting(runId);
      // An ended run, or one that went with its workspace, holds no slot.
      if (!this.stillRunning(runId)) this.admitted.delete(runId);
      void this.pump();
    }
  }

  /** The checkout could not be prepared: the run ends before its first step. */
  private checkoutRefused(runId: string, error: unknown): void {
    // The person got there first: nothing failed, their review exists.
    if (error instanceof StartedByHandError) {
      this.finish(runId, 'rejected', { summary: error.message });
      return;
    }
    this.finish(runId, 'failed', { error: describeError(error) });
    this.notify(
      `${this.deps.store.get(runId)!.automationId} could not start`,
      describeError(error),
      runId,
    );
  }

  /**
   * After a run starts, or a step settles: apply what the sequencer says
   * from the record and the run's own definition, each change its own line,
   * then queue the next step for the pump to start, or end the run. A
   * completed run tells the person; the notice opens the run page, since a
   * steps run has no session of its own. `quiet` keeps a failure to the
   * record. A stop asked for before the next step could start fails it
   * there, never started.
   */
  private advance(runId: string, options: { quiet?: boolean } = {}): void {
    const run = this.deps.store.get(runId);
    if (run?.status !== 'running' || !run.steps) return;
    const loaded = this.definitionOf(run);
    if ('problem' in loaded) {
      this.failRun(runId, loaded.problem, options);
      return;
    }
    const itemOf = this.runItemOf(run, loaded.definition);
    if ('error' in itemOf) {
      this.failRun(runId, `${itemOf.error}; it cannot continue.`, options);
      return;
    }
    const next = advanceSteps({
      steps: loaded.definition.automation.steps,
      records: run.steps,
      dryRun: run.dryRun === true,
      ...stepItemOf(run, itemOf),
    });
    if (next.kind === 'wait') return;
    // `flowNotYet` keeps every entry with a loop from running until loops run (slice 3, Call 2): never silently.
    if (next.kind === 'round') throw new Error('a loop is not run yet');
    const stopping = this.stopRequested.delete(runId);
    // A stopped run never completes by skips: when every step left would skip, the one it would look at next fails,
    // never started. With none left, its steps all ended on their own before the stop could reach them: it
    // completes as it would have.
    const pending =
      stopping && next.kind === 'complete'
        ? run.steps.find((step) => step.status === 'pending')
        : undefined;
    if (pending) {
      this.settleStep(
        runId,
        pending.id,
        { status: 'failed', error: stoppedBefore(pending.id) },
        { quiet: true },
      );
      return;
    }
    for (const update of next.updates)
      this.writeSteps(runId, withUpdate(this.stepsOf(runId), update, this.iso()));
    // A stop that landed between steps fails the step it would start, or the gate it would park at (review S8).
    if ((next.kind === 'start' || next.kind === 'ask') && stopping) {
      this.settleStep(
        runId,
        next.stepId,
        { status: 'failed', error: stoppedBefore(next.stepId) },
        { quiet: true },
      );
      return;
    }
    if (next.kind === 'ask') {
      this.park(runId, next.stepId);
      return;
    }
    if (next.kind === 'start') {
      // Its item refreshed at start, a run's first step may be another than the one it was let in for: its slot follows it.
      if (this.admitted.has(runId)) this.admitted.set(runId, next.lane);
      this.writeSteps(
        runId,
        withStep(this.stepsOf(runId), next.stepId, { status: 'queued', queuedAt: this.iso() }),
      );
      this.broadcastRun(runId);
    } else if (next.kind === 'complete') {
      this.finish(runId, 'completed', { summary: next.summary });
      this.notify(`${run.automationId}: done`, next.summary, runId);
    } else {
      this.finish(runId, 'failed', { error: next.error });
      if (!options.quiet) this.notify(`${run.automationId} did not finish`, next.error, runId);
    }
    void this.pump();
  }

  /**
   * The run parks at `stepId`'s gate (a gate's row, or a loop's row at its
   * exhaustion gate): one line writes the row `waiting`, asked now, and the
   * run `waiting`, before anything else. Nothing is ended and nothing starts:
   * it holds no process, and gives back the slot it was let in on, so what
   * runs after the answer waits in line as any step does (Call 11). Then the
   * person is told.
   */
  private park(runId: string, stepId: string): void {
    const now = this.iso();
    this.deps.store.update(runId, {
      status: 'waiting',
      steps: withGateAsked(this.stepsOf(runId), stepId, now),
      updatedAt: now,
    });
    this.admitted.delete(runId);
    this.broadcastRun(runId);
    this.noticeGate(this.deps.store.get(runId)!);
    void this.pump();
  }

  /** A run waiting at a gate tells the person: `<automation> is waiting for you`, and the question, filled in. */
  private noticeGate(run: RunRecord): void {
    const at = waitingGateOf(run);
    if (!at) return;
    const loaded = this.definitionOf(run);
    const offer =
      'definition' in loaded ? gateOffer(loaded.definition.automation.steps, at.id) : null;
    if (!offer) return;
    this.notify(`${run.automationId} is waiting for you`, renderGateAsk(offer.ask, run), run.id);
  }

  /**
   * A person's answer to the gate `stepId` waits at: one of the choices the
   * run's own definition offers (or approve), or `reject`. Anything else, or
   * a row that is not waiting for one (answered already, from another
   * window), is refused and changes nothing. A choice completes the row, its
   * decision its output, and puts the run back to `running` on the same
   * line; then the run goes on from its record (`pickUp`), in the checkout
   * it recorded before it parked (Call 9). A reject ends the run `rejected`
   * at that row, on one line. Answering approves nothing and accepts
   * nothing: `approvedAt` and the accepted versions stay as they are
   * (contract 10). The desktop's renderer is its only caller.
   */
  public answerGate(runId: string, stepId: string, decision: string): RunRecord {
    const run = this.deps.store.get(runId);
    if (!run || !isStepsRun(run)) throw new Error(notWaitingForYou(String(stepId)));
    const loaded = this.definitionOf(run);
    if ('problem' in loaded) throw new Error(loaded.problem);
    const refusal = gateRefusal(run, loaded.definition.automation.steps, stepId, decision);
    if (refusal) throw new Error(refusal);
    const now = this.iso();
    const steps = withGateAnswered(run.steps ?? [], stepId, { decision, nowIso: now });
    if (decision === 'reject') {
      this.finish(runId, 'rejected', { summary: `rejected at ${stepId}` }, [], steps);
      void this.pump();
      return { ...this.deps.store.get(runId)! };
    }
    this.deps.store.update(runId, { status: 'running', steps, updatedAt: now });
    this.broadcastRun(runId);
    this.pickUp(this.deps.store.get(runId)!);
    return { ...this.deps.store.get(runId)! };
  }

  /**
   * A gate a run asked, as its card shows it: from the run's record and its
   * own definition, whatever the file says now; null for a step that is no
   * gate, or one never asked. Reads the run folder only: nothing starts.
   */
  public gateOf(runId: string, stepId: string): GateView | null {
    if (typeof stepId !== 'string') return null;
    const read = this.readSteps(runId);
    if (!read) return null;
    const { run, workspaceId, definition } = read;
    const entries = definition.automation.steps;
    const offer = gateOffer(entries, stepId);
    const records = run.steps ?? [];
    const record = records.find((candidate) => candidate.id === stepId);
    if (!offer || !record?.gate) return null;
    const material = gateMaterialRefs(entries, records, stepId).flatMap((ref) => {
      const attempt = records.find((candidate) => candidate.id === ref.step)?.attempt;
      const read = attempt === undefined ? null : this.materialOf(workspaceId, runId, ref, attempt);
      return read ? [{ ...ref, label: `${ref.step}.${ref.name}`, ...read }] : [];
    });
    const { decision, at } = record.gate;
    return {
      runId,
      stepId,
      ask: renderGateAsk(offer.ask, run),
      material,
      choices: offer.choices,
      ...(offer.loop ? { loop: { id: offer.loop.id, rounds: record.round ?? 0 } } : {}),
      ...this.newerRevisionOf(run),
      ...(decision !== undefined && at !== undefined
        ? { answered: { decision, by: 'person' as const, at } }
        : {}),
    };
  }

  /**
   * Whether a newer revision of the run's item is held until the run ends
   * (Call 12): its item, as its poll's last check has it now, carries a
   * revision the entry's seen record has not marked fired. Only a poll's
   * items carry one (an Inbox item has none, Call 12).
   */
  private newerRevisionOf(run: RunRecord): Pick<GateView, 'newerRevision'> {
    const entry = this.entryOf(run);
    const wanted = run.trigger.item;
    const key = automationKeyOf(run);
    if (!entry || !wanted || key === undefined) return {};
    // Only a poll has a last check: any other entry's item has no revision here.
    const polled = latestResult(this.checks.get(automationKey(entry)), entry.version)?.find(
      (candidate) => candidate.key === wanted.key,
    );
    if (!polled || !heldRevision(this.deps.store.seen(key), polledSourceItem(polled, true)))
      return {};
    return { newerRevision: wanted.type === 'pr' ? 'pull-request' : 'item' };
  }

  /**
   * One document a gate shows, from its step's attempt: whole, as a step
   * writes at most `MAX_ARTIFACT_BYTES`; one larger (put there by hand)
   * shows its last `MAX_ARTIFACT_BYTES`, marked `truncated`. Null when it
   * is not there.
   */
  private materialOf(
    workspaceId: string,
    runId: string,
    ref: { step: string; name: string },
    attempt: number,
  ): { text: string; truncated: boolean } | null {
    const formats = ref.name === 'output' ? (['json', 'text'] as const) : [undefined];
    for (const format of formats) {
      const file = this.deps.runFolder.artifactPath(
        workspaceId,
        runId,
        ref.step,
        attempt,
        ref.name,
        format,
      );
      const read = this.deps.runFolder.tail(file, MAX_ARTIFACT_BYTES);
      if (read) return { text: read.text, truncated: read.truncated };
    }
    return null;
  }

  /**
   * Start an agent step's attempt in its run's checkout. The step is
   * `running` before the launch, as its session's CLI asks for its step
   * tools while it starts and they answer only a running attempt; that is
   * also what holds its slot. A folder that is gone fails the step.
   */
  private async startAgentStep(runId: string, stepId: string): Promise<void> {
    const run = this.deps.store.get(runId)!;
    const loaded = this.definitionOf(run);
    if ('problem' in loaded) {
      this.failRun(runId, loaded.problem);
      return;
    }
    const { cwd, scopeId } = run.checkout ?? {};
    if (!cwd || !scopeId) {
      this.settleStep(runId, stepId, { status: 'failed', error: 'It has no working folder.' });
      return;
    }
    if (!this.deps.folderExists(cwd)) {
      this.settleStep(runId, stepId, {
        status: 'failed',
        error: `Its working folder is gone: ${cwd}.`,
      });
      return;
    }
    const workspaceId = run.attribution.workspaceId!;
    const itemOf = this.runItemOf(run, loaded.definition);
    if ('error' in itemOf) {
      this.settleStep(runId, stepId, { status: 'failed', error: `${itemOf.error}.` });
      return;
    }
    // Its skills, as this run copied them when it fired: checked before anything is built from them.
    const skills = this.stepSkillsOf(workspaceId, run, loaded.definition, stepId);
    if ('error' in skills) {
      this.settleStep(runId, stepId, { status: 'failed', error: skills.error });
      return;
    }
    const launch = agentStepLaunch({
      workspaceId,
      run,
      definition: loaded.definition,
      stepId,
      checkout: { cwd, scopeId },
      checkoutKind: runCheckoutKind(run, loaded.definition),
      ...skills,
      ...itemOf,
      previous: run.previous,
      folder: this.deps.runFolder,
    });
    if (!launch.ok) {
      this.settleStep(runId, stepId, { status: 'failed', error: launch.error });
      return;
    }
    const { attempt } = launch.request.step!;
    // The running step now holds the slot its run was let in with.
    this.admitted.delete(runId);
    this.writeSteps(
      runId,
      withAttemptStarted(
        this.stepsOf(runId),
        stepId,
        this.iso(),
        loaded.definition.agents?.[stepId]?.name,
      ),
    );
    this.broadcastRun(runId);
    // No turn to stop until it has launched: a stop meanwhile waits for it.
    this.starting.add(runId);
    try {
      let session: LaunchedSession;
      try {
        session = await this.deps.launchAgent(launch.request);
      } catch (error) {
        if (!this.stepRunning(runId, stepId, attempt)) return;
        // The person got there first: nothing failed, their review exists.
        if (error instanceof StartedByHandError) {
          this.finish(runId, 'rejected', { summary: error.message }, [
            { id: stepId, status: 'not-run' },
          ]);
          void this.pump();
          return;
        }
        this.settleStep(runId, stepId, { status: 'failed', error: describeError(error) });
        return;
      }
      if (!this.stepRunning(runId, stepId, attempt)) {
        this.endOrphanTurn(session.id);
        return;
      }
      const conversation = {
        harnessId: session.harnessId,
        id: session.claudeSessionId,
        cwd: session.cwd ?? cwd,
      };
      this.writeSteps(
        runId,
        withStep(this.stepsOf(runId), stepId, { sessionId: session.id, conversation }),
      );
      this.broadcastRun(runId);
      this.honourStepStop(runId, stepId, session.id);
    } finally {
      this.doneStarting(runId, stepId);
    }
  }

  /**
   * Where an agent step's skills are, once the run's copy of each skill its
   * agent names hashes to what the definition recorded: the copy, and the
   * attempt's plugin dir the host builds from it. Nothing for an agent that
   * names none. Any difference, a skill gone, or one the definition does not
   * list is the step's error: a retry delivers what was approved or nothing.
   */
  private stepSkillsOf(
    workspaceId: string,
    run: RunRecord,
    definition: RunDefinition,
    stepId: string,
  ): { skillsDir?: string; pluginDir?: string } | { error: string } {
    const names = definition.agents?.[stepId]?.skills ?? [];
    const record = run.steps?.find((candidate) => candidate.id === stepId);
    // A step the run has no record of is refused by `agentStepLaunch`, in its own words.
    if (names.length === 0 || !record) return {};
    let held: ReturnType<RunFolderPort['readSkills']>;
    try {
      held = this.deps.runFolder.readSkills(workspaceId, run.id, names);
    } catch (error) {
      const reason = describeError(error).trim().replace(/\.$/, '');
      return {
        error: `Its skills could not be read from the run folder (${reason}), so it did not start: run the automation again.`,
      };
    }
    // A skill the definition records no hash for differs too: `skillHash` is never undefined.
    const changed = names.find((name) => {
      const files = held[name];
      return !files || skillHash(files) !== definition.skills?.[name];
    });
    if (changed !== undefined)
      return {
        error: `Its skills in the run folder are not the ones its version holds (skills/${changed}), so it did not start: run the automation again.`,
      };
    return {
      skillsDir: this.deps.runFolder.skillsDir(workspaceId, run.id),
      pluginDir: `${this.deps.runFolder.attemptDir(workspaceId, run.id, stepId, record.attempt)}/plugin`,
    };
  }

  /**
   * A step a restart put back in line with its session (`recoverAfterRestart`).
   * It resumes there, with `INTERRUPTED_PROMPT` and the same attempt, keeping
   * what it set and wrote. A reminder cut off resumes under the reminder's
   * own cap, for what is still missing (`reminderCap`); a first turn, under
   * the record's. When that session is gone, or the person opened it first,
   * it runs as its next attempt in a new session instead, as a retry would:
   * it is read-only, so running it again is safe.
   */
  private async resumeStep(runId: string, stepId: string): Promise<void> {
    const run = this.deps.store.get(runId)!;
    const record = this.stepsOf(runId).find((step) => step.id === stepId)!;
    const session = this.sessionNamed(run, record.sessionId!);
    if (!session || this.deps.hasLiveTerminal(session)) {
      await this.runStepAgain(runId, stepId, session ? RESUME_SESSION_OPENED : RESUME_SESSION_GONE);
      return;
    }
    const { attempt } = record;
    // Running before the resume, as before a launch: its CLI asks for its step tools as it starts.
    this.writeSteps(runId, withStep(this.stepsOf(runId), stepId, { status: 'running' }));
    this.broadcastRun(runId);
    this.starting.add(runId);
    try {
      try {
        // What is missing cannot be read: the step fails with why, as its end would.
        const cap = record.reminded ? reminderCap(this.stepIO().missing(runId, stepId)) : undefined;
        await this.deps.resumeAgent(session, INTERRUPTED_PROMPT, cap);
      } catch (error) {
        if (!this.stepRunning(runId, stepId, attempt)) return;
        // Its pane mounted after the look, before the resume spawned: opened, as if it had been at the look.
        // Still starting meanwhile, so a stop asked for is honoured by the new launch.
        if (error instanceof SessionOpenedError) {
          await this.runStepAgain(runId, stepId, RESUME_SESSION_OPENED);
          return;
        }
        this.settleStep(runId, stepId, { status: 'failed', error: describeError(error) });
        return;
      }
      if (!this.stepRunning(runId, stepId, attempt)) {
        this.endOrphanTurn(session.id);
        return;
      }
      this.honourStepStop(runId, stepId, session.id);
    } finally {
      this.doneStarting(runId, stepId);
    }
  }

  /** A step a restart cut off runs as its next attempt in a new session, its last remembered as `why` ended it. */
  private async runStepAgain(runId: string, stepId: string, why: string): Promise<void> {
    const now = this.iso();
    const ended = { status: 'failed' as const, error: why, finishedAt: now };
    this.writeSteps(
      runId,
      withNextAttempt(this.stepsOf(runId), stepId, { status: 'queued', nowIso: now, ended }),
    );
    await this.startAgentStep(runId, stepId);
  }

  /**
   * A stop asked for while a step's turn was starting: end it now that it
   * has. When its session has no turn running after all, nothing will
   * report, so the step fails here.
   */
  private honourStepStop(runId: string, stepId: string, sessionId: string): void {
    if (!this.stopRequested.delete(runId)) return;
    const session = this.sessionNamed(this.deps.store.get(runId)!, sessionId);
    if (session && this.deps.stopAgent(session, 'you stopped it')) return; // Its turn's end fails the step.
    this.settleStep(runId, stepId, { status: 'failed', error: NO_TURN_TO_STOP }, { quiet: true });
  }

  /**
   * A turn whose step ended while it was starting, or under it (its run
   * stopped, failed or gone with its workspace): it is ended at once, and
   * nothing it does is recorded, since no running step names it.
   */
  private endOrphanTurn(sessionId: string): void {
    const session = this.deps
      .getWorkspaces()
      .flatMap((workspace) => workspace.sessions)
      .find((candidate) => candidate.id === sessionId);
    if (session) this.deps.stopAgent(session, RUN_ENDED);
  }

  /**
   * Start a command step's attempt in its run's checkout, in the order that
   * keeps it from running twice: render its `env:`, borrow the environment
   * it starts from, write `command.json` and an empty `$CONSOLA_OUTPUT`,
   * record the intent durably, and only then spawn. Every failure before
   * the intent is on disk is clean: the step fails, and nothing ran. In a
   * dry run, a command not marked `dry_run: run` is reported instead.
   */
  private async startCommandStep(runId: string, stepId: string): Promise<void> {
    const run = this.deps.store.get(runId)!;
    const loaded = this.definitionOf(run);
    if ('problem' in loaded) {
      this.failRun(runId, loaded.problem);
      return;
    }
    const cwd = run.checkout?.cwd;
    if (!cwd) {
      this.settleStep(runId, stepId, { status: 'failed', error: 'It has no working folder.' });
      return;
    }
    if (!this.deps.folderExists(cwd)) {
      this.settleStep(runId, stepId, {
        status: 'failed',
        error: `Its working folder is gone: ${cwd}.`,
      });
      return;
    }
    const workspaceId = run.attribution.workspaceId!;
    const itemOf = this.runItemOf(run, loaded.definition);
    if ('error' in itemOf) {
      this.settleStep(runId, stepId, { status: 'failed', error: `${itemOf.error}.` });
      return;
    }
    const prepared = prepareCommand({
      run,
      definition: loaded.definition,
      stepId,
      cwd,
      workspaceId,
      folder: this.deps.runFolder,
      ...itemOf,
      previous: run.previous,
    });
    if (!prepared.ok) {
      this.settleStep(runId, stepId, { status: 'failed', error: prepared.error });
      return;
    }
    const { command } = prepared;
    if (run.dryRun && command.step.dryRun === 'report') {
      this.reportCommand(runId, command);
      return;
    }

    let base: { env: NodeJS.ProcessEnv; secrets: string[] };
    try {
      base = await this.deps.commandEnv(workspaceId);
    } catch (error) {
      if (this.stepWaiting(runId, stepId, command.attempt)) {
        const why = `Its environment could not be prepared (${describeReason(error)}); nothing ran.`;
        this.settleStep(runId, stepId, { status: 'failed', error: why });
      }
      return;
    }
    // Its run may have ended while that was borrowed, or Consola quit:
    // nothing ran, and with no intent recorded the next start runs it.
    if (!this.started || !this.stepWaiting(runId, stepId, command.attempt)) return;
    const refused =
      writeCommandFile(this.deps.runFolder, command, base.secrets) ??
      createOutputFile(this.deps.runFolder, command);
    if (refused) {
      this.settleStep(runId, stepId, {
        status: 'failed',
        error: maskSecrets(refused, base.secrets),
      });
      return;
    }
    const spec = commandSpec(command, base);
    const now = this.iso();
    const envNames = command.values.map((value) => value.name);
    try {
      this.deps.store.updateDurably(runId, {
        steps: withCommandIntent(this.stepsOf(runId), stepId, now, envNames),
        updatedAt: now,
      });
    } catch (error) {
      const why = `Could not record that it was about to run (${describeReason(error)}); nothing ran.`;
      this.settleStep(runId, stepId, { status: 'failed', error: why });
      return;
    }
    // The running step now holds the slot its run was let in with.
    this.admitted.delete(runId);
    // Spawned, and its handle kept, before anything that could throw: a
    // running step with its intent on disk always has a process a stop or
    // a quit reaches, and a result that settles it.
    this.spawnCommand(command, spec, base.secrets);
    this.broadcastRun(runId);
  }

  /** A dry run's command: reported, never spawned, its `command.json` saying what it would have run. */
  private reportCommand(runId: string, command: PreparedCommand): void {
    const refused = writeCommandFile(this.deps.runFolder, command, []);
    if (refused) {
      this.settleStep(runId, command.step.id, { status: 'failed', error: refused });
      return;
    }
    // It settles without running: the slot its run was let in with is free.
    this.admitted.delete(runId);
    this.settleStep(runId, command.step.id, { status: 'reported' });
  }

  /** Spawn a command whose intent is on disk; its step settles from the result, which is handled at once. */
  private spawnCommand(command: PreparedCommand, spec: CommandSpec, secrets: string[]): void {
    let running: RunningCommand;
    try {
      running = this.deps.commands.start(spec);
    } catch (error) {
      this.commandSettled(command, secrets, { error });
      return;
    }
    this.runningCommands.set(command.runId, running);
    void running.result.then(
      (result) => this.commandSettled(command, secrets, { result }, running),
      (error: unknown) => this.commandSettled(command, secrets, { error }, running),
    );
  }

  /**
   * A command ended, or never started. Its result is written with its
   * status, in one line, then the run advances. A run that ended meanwhile
   * keeps what it has. One a quit let go of reports nothing: no line, no
   * notice, no output kept. Nothing awaits this, so nothing may escape it.
   */
  private commandSettled(
    command: PreparedCommand,
    secrets: string[],
    ended: { result: CommandResult } | { error: unknown },
    running?: RunningCommand,
  ): void {
    if (running && this.abandoned.has(running)) return;
    const { runId, step, attempt } = command;
    if (this.runningCommands.get(runId) === running) this.runningCommands.delete(runId);
    try {
      if (!this.stepRunning(runId, step.id, attempt)) return;
      const record = this.stepsOf(runId).find((candidate) => candidate.id === step.id)!;
      if ('error' in ended) {
        const error = maskSecrets(
          `The command could not start (${describeReason(ended.error)}); nothing ran.`,
          secrets,
        );
        this.settleStep(
          runId,
          step.id,
          { status: 'failed', error },
          { also: { command: neverStarted(record.command) } },
        );
        return;
      }
      const outcome = commandOutcome({
        folder: this.deps.runFolder,
        command,
        record,
        result: ended.result,
        secrets,
      });
      this.settleStep(runId, step.id, outcome.end, { also: outcome.changes });
    } catch (error) {
      console.error(`Run ${runId} could not record how its command ended.`, error);
      try {
        if (this.stillRunning(runId)) this.failRun(runId, describeError(error));
      } catch (failing) {
        console.error(`Run ${runId} could not be recorded as failed.`, failing);
      }
    }
  }

  /** Whether the run still has that step queued at that attempt: it may have ended while something was awaited. */
  private stepWaiting(runId: string, stepId: string, attempt: number): boolean {
    const step = this.stillRunning(runId)
      ? this.stepsOf(runId).find((candidate) => candidate.id === stepId)
      : undefined;
    return step?.status === 'queued' && step.attempt === attempt;
  }

  /**
   * A step's turn ended. A turn that reported itself is recorded first: its
   * figures on the step and the run's sum, its report in `turn.json`; then
   * the CLI's own report decides whether it failed (`reportedFailure`). A
   * turn without one fails on a stop or a non-zero exit, in the words a
   * one-step run uses. A turn that hit its cap fails with no reminder,
   * keeping what it set. A clean turn completes the step only when every
   * output it declares is set and every document it must write is written;
   * its outputs are then kept beside its documents. A clean turn that left
   * something out is given one reminder turn, the step still running and
   * holding its slot; a second one fails it.
   */
  private stepTurnEnded(
    run: RunRecord,
    record: StepRun,
    outcome: TurnOutcome,
    sessionId: string,
  ): void {
    const { report } = outcome;
    const loaded = this.definitionOf(run);
    // A failed init check is the step's error, ahead of the stop it caused.
    // The end checks again, from the report: the start can miss an init (one
    // the host could not hand over, one printed before the step's session
    // was recorded), and a turn that may have run without a server its agent
    // grants never completes its step.
    const required = 'definition' in loaded ? requiredServers(loaded.definition, record.id) : [];
    const initFailure =
      this.initFailures.get(sessionId) ??
      ('definition' in loaded && required.length > 0 && report?.init
        ? (strayServerProblem(required, report.init) ??
          initProblem(
            required,
            report.init,
            this.stepHarnessName(run, loaded.definition, record.id),
          ) ??
          undefined)
        : undefined);
    this.initFailures.delete(sessionId);
    if (report) {
      // The cap the turn ran under: the step's `max_turns`, else its agent's.
      this.recordTurn(
        run,
        record,
        outcome,
        report,
        'definition' in loaded ? stepCap(loaded.definition, record.id) : undefined,
      );
    }
    let failed: { error: string; atTurnLimit: boolean } | null;
    if (initFailure !== undefined) failed = { error: initFailure, atTurnLimit: false };
    else if (report)
      failed = reportedFailure({ ...outcome, report }, { reminder: record.reminded === true });
    else {
      const error = turnFailure(outcome);
      failed = error ? { error, atTurnLimit: false } : null;
    }
    // No init at all: a turn that failed on its own keeps its words; a clean one fails here.
    const unchecked = failed || report?.init ? null : uncheckedInitProblem(required);
    if (unchecked) failed = { error: unchecked, atTurnLimit: false };
    if (failed) {
      if (failed.atTurnLimit) this.keepOutputs(run, record.id);
      this.settleStep(run.id, record.id, { status: 'failed', error: failed.error });
      return;
    }
    this.stepTurnFinished(run, record, sessionId, loaded);
  }

  /**
   * One reporting turn, recorded: its figures added to the step
   * (`withTurnRecorded`, with the step's own cap) and the run's cost summed
   * again, in one write; then the CLI's own objects appended to the
   * attempt's `turn.json`. That file is for reading later; a failure to
   * write it is logged, and the record still holds the figures.
   */
  private recordTurn(
    run: RunRecord,
    record: StepRun,
    outcome: TurnOutcome,
    report: TurnReportView,
    stepMaxTurns: number | undefined,
  ): void {
    const steps = this.stepsOf(run.id).map((candidate) =>
      candidate.id === record.id ? withTurnRecorded(candidate, report, stepMaxTurns) : candidate,
    );
    const costUsd = runCostOf(steps);
    this.deps.store.update(run.id, {
      steps,
      ...(costUsd !== undefined ? { costUsd } : {}),
      updatedAt: this.iso(),
    });
    try {
      this.deps.runFolder.appendTurn(
        run.attribution.workspaceId ?? '',
        run.id,
        record.id,
        record.attempt,
        {
          endedAt: this.iso(),
          exitCode: outcome.exitCode,
          ...(outcome.stopped !== undefined ? { stopped: outcome.stopped } : {}),
          ...(report.maxTurns !== undefined ? { maxTurns: report.maxTurns } : {}),
          ...(report.raw.init !== undefined ? { init: report.raw.init } : {}),
          ...(report.raw.result !== undefined ? { result: report.raw.result } : {}),
          otherLines: report.otherLines,
        },
      );
    } catch (error) {
      console.error(`Could not write turn.json for run ${run.id}, step ${record.id}.`, error);
    }
  }

  /**
   * A step that hit its turn cap keeps what it set: its outputs go beside
   * its documents, as a completed step's do, though it failed. Nothing is
   * written when it set none (the step tools never record an empty set). A
   * failure to write them is logged; the step fails in its own words either
   * way, and its record keeps the outputs.
   */
  private keepOutputs(run: RunRecord, stepId: string): void {
    const record = this.stepsOf(run.id).find((candidate) => candidate.id === stepId);
    if (!record?.outputs) return;
    try {
      const dir = this.deps.runFolder.attemptDir(
        run.attribution.workspaceId ?? '',
        run.id,
        stepId,
        record.attempt,
      );
      this.deps.runFolder.writeJson(dir, 'outputs.json', record.outputs);
    } catch (error) {
      console.error(`Could not write outputs.json for run ${run.id}, step ${stepId}.`, error);
    }
  }

  /**
   * A step's turn ended cleanly: it completes when nothing it declares is
   * missing, is reminded once when something is, and fails after that.
   */
  private stepTurnFinished(
    run: RunRecord,
    record: StepRun,
    sessionId: string,
    loaded: LoadedDefinition,
  ): void {
    if ('problem' in loaded) {
      this.failRun(run.id, loaded.problem);
      return;
    }
    let without: string | null;
    let missing: { outputs: string[]; artifacts: string[] } | undefined;
    try {
      missing = this.stepIO().missing(run.id, record.id);
      without = endedWithout(missing);
    } catch (error) {
      missing = undefined;
      without = describeError(error);
    }
    if (without) {
      if (!record.reminded && missing) {
        this.remindStep(run, record, sessionId, missing);
        return;
      }
      this.settleStep(run.id, record.id, { status: 'failed', error: without });
      return;
    }
    const workspaceId = run.attribution.workspaceId!;
    try {
      const dir = this.deps.runFolder.attemptDir(workspaceId, run.id, record.id, record.attempt);
      this.deps.runFolder.writeJson(dir, 'outputs.json', record.outputs ?? {});
    } catch (error) {
      const reason = describeError(error).trim().replace(/\.$/, '');
      this.settleStep(run.id, record.id, {
        status: 'failed',
        error: `Could not write its outputs: ${reason}.`,
      });
      return;
    }
    this.settleStep(run.id, record.id, { status: 'completed' });
  }

  /**
   * The step's one reminder turn. `reminded` is written first, so a crash or
   * a second exit cannot remind twice; the step stays `running`, so its slot
   * stays held and its tools still accept writes. A reminder that cannot be
   * delivered, whether it throws or rejects, fails the step with the
   * reason. A stop while it is delivered waits for it, as for a launch.
   */
  private remindStep(
    run: RunRecord,
    record: StepRun,
    sessionId: string,
    missing: { outputs: string[]; artifacts: string[] },
  ): void {
    const session = this.sessionNamed(run, sessionId);
    if (!session) {
      this.settleStep(run.id, record.id, {
        status: 'failed',
        error: 'Its session was closed before it finished.',
      });
      return;
    }
    this.writeSteps(run.id, withStep(this.stepsOf(run.id), record.id, { reminded: true }));
    this.broadcastRun(run.id);
    const { attempt } = record;
    this.starting.add(run.id);
    // Called before this returns, as before; a synchronous throw lands in the same catch.
    void (async () => {
      try {
        await this.deps.remindAgent(session, reminderPrompt(missing), reminderCap(missing));
        if (!this.stepRunning(run.id, record.id, attempt)) {
          this.endOrphanTurn(session.id);
          return;
        }
        this.honourStepStop(run.id, record.id, session.id);
      } catch (error) {
        if (this.stepRunning(run.id, record.id, attempt))
          this.settleStep(run.id, record.id, { status: 'failed', error: describeError(error) });
      } finally {
        this.doneStarting(run.id, record.id);
      }
    })();
  }

  /**
   * What `starting` stood for has started, or failed to (a step's turn,
   * `stepId`, or the checkout, with none): it, and a stop asked for
   * meanwhile that nothing honoured, are let go of. Not when another step
   * of the run is running by now (the turn ended before the call that
   * started it returned, or the prepared run's first step went straight
   * into its launch): that step's launch holds them.
   */
  private doneStarting(runId: string, stepId?: string): void {
    if (this.stepsOf(runId).some((step) => step.id !== stepId && step.status === 'running')) return;
    this.starting.delete(runId);
    this.stopRequested.delete(runId);
  }

  /**
   * A step ended: how, on its own line, with whatever is recorded alongside
   * it (`also`: a command's result), then the run advances from it and its
   * slot is free.
   */
  private settleStep(
    runId: string,
    stepId: string,
    end: { status: 'completed' | 'reported' } | { status: 'failed'; error: string },
    options: { quiet?: boolean; also?: Partial<StepRun> } = {},
  ): void {
    this.writeSteps(
      runId,
      withStep(this.stepsOf(runId), stepId, { ...options.also, ...end, finishedAt: this.iso() }),
    );
    this.broadcastRun(runId);
    this.advance(runId, { quiet: options.quiet });
  }

  /**
   * A started steps run that cannot go on: a step still running fails with
   * it, and what it was running is ended, since nothing would record what
   * it did; the rest did not run.
   */
  private failRun(runId: string, error: string, options: { quiet?: boolean } = {}): void {
    const running = this.stepsOf(runId).filter((step) => step.status === 'running');
    this.finish(
      runId,
      'failed',
      { error },
      running.map((step): StepUpdate => ({ id: step.id, status: 'failed', error })),
    );
    for (const step of running) {
      if (step.kind === 'run') this.runningCommands.get(runId)?.stop();
      else if (step.sessionId) this.endOrphanTurn(step.sessionId);
    }
    if (!options.quiet)
      this.notify(`${this.deps.store.get(runId)!.automationId} did not finish`, error, runId);
    void this.pump();
  }

  /**
   * A steps run's own item source, from its definition, and the polled
   * object its fields are read from: the run folder's `item.json`, read only
   * for a source with no field table of its own (a poll's), since no other
   * reads it. Undefined when it has none; the error when it cannot be read.
   */
  private runItemOf(run: RunRecord, definition: RunDefinition): RunItemOf {
    return this.itemOfSource(run, runItemSource(definition, this.deps.workItems));
  }

  /** A run's item as `runItemOf` reads it, from a source already in hand: its entry's, at the run's version. */
  private itemOfSource(run: RunRecord, source: ItemSource | undefined): RunItemOf {
    if (!source || source.itemFields) return { source, polled: undefined };
    try {
      return {
        source,
        polled:
          this.deps.runFolder.readItem(run.attribution.workspaceId ?? '', run.id) ?? undefined,
      };
    } catch (error) {
      return {
        source,
        error: `Its item could not be read from the run folder (${describeReason(error)})`,
      };
    }
  }

  /**
   * The definition a started run executes, from its folder; or why it
   * cannot go on without it: the file is gone, or reading it failed
   * (`error`), which a later read may not.
   */
  private definitionOf(run: RunRecord): LoadedDefinition {
    const workspaceId = run.attribution.workspaceId ?? '';
    try {
      const definition = this.deps.runFolder.readDefinition(workspaceId, run.id);
      if (definition) return { definition };
      return {
        problem: `Its definition is gone from ${this.deps.runFolder.runDir(workspaceId, run.id)}; it cannot continue.`,
        gone: true,
      };
    } catch (error) {
      const reason = describeError(error).trim().replace(/\.$/, '');
      return {
        problem: `Its definition could not be read (${reason}); it cannot continue.`,
        gone: false,
        error,
      };
    }
  }

  /** The running agent step whose session this is, with its run. */
  private runningStepOf(sessionId: string): { run: RunRecord; record: StepRun } | undefined {
    for (const run of this.deps.store.runs()) {
      if (run.status !== 'running' || !isStepsRun(run)) continue;
      const record = run.steps?.find(
        (step) =>
          step.kind === 'agent' && step.status === 'running' && step.sessionId === sessionId,
      );
      if (record) return { run, record };
    }
    return undefined;
  }

  /** Whether the run is still running that step at that attempt: it may have ended while its launch was awaited. */
  private stepRunning(runId: string, stepId: string, attempt: number): boolean {
    const step = this.stillRunning(runId)
      ? this.stepsOf(runId).find((candidate) => candidate.id === stepId)
      : undefined;
    return step?.status === 'running' && step.attempt === attempt;
  }

  private stepsOf(runId: string): StepRun[] {
    return this.deps.store.get(runId)?.steps ?? [];
  }

  /** One change to a run's steps: its own line, and the run's `updatedAt`. */
  private writeSteps(runId: string, steps: StepRun[]): void {
    this.deps.store.update(runId, { steps, updatedAt: this.iso() });
  }

  /** A session of the run's workspace, by id, while it still has it. */
  private sessionNamed(run: RunRecord, sessionId: string): SessionView | undefined {
    return this.deps
      .getWorkspaces()
      .find((workspace) => workspace.id === run.attribution.workspaceId)
      ?.sessions.find((session) => session.id === sessionId);
  }

  /**
   * A session the person started on this item (by its key, the work item's)
   * with the same action since `sinceIso` — the review they clicked before
   * the automation got to it. A steps entry's action is its first agent
   * step's, when that names one.
   */
  private startedByHand(
    entry: Resolved,
    itemKey: string,
    sinceIso: string,
  ): SessionView | undefined {
    const label = entry.agent?.label ?? entry.steps?.byHandLabel;
    if (!label) return undefined;
    const since = Date.parse(sinceIso);
    return this.deps
      .getWorkspaces()
      .find((workspace) => workspace.id === entry.workspaceId)
      ?.sessions.find(
        (session) =>
          !session.automation &&
          session.workItemKey === itemKey &&
          session.workItemAction === label &&
          session.createdAt > since,
      );
  }

  /**
   * Run an agent's request as previewed, with that agent's authority as it
   * is now: once the asking session is deleted or moved, its request
   * cannot run.
   */
  private async approveRequest(run: RunRecord): Promise<RunRecord> {
    const tool = this.deps.registry.get(run.actionName);
    const context = this.authorityOf(run.trigger.actorId);
    if (!tool || !context) {
      const problem = !tool
        ? `${run.actionName} no longer exists`
        : 'the session that asked for it no longer exists';
      this.finish(run.id, 'failed', { error: `Not run: ${problem}.` });
      throw new Error(`Not run: ${problem}.`);
    }
    const approvedAt = this.iso();
    this.deps.store.update(run.id, {
      status: 'running',
      approvedAt,
      startedAt: approvedAt,
      updatedAt: approvedAt,
    });
    return this.guarded(
      run.id,
      run.id,
      async () => {
        const result = await this.deps.registry.invoke(
          tool.name,
          run.approval?.args ?? {},
          context,
          'run',
        );
        this.finish(run.id, 'completed', { result });
      },
      run.actionName,
    );
  }

  private authorityOf(sessionId: string | undefined): EngineToolContext | null {
    if (!sessionId) return null;
    try {
      return agentToolContext(sessionId, this.deps.getWorkspaces());
    } catch {
      return null; // The session is gone, and its authority with it.
    }
  }

  /** Read and resolve one workspace's folder, whole. False when the workspace went away meanwhile. */
  private async load(workspaceId: string): Promise<boolean> {
    const factory = this.factories.get(workspaceId);
    if (!factory) return false;
    let read: FactoryRead;
    try {
      const { exists, files } = await factory.folder.read();
      read = { exists, files, parse: parseFactory(files) };
    } catch (error) {
      // Nothing in it can be told apart from the failure: it is one issue, and nothing it ran is removed.
      console.error(`Could not read ${workspaceId}'s factory folder.`, error);
      read = unreadFolder(factory.read.exists, error);
    }
    if (this.factories.get(workspaceId) !== factory) return false;
    const checkedBefore = factory.resolved.some((entry) => pollOf(entry) !== null);
    factory.read = read;
    // Read once, at the folder's first load: afterwards only `reapply` replaces it.
    if (!factory.storeRead) {
      factory.applied = this.readApplied(factory.folder.folderPath);
      factory.storeRead = true;
    }
    this.reapply(workspaceId, factory);
    this.sweepCheckLogs(workspaceId, factory, checkedBefore);
    return true;
  }

  /** A folder's applied version, parsed from its texts; none when the store has none, or cannot say. */
  private readApplied(folder: string): WorkspaceFactory['applied'] {
    let record: AppliedFactory | null;
    try {
      record = this.deps.appliedStore.read(folder);
    } catch (error) {
      // The folder then applies as on its first start, which runs nothing a file does not say.
      console.error(
        `Could not read ${folder}'s applied factory; it applies as on a first start.`,
        error,
      );
      record = null;
    }
    if (!record) return null;
    try {
      return { record, parse: parseFactory(factoryFilesOf(record.texts, skillFilesOf(record))) };
    } catch (error) {
      console.error(
        `Could not parse ${folder}'s applied factory; it applies as on a first start.`,
        error,
      );
      return null;
    }
  }

  /**
   * Decide what of a folder runs, from its latest read and its applied
   * version, and resolve that: the read, when it applies (as a unit, or,
   * before the folder's first clean apply, entry by entry); otherwise the
   * applied version, less the entries this read removes, each with that
   * version's agents. What applied is persisted, and only when it changed.
   * No I/O but that write, and no parse: `syncWorkspaces` calls it on every
   * workspace write.
   */
  private reapply(workspaceId: string, factory: WorkspaceFactory): void {
    // Not read yet: there is nothing to decide, and nothing may overwrite the store.
    if (!factory.storeRead) return;
    const { read, applied } = factory;
    const ask = (agent: AgentDefinition, checkout: CheckoutKind) =>
      this.deps.agentHarness(workspaceId, agentQuery(agent, checkout));
    // Each changed entry's agents asked once, for both what blocks it and what it waits for.
    const asked = new Map<Automation, ReturnType<typeof agentIssues>>();
    const issuesOf = (automation: Automation) => {
      let issues = asked.get(automation);
      if (!issues) {
        issues = agentIssues(automation, read.parse.agents, ask);
        asked.set(automation, issues);
      }
      return issues;
    };
    const decision = decideApply({
      read: read.parse,
      applied: applied && { parse: applied.parse, clean: applied.record.clean },
      problemsOf: (automation) => issuesOf(automation).problems,
      waitsOf: (automation) => issuesOf(automation).waits,
    });
    if (decision.kind === 'keeps' && applied) {
      factory.standing = { decision, appliedAt: applied.record.appliedAt };
      const removed = new Set(decision.removed);
      const running = applied.parse.automations.filter((entry) => !removed.has(entry.name));
      this.resolveAll(workspaceId, factory, running, applied.parse.agents, applied.parse.skills);
      return;
    }
    factory.standing = undefined;
    // A first start keeps what its entries use; a clean apply, every text and skill it read.
    const clean = decision.kind === 'applies';
    const texts = clean
      ? appliedTexts(read.files, read.parse)
      : appliedTexts(read.files, read.parse, read.parse.automations);
    const skills = clean
      ? appliedSkills(read.parse)
      : appliedSkills(read.parse, read.parse.automations);
    this.keepApplied(factory, texts, skills, clean);
    this.resolveAll(
      workspaceId,
      factory,
      read.parse.automations,
      read.parse.agents,
      read.parse.skills,
    );
  }

  /** Persist what applied when it differs from what is kept; `appliedAt` moves only when a text or a skill does. */
  private keepApplied(
    factory: WorkspaceFactory,
    texts: Record<string, string>,
    skills: Record<string, AppliedSkill>,
    clean: boolean,
  ): void {
    const kept = factory.applied?.record;
    // A skill compares by its hash, which covers its bytes; a version kept with none holds none.
    const filesOf = (version: {
      texts: Record<string, string>;
      skills?: Record<string, AppliedSkill>;
    }) => stableStringify({ texts: version.texts, skills: skillHashesOf(version.skills) });
    const sameFiles = kept !== undefined && filesOf(kept) === filesOf({ texts, skills });
    if (sameFiles && kept.clean === clean) return;
    const record: AppliedFactory = {
      folder: factory.folder.folderPath,
      appliedAt: sameFiles ? kept.appliedAt : this.iso(),
      clean,
      texts,
      ...(Object.keys(skills).length > 0 ? { skills } : {}),
    };
    factory.applied = { record, parse: factory.read.parse };
    try {
      this.deps.appliedStore.write(record);
    } catch (error) {
      // It runs regardless; a restart decides again, from the files and what the store last kept.
      console.error(`Could not keep ${record.folder}'s applied factory.`, error);
    }
  }

  /**
   * Remove the logs of checks a folder that read cleanly no longer has (an
   * automation renamed or removed), at start-up as after a reload. A read
   * with issues keeps them all, as it keeps its lists: it may be hiding an
   * entry behind a typo. So does a folder that does not apply. Only a folder that has a poll entry, or had one at
   * its last read, is swept, so a workspace that never checks is never
   * looked at. A failure costs disk, not the load.
   */
  private sweepCheckLogs(
    workspaceId: string,
    factory: WorkspaceFactory,
    checkedBefore: boolean,
  ): void {
    if (holdsLists(factory)) return;
    const names = factory.resolved
      .filter((entry) => pollOf(entry) !== null)
      .map((entry) => entry.automation.name);
    if (names.length === 0 && !checkedBefore) return;
    try {
      this.deps.runFolder.sweepChecks(workspaceId, new Set(names));
    } catch (error) {
      console.error(`Could not sweep ${workspaceId}'s check logs.`, error);
    }
  }

  /** Resolve what runs, each entry against the agents and skills of the version it comes from; their warnings once each. */
  private resolveAll(
    workspaceId: string,
    factory: WorkspaceFactory,
    automations: readonly Automation[],
    agents: Readonly<Record<string, AgentDefinition>>,
    skills: Readonly<Record<string, SkillDefinition>>,
  ): void {
    factory.resolved = automations.map((automation) =>
      this.resolve(workspaceId, automation, agents, skills),
    );
    const warnings = new Map<string, FactoryNotice>();
    for (const entry of factory.resolved)
      for (const warning of entry.warnings ?? []) warnings.set(stableStringify(warning), warning);
    factory.warnings = [...warnings.values()];
  }

  /**
   * Forget schedules and lists no file names any more, and start each new
   * schedule now: it never fires for an occurrence that passed before it
   * existed.
   */
  private settleSchedules(): void {
    const resolved = this.allResolved();
    const keys = new Set(resolved.filter(cronOf).map(scheduleKey));
    this.deps.store.keepSchedules(keys);
    for (const key of keys) {
      if (!this.deps.store.lastFired(key)) this.deps.store.setLastFired(key, this.iso());
    }
    // A folder that did not read cleanly may be hiding an entry behind a
    // typo: its workspace's lists are kept until the files say otherwise,
    // so fixing the typo catches up instead of starting from scratch.
    // An agent's addition is kept the same way, so its mark survives too.
    // So is a folder that does not apply: an entry saved meanwhile is not
    // running yet, and would lose its marks.
    const kept = new Set(
      resolved
        .filter((entry) => entry.automation.trigger.kind === 'event' || pollOf(entry))
        .map(automationKey),
    );
    const named = new Set(resolved.map(automationKey));
    for (const [workspaceId, factory] of this.factories) {
      if (!holdsLists(factory)) continue;
      for (const key of this.deps.store.seenKeys())
        if (key.startsWith(`${workspaceId} `)) kept.add(key);
      for (const key of this.deps.store.addedKeys())
        if (key.startsWith(`${workspaceId} `)) named.add(key);
    }
    // A revocation is kept through a broken file too: the entry it guards is still in there.
    const revoked = new Set(named);
    for (const [workspaceId, factory] of this.factories) {
      if (!holdsLists(factory)) continue;
      for (const key of this.deps.store.revokedKeys())
        if (key.startsWith(`${workspaceId} `)) revoked.add(key);
    }
    this.deps.store.keepSeen(kept);
    this.deps.store.keepAdded(named);
    this.deps.store.keepRevoked(revoked);
  }

  private allResolved(): Resolved[] {
    return [...this.factories.values()].flatMap((factory) => factory.resolved);
  }

  private factoryOf(workspaceId: string): WorkspaceFactory {
    const factory = this.factories.get(workspaceId);
    if (!factory) throw new Error(`No workspace ${workspaceId}.`);
    return factory;
  }

  private entryOf(run: RunRecord): Resolved | undefined {
    return this.factories
      .get(run.attribution.workspaceId ?? '')
      ?.resolved.find((candidate) => candidate.automation.name === run.automationId);
  }

  /**
   * What an entry resolves to in its workspace, or why it cannot run. Which
   * tools, actions, scopes, connections and events exist is the runner's to
   * say; each problem names the one that was asked for. `agents` and
   * `skills` are the folder's, by name: what a step's `agent:` names, and
   * what that agent's `skills:` name.
   */
  private resolve(
    workspaceId: string,
    automation: Automation,
    agents: Readonly<Record<string, AgentDefinition>>,
    skills: Readonly<Record<string, SkillDefinition>>,
  ): Resolved {
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    const base = automationVersion(automation);
    const unable = (problem: string): Resolved => ({
      workspaceId,
      automation,
      version: base,
      problem,
      ...(isStepsEntry(automation) ? { agents } : {}),
    });
    const { trigger } = automation;

    let event: EventSource | undefined;
    let source: ItemSource | undefined;
    if (trigger.kind === 'event') {
      const resolution = resolveEventSource(trigger, automation.filter);
      if (!resolution.ok) return unable(resolution.problem);
      event = resolution.source;
      source = event;
      if (automation.run?.kind === 'tool') {
        return unable(
          'tools run on a schedule; an event starts an agent session (`run: { action: … }` or `run: { prompt: … }`)',
        );
      }
      if (workspace?.provider?.id !== trigger.connection) {
        return unable(
          `this workspace has no ${trigger.connection} account bound; bind one in its settings`,
        );
      }
      if (event.itemsHaveRepo && automation.scope) {
        return unable(
          `scope: a ${trigger.connection} item runs in a worktree of its own repository, so it takes no scope`,
        );
      }
      if (!event.itemsHaveRepo && !automation.scope) {
        return unable(
          `scope: ${trigger.connection} items have no repository, so say which scope this runs in`,
        );
      }
    }

    if (trigger.kind === 'poll') {
      if (automation.run?.kind === 'tool') {
        return unable(
          'tools run on a schedule; a poll starts an agent session or steps (`run: { action: … }`, `run: { prompt: … }` or `steps:`)',
        );
      }
      // With `item:`, each item is a work item of that connection, read from its URL; with `key:`, the check's own object.
      const connection = trigger.item?.connection;
      let workItems: ItemSource | undefined;
      if (connection !== undefined) {
        if (workspace?.provider?.id !== connection) {
          return unable(
            `this workspace has no ${connection} account bound; bind one in its settings`,
          );
        }
        workItems =
          (this.deps.workItems.canParseUrls(connection) &&
            workItemSource(connection, ['pr', 'issue'])) ||
          undefined;
        if (!workItems)
          return unable(`${connection} cannot read work item URLs, so \`item:\` cannot name it`);
        if (workItems.itemsHaveRepo && automation.scope) {
          return unable(
            `scope: a ${connection} item works in a checkout of its own repository, so it takes no scope`,
          );
        }
        if (!workItems.itemsHaveRepo && !automation.scope) {
          return unable(
            `scope: ${connection} items have no repository, so say which scope this runs in`,
          );
        }
      }
      source = pollSource(trigger, workItems);
    }

    if (trigger.kind === 'manual' && automation.appliesTo && automation.appliesTo.length > 0) {
      // Without `applies_to`, a run on demand may run a tool: it has no item. With it, every run has one.
      if (automation.run?.kind === 'tool') {
        return unable(
          'applies_to gives each run an item, and a tool takes none; run an action, a prompt or steps ' +
            '(`run: { action: … }`, `run: { prompt: … }` or `steps:`), or remove applies_to',
        );
      }
      // A run on demand names no connection: its items are the bound one's.
      const connection = workspace?.provider?.id;
      source =
        (connection !== undefined && workItemSource(connection, automation.appliesTo)) || undefined;
      if (!source)
        return unable(
          'applies_to needs a connection bound to this workspace; bind one in its settings',
        );
    }

    // The checks above are a steps entry's too; the rest are its own.
    if (isStepsEntry(automation))
      return this.resolveSteps(workspaceId, automation, agents, skills, source, event);
    const { run } = automation;

    if (run.kind === 'tool') {
      if (run.namespace !== CONSOLA_NAMESPACE) {
        return unable(`unknown tool namespace "${run.namespace}"; only consola# tools exist today`);
      }
      const tool = this.deps.registry.get(run.tool);
      if (!tool) return unable(`there is no Consola tool named "${run.tool}"`);
      if (!tool.automatable) return unable(`${run.ref} cannot be run by an automation`);
      const validated = this.deps.registry.validate(tool, run.with);
      if (!validated.ok) return unable(`with: ${validated.error}`);
      return { workspaceId, automation, version: base, tool, args: validated.args };
    }

    if (run.kind === 'action') {
      const named = actionNamed(workspace, run.name, automation, source);
      if ('problem' in named) return unable(named.problem);
      const { action } = named;
      const refused = this.harnessProblem(workspaceId);
      if (refused) return unable(refused);
      const appliesTo = typesItMayMiss(action, source);
      return {
        workspaceId,
        automation,
        // The body lives in settings, not the file: editing it asks again.
        version: automationVersion(automation, action.prompt),
        source,
        event,
        agent: {
          body: action.prompt,
          label: action.name,
          ...(action.groupId ? { groupId: action.groupId } : {}),
          runs: `${action.name} action`,
          ...(appliesTo ? { appliesTo } : {}),
        },
      };
    }

    const scoped = scopeNamed(workspace, automation.scope);
    if ('problem' in scoped) return unable(scoped.problem);
    const { scope } = scoped;
    const refused = this.harnessProblem(workspaceId);
    if (refused) return unable(refused);
    return {
      workspaceId,
      automation,
      version: base,
      source,
      event,
      agent: {
        body: run.prompt,
        ...(source ? { label: automation.name } : {}),
        ...(scope ? { scope } : {}),
        runs: 'Prompt',
      },
    };
  }

  /**
   * A `steps:` entry in its workspace, after the trigger and event checks it
   * shares with a `run:` entry. When more than one thing is wrong, the
   * problem is the first of: its scope; each step in file order (an agent
   * the folder lacks, an action the workspace lacks, then one that does not
   * apply to the items); item fields the connection lacks; `run:` steps on
   * Windows; the default harness, which only an agent step naming no agent
   * runs on; then each agent's harness, as the host answers for it.
   *
   * A step without `agent:` resolves exactly as in slice 1: its version and
   * definition are unchanged by the agents a sibling step names.
   */
  private resolveSteps(
    workspaceId: string,
    automation: StepsAutomation,
    agents: Readonly<Record<string, AgentDefinition>>,
    skills: Readonly<Record<string, SkillDefinition>>,
    source: ItemSource | undefined,
    event: EventSource | undefined,
  ): Resolved {
    const workspace = this.deps.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    const unable = (
      problem: string,
      warnings: FactoryNotice[] = [],
      servers: { recheck?: true; unasked?: true } = {},
    ): Resolved => ({
      workspaceId,
      automation,
      version: automationVersion(automation),
      problem,
      agents,
      skills,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...servers,
    });
    // Every leaf, a loop's steps included: what "does any step…" reads.
    const steps = leafSteps(automation.steps);

    const scoped = scopeNamed(workspace, automation.scope);
    if ('problem' in scoped) return unable(scoped.problem);

    const actions: RunDefinition['actions'] = {};
    // By step id, each step's agent as the run's definition keeps it; by agent, its hash for the version.
    const stepAgents: Record<string, AgentRequirements> = {};
    const agentHashes: Record<string, string> = {};
    // By name, every skill a step's agent names: the run copies these, and its definition holds their hashes.
    const stepSkills: Record<string, SkillDefinition> = {};
    for (const step of steps) {
      if (step.kind !== 'agent') continue;
      if (step.agent !== undefined) {
        // `parseFactory` keeps no entry whose agent is not valid; this guards an entry saved on its own.
        if (!Object.prototype.hasOwnProperty.call(agents, step.agent))
          return unable(
            `its step \`${step.id}\` names the agent \`${step.agent}\`, and agents/${step.agent}.md is not in this factory`,
          );
        const agent = agents[step.agent];
        // Nor any agent whose skill is not valid: the same guard, for what its run would copy.
        for (const skill of agent.skills) {
          if (!Object.prototype.hasOwnProperty.call(skills, skill))
            return unable(
              `agents/${agent.name}.md names the skill \`${skill}\`, and skills/${skill}/ is not in this factory`,
            );
          stepSkills[skill] = skills[skill];
        }
        stepAgents[step.id] = agentRequirements(agent);
        agentHashes[agent.name] = agent.hash;
      }
      if (step.action === undefined) continue;
      const named = actionNamed(workspace, step.action, automation, source);
      if ('problem' in named) return unable(named.problem);
      const { action } = named;
      const appliesTo = typesItMayMiss(action, source);
      actions[step.id] = {
        name: action.name,
        body: action.prompt,
        ...(action.groupId ? { groupId: action.groupId } : {}),
        ...(appliesTo ? { appliesTo } : {}),
      };
    }

    // A schedule has no item: a step that reads one does not load at all. A poll's fields are known only once
    // its check prints them, so its steps are checked when their turn comes.
    const fields = source?.itemFields;
    const [fieldProblem] =
      fields && source.connection !== undefined
        ? stepItemFieldProblems(automation.steps, fields, source.connection)
        : [];
    if (fieldProblem) return unable(fieldProblem);

    // `checkout: { pr: item }` on items its source can never give as pull requests (Call 15).
    const prCheckout = prCheckoutProblem(automation, source);
    if (prCheckout) return unable(prCheckout);

    if (this.deps.platform === 'win32' && steps.some((step) => step.kind === 'run'))
      return unable(NO_POSIX_SHELL);
    const hasAgentStep = steps.some((step) => step.kind === 'agent');
    // A step that names no agent runs on the workspace's default harness.
    const onDefault = steps.some((step) => step.kind === 'agent' && step.agent === undefined);
    const refused = onDefault ? this.stepHarnessProblem(workspaceId) : null;
    if (refused) return unable(refused);
    // Each agent's harness, as the host answers for it, for this entry's checkout kind: a problem stops the
    // entry, and so does a CLI that could not be asked (`stops`); a wait or a warning stops nothing. Each
    // answer's `knownTools` go into the definition, for the approval card (review S1).
    const answers = new Map<string, AgentHarnessAnswer>();
    const { problems, stops, warnings } = agentIssues(automation, agents, (agent, checkout) => {
      const answer = this.deps.agentHarness(workspaceId, agentQuery(agent, checkout));
      answers.set(agent.name, answer);
      return answer;
    });
    if (problems.length > 0) {
      const [first] = problems;
      return unable(first.message, warnings, first.path === 'mcpServers' ? { recheck: true } : {});
    }
    if (stops.length > 0)
      return unable(stops[0].message, warnings, { recheck: true, unasked: true });
    // A key the format accepts and the engine does not run yet stops the entry, in words (slice 3,
    // Call 2): last, so every other problem the entry has is said first.
    const notYet = flowNotYet(automation);
    if (notYet) return unable(notYet, warnings);

    // The bodies live in settings, not the file: editing one asks again. So
    // does editing an agent file a step names: its hash is in the version.
    const bodies = Object.fromEntries(
      Object.entries(actions).map(([id, action]) => [id, action.body]),
    );
    const version = automationVersion(automation, stepsResolvedBody(bodies, agentHashes));
    const firstAgent = steps.find((step): step is AgentStep => step.kind === 'agent');
    return {
      workspaceId,
      automation,
      version,
      source,
      event,
      agents,
      skills,
      ...(warnings.length > 0 ? { warnings } : {}),
      steps: {
        definition: {
          automation,
          version,
          actions,
          ...(Object.keys(stepAgents).length > 0
            ? {
                agents: Object.fromEntries(
                  Object.entries(stepAgents).map(([id, agent]) => [
                    id,
                    withKnownTools(agent, answers.get(agent.name)?.knownTools),
                  ]),
                ),
              }
            : {}),
          // Every run of an item entry has a work item, and no other entry's run works in one.
          checkout: entryCheckoutKind(automation),
          ...(entryReadsItems(automation) ? { readsItems: true as const } : {}),
          ...(Object.keys(stepSkills).length > 0
            ? {
                skills: Object.fromEntries(
                  Object.keys(stepSkills)
                    .sort()
                    .map((name) => [name, stepSkills[name].hash]),
                ),
              }
            : {}),
        },
        ...(scoped.scope ? { scope: scoped.scope } : {}),
        hasAgentStep,
        startsInDryRun: dryRunStarts(automation.steps),
        ...(firstAgent?.action !== undefined ? { byHandLabel: actions[firstAgent.id].name } : {}),
        skills: stepSkills,
      },
    };
  }

  /** Why the workspace's default harness cannot run an agent entry, as the entry's problem; null when it can. */
  private harnessProblem(workspaceId: string): string | null {
    const { name, problem } = this.deps.agentHarness(workspaceId);
    return problem
      ? `${name} can’t run read-only automation sessions: ${problem.replace(/\.$/, '')}`
      : null;
  }

  /**
   * Why the harness cannot run a steps entry's agent steps, as the entry's
   * problem: it cannot run read-only (`harnessProblem`), or its extra
   * arguments override a flag a step's reporting turn is launched with. A
   * legacy agent entry's turn does not report, so only steps entries ask this.
   */
  private stepHarnessProblem(workspaceId: string): string | null {
    const readOnly = this.harnessProblem(workspaceId);
    if (readOnly) return readOnly;
    const { name, stepProblem } = this.deps.agentHarness(workspaceId);
    return stepProblem ? `${name} can’t run automation steps: ${stepProblem}` : null;
  }

  /** An automation acts on its own workspace, as itself. */
  private contextFor(entry: Resolved): EngineToolContext {
    return {
      caller: { kind: 'automation', automation: entry.automation.name },
      scope: { workspaceIds: [entry.workspaceId], excludeSessionIds: [] },
    };
  }

  private nextDue(entry: Resolved, now: Date): Date | null {
    const cron = cronOf(entry);
    if (!cron) return null;
    const last = this.deps.store.lastFired(scheduleKey(entry));
    return nextCronOccurrence(cron.cron, last ? new Date(last) : now);
  }

  /**
   * The mode this run uses, and why it asks when the file says `auto` — or
   * `notify` for a dry run that starts something, which is asked for as
   * `auto` is (`asksUntilAccepted`).
   */
  private effectiveMode(
    entry: Resolved,
    trigger: RunTrigger,
  ): { mode: AutomationMode; asks?: string } {
    const { mode } = entry.automation;
    if (!asksUntilAccepted(entry)) return { mode };
    if (trigger.by === 'agent') return { mode: 'confirm', asks: AN_AGENT_ASKED };
    if (this.deps.store.acceptedVersion(automationKey(entry)) !== entry.version) {
      // Approving a poll entry's run does not accept it (`acceptApproved`), so it must not say it does.
      const asks = pollOf(entry)
        ? NOT_CHECKING_YET
        : 'Approve once to let this new or changed automation run on its own.';
      return { mode: 'confirm', asks };
    }
    return { mode };
  }

  private async fire(entry: Resolved, trigger: RunTrigger): Promise<RunRecord> {
    if (entry.agent) return this.fireAgent(entry, trigger);
    if (entry.steps) return this.fireSteps(entry, trigger);
    const { automation } = entry;
    const key = automationKey(entry);
    this.assertIdle(key, automation.name);
    const { mode, asks } = this.effectiveMode(entry, trigger);
    const run = this.newRun(entry, trigger, mode);
    this.deps.store.add(run);
    return this.guarded(
      key,
      run.id,
      async () => {
        const toolName = entry.tool!.name;
        const context = this.contextFor(entry);
        if (mode === 'auto') {
          this.deps.store.update(run.id, { startedAt: this.iso() });
          const result = await this.deps.registry.invoke(toolName, entry.args, context, 'run');
          this.finish(run.id, 'completed', { result });
          if ((result.actionable ?? 1) > 0) this.notify(automation.name, result.summary, run.id);
          return;
        }
        const preview = await this.deps.registry.invoke(toolName, entry.args, context, 'preview');
        if (mode === 'notify' || preview.actionable === 0) {
          this.finish(run.id, 'completed', { result: preview });
          if (mode === 'notify' && (preview.actionable ?? 1) > 0) {
            this.notify(automation.name, preview.summary, run.id);
          }
          return;
        }
        this.supersedeWaiting(entry, run.id);
        const summary = asks ? `${preview.summary} ${asks}` : preview.summary;
        this.deps.store.update(run.id, {
          status: 'needs-approval',
          summary,
          result: compact(preview.data),
          approval: { args: preview.approvalArgs ?? entry.args ?? {} },
          updatedAt: this.iso(),
        });
        this.deps.notify({
          title: `${automation.name} needs your approval`,
          body: `${summary} Review it in Consola.`,
          runId: run.id,
          workspaceId: entry.workspaceId,
          needsApproval: true,
        });
      },
      automation.name,
    );
  }

  /**
   * A scheduled or requested agent run, which has no item: its session
   * starts in the automation's scope. One waits at a time — a queued run
   * is what the next occurrence would have been.
   */
  private fireAgent(entry: Resolved, trigger: RunTrigger): RunRecord {
    const agent = entry.agent!;
    const lined = this.inLine(entry);
    if (lined) return lined;
    const scopeName = agent.scope?.name ?? '';
    const prompt = scheduledPrompt(agent.body, entry.automation.name, scopeName);
    const preview: AgentRunPreview = {
      kind: 'agent-run',
      runs: agent.runs,
      prompt,
      scope: scopeName,
    };
    return this.recordAgentRun(entry, trigger, preview, `${agent.runs} in ${scopeName}`);
  }

  /**
   * A `steps:` run. Scheduled or requested (no `item`), one waits at a time,
   * as an agent automation's does; for an item, its source's firing keeps it
   * to one open run per item. Its definition — the entry and every action a
   * step names, as of now — is written to its folder before it is recorded:
   * it is what the approval shows and what the run executes, whatever is
   * edited later. So is its own copy of every skill a step's agent names
   * (`skills/`), from the version it resolved against, which each attempt
   * checks against the definition's hashes before it launches. A poll's
   * item is written beside them (`item.json`), the object as its check
   * printed it.
   */
  private fireSteps(
    entry: Resolved,
    trigger: RunTrigger,
    item?: SourceItem,
    firedUnder?: string,
  ): RunRecord {
    if (!item) {
      const lined = this.inLine(entry);
      if (lined) return lined;
    }
    const { definition, scope, skills } = entry.steps!;
    const { mode, asks } = this.effectiveMode(entry, trigger);
    const base = this.newStepsRun(entry, trigger, mode, item);
    const run: RunRecord =
      firedUnder === undefined
        ? base
        : { ...base, result: { ...(base.result as StepsRunPreview), firedUnder } };
    let writing = 'definition';
    try {
      this.deps.runFolder.writeDefinition(entry.workspaceId, run.id, definition);
      writing = 'skills';
      if (definition.skills)
        this.deps.runFolder.writeSkills(
          entry.workspaceId,
          run.id,
          Object.fromEntries(
            Object.keys(definition.skills).map((name) => [name, skills[name].files]),
          ),
        );
      writing = 'item';
      if (item?.object !== undefined)
        this.deps.runFolder.writeItem(entry.workspaceId, run.id, item.object);
    } catch (error) {
      // Recorded, so it is seen; ended, so it holds no place in line.
      const reason = describeError(error).trim().replace(/\.$/, '');
      const now = this.iso();
      this.deps.store.add({
        ...run,
        status: 'failed',
        error: `Could not write its ${writing}: ${reason}.`,
        steps: closeSteps(run.steps!, now, [], 'failed'),
        finishedAt: now,
      });
      this.broadcast(entry.workspaceId);
      this.notify(`${entry.automation.name} could not start`, describeError(error), run.id);
      return this.deps.store.get(run.id)!;
    }
    const label = item ? entry.source!.label(item) : undefined;
    const summary = stepsRunLine(
      definition.automation,
      label ? { item: label } : { scope: scope?.name },
    );
    return this.recordByMode(entry, run, asks, {
      summary,
      described: label ?? `${describeRun(definition.automation)} in ${scope?.name ?? ''}`,
    });
  }

  /**
   * The run of a scheduled or requested automation that is queued, running
   * or waiting (at a gate, or out a retry): the one a fire returns instead of
   * adding another, so a parked run is the automation's one open run (Call
   * 11, review B3).
   */
  private inLine(entry: Resolved): RunRecord | undefined {
    return this.deps.store
      .runs()
      .find(
        (run) =>
          isRunOf(run, entry) &&
          (run.status === 'queued' || run.status === 'running' || run.status === 'waiting'),
      );
  }

  /**
   * One item its source fired, made one run: recorded as rejected when the
   * person already started its action by hand since the last look, or as
   * failed when it is a work item of a type the entry's one-step action
   * does not apply to. A step's action is checked when its turn comes. The
   * look that fired it: when the one before it was (`since`), when it was
   * (`at`), and the seen record it fired under (`firedUnder`).
   */
  private fireItem(
    entry: Resolved,
    item: SourceItem,
    look: { since: string; at: string; firedUnder: string },
  ): void {
    const { since, at, firedUnder } = look;
    const trigger = this.firedTrigger(entry, item, at);
    const { mode } = entry.automation;
    const byHand = this.startedByHand(entry, item.key, since);
    if (byHand) {
      // Never run, so it has nothing to snapshot.
      const run = entry.steps
        ? this.newStepsRun(entry, trigger, mode, item)
        : this.newRun(entry, trigger, mode);
      const now = this.iso();
      const summary = `Already started by hand: “${byHand.name}”.`;
      this.deps.store.add({
        ...run,
        status: 'rejected',
        summary,
        ...(run.steps ? { steps: closeSteps(run.steps, now, [], 'rejected') } : {}),
        finishedAt: now,
      });
      this.broadcast(entry.workspaceId);
      return;
    }
    if (entry.steps) {
      this.fireSteps(entry, trigger, item, firedUnder);
      return;
    }
    this.fireAgentOnItem(entry, trigger, item, firedUnder);
  }

  /**
   * A one-step entry's run on an item: the preview of its prompt on the
   * item, through its mode; or, when it is a work item of a type its action
   * does not apply to, a failed run that says so. `firedUnder` is the seen
   * record a source fired it under; a run a person or an agent asked for has
   * none.
   */
  private fireAgentOnItem(
    entry: Resolved,
    trigger: RunTrigger,
    item: SourceItem,
    firedUnder?: string,
  ): RunRecord {
    const agent = entry.agent!;
    const source = entry.source!;
    const described = source.label(item);
    const preview: AgentRunPreview = {
      kind: 'agent-run',
      runs: agent.runs,
      prompt: source.renderPrompt(agent.body, item, entry.automation.name),
      item: { url: item.url, title: item.title, author: item.author ?? '', label: described },
      ...(firedUnder !== undefined ? { firedUnder } : {}),
    };
    // Only a one-step action keeps the types it applies to (`typesItMayMiss`), and its label is the action's name.
    const refused =
      item.workItem && agent.appliesTo
        ? actionTypeRefusal({ name: agent.label!, appliesTo: agent.appliesTo }, item.workItem.type)
        : null;
    if (refused) {
      // Nothing it could run: recorded, so it is seen, and said, never left waiting for an approval it cannot use.
      const run: RunRecord = {
        ...this.newRun(entry, trigger, entry.automation.mode),
        result: preview,
        status: 'failed',
        error: refused,
        finishedAt: this.iso(),
      };
      this.deps.store.add(run);
      this.broadcast(entry.workspaceId);
      this.notify(`${entry.automation.name} could not start`, refused, run.id);
      return this.deps.store.get(run.id)!;
    }
    return this.recordAgentRun(entry, trigger, preview, described);
  }

  /**
   * What fired an item's run, as the run records it: the Inbox's event, with
   * its connection and the events whose views hold the item; or a poll's
   * check, with the connection when the item is its work item. A steps
   * run's item keeps what its steps may read, as it was when it fired.
   */
  private firedTrigger(entry: Resolved, item: SourceItem, at: string): RunTrigger {
    const source = entry.source!;
    const { event } = entry;
    if (event) {
      return {
        kind: 'event',
        at,
        connection: event.connection,
        events: event.eventsOf(item.inbox!),
        item: entry.steps
          ? source.runItem(item)
          : { key: item.key, url: item.url, title: item.title },
      };
    }
    return {
      kind: 'poll',
      at,
      ...(item.workItem && source.connection !== undefined
        ? { connection: source.connection }
        : {}),
      item: source.runItem(item),
    };
  }

  /** An agent run: its preview, and the prompt approving it sends. */
  private recordAgentRun(
    entry: Resolved,
    trigger: RunTrigger,
    preview: AgentRunPreview,
    described: string,
  ): RunRecord {
    const { mode, asks } = this.effectiveMode(entry, trigger);
    // The prompt approval sends is the one the preview showed.
    const run: RunRecord = {
      ...this.newRun(entry, trigger, mode),
      result: preview,
      approval: { args: { prompt: preview.prompt } },
    };
    return this.recordByMode(entry, run, asks, {
      summary: `${entry.agent!.runs}: ${described}.`,
      described,
    });
  }

  /**
   * The bookkeeping every agent and steps run shares, by the mode it runs
   * in: waiting for a person (`confirm`), or in line (`auto`, and a steps
   * entry's dry run under `notify`). A one-step entry under `notify` starts
   * nothing: it is only reported. `summary` is what the run says while it
   * waits; `described`, what it is about.
   */
  private recordByMode(
    entry: Resolved,
    run: RunRecord,
    asks: string | undefined,
    line: { summary: string; described: string },
  ): RunRecord {
    const { automation } = entry;
    if (run.mode === 'notify' && !run.dryRun) {
      this.deps.store.add({
        ...run,
        status: 'completed',
        summary: `${line.described}. Nothing started (notify).`,
        finishedAt: this.iso(),
      });
      this.notify(automation.name, `${line.described}.`, run.id);
    } else if (run.mode === 'confirm') {
      if (!run.trigger.item) this.supersedeWaiting(entry, run.id);
      const summary = `${line.summary}${asks ? ` ${asks}` : ''}`;
      this.deps.store.add({ ...run, status: 'needs-approval', summary });
      this.deps.notify({
        title: `${automation.name} needs your approval`,
        body: `${summary} Review it in Consola.`,
        runId: run.id,
        workspaceId: entry.workspaceId,
        needsApproval: true,
      });
    } else {
      this.deps.store.add({ ...run, status: 'queued', summary: line.summary });
    }
    this.broadcast(entry.workspaceId);
    void this.pump();
    return this.deps.store.get(run.id)!;
  }

  /**
   * One run at a time per key (an automation's key; a request's own id),
   * with the bookkeeping every tool run shares.
   */
  private async guarded(
    key: string,
    runId: string,
    work: () => Promise<void>,
    label: string,
  ): Promise<RunRecord> {
    this.inFlight.add(key);
    this.broadcastRun(runId);
    try {
      await work();
    } catch (error) {
      this.finish(runId, 'failed', { error: describeError(error) });
      this.notify(`${label} failed`, describeError(error), runId);
    } finally {
      this.inFlight.delete(key);
      this.broadcastRun(runId);
    }
    return this.deps.store.get(runId)!;
  }

  private assertIdle(key: string, name: string): void {
    if (this.inFlight.has(key)) throw new Error(`${name} is already running.`);
  }

  private newRun(entry: Resolved, trigger: RunTrigger, mode: AutomationMode): RunRecord {
    const { automation, version, workspaceId } = entry;
    const now = this.iso();
    return {
      id: this.deps.newId(),
      runner: 'local',
      source: 'personal',
      automationId: automation.name,
      actionName: isStepsEntry(automation) ? 'steps' : automation.run.ref,
      actionVersion: version,
      mode,
      trigger,
      status: 'running',
      attribution: {
        automationId: automation.name,
        actionName: isStepsEntry(automation) ? 'steps' : automation.run.ref,
        triggerKind: trigger.kind,
        workspaceId,
        ...(trigger.actorId ? { actorId: trigger.actorId } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * A new `steps:` run: a light preview as its result (what it runs is in its
   * folder's definition), every step pending, and a dry run under `notify`.
   * It carries no approval: approving queues it, and it runs its snapshot.
   */
  private newStepsRun(
    entry: Resolved,
    trigger: RunTrigger,
    mode: AutomationMode,
    item?: SourceItem,
  ): RunRecord {
    const { definition, scope } = entry.steps!;
    // Record order: a loop's row, then its steps', each marked with its loop.
    const steps = flatSteps(definition.automation.steps);
    const preview: StepsRunPreview = {
      kind: 'steps-run',
      steps: steps.map(({ step, block }) => ({
        id: step.id,
        kind: step.kind,
        ...(block ? { loop: block.id } : {}),
      })),
      ...(item
        ? {
            item: {
              url: item.url,
              title: item.title,
              author: item.author ?? '',
              label: entry.source!.label(item),
            },
          }
        : {}),
      ...(scope ? { scope: scope.name } : {}),
    };
    return {
      ...this.newRun(entry, trigger, mode),
      result: preview,
      steps: stepRecordsOf(definition.automation.steps),
      ...(entry.automation.mode === 'notify' ? { dryRun: true } : {}),
    };
  }

  /** An older approval for the same automation is moot once a newer plan exists. */
  private supersedeWaiting(entry: Resolved, keepId: string): void {
    for (const run of this.deps.store.runs()) {
      if (isRunOf(run, entry) && run.id !== keepId && run.status === 'needs-approval') {
        this.finish(run.id, 'rejected', { summary: 'Superseded by a newer run.' });
      }
    }
  }

  private waiting(runId: string): RunRecord {
    const run = this.deps.store.get(runId);
    if (!run) throw new Error(`No run ${runId}.`);
    if (run.status !== 'needs-approval')
      throw new Error(`Run ${runId} is ${run.status}, not waiting for approval.`);
    return run;
  }

  /**
   * End a run. A steps run's `stepUpdates` are applied as it ends, and
   * every step it had not reached is `not-run` (`closeSteps`). `records`,
   * when given, replaces its step records first, so a change to a row and
   * the run's end are one line (a gate's answer, a stop of a waiting run).
   */
  private finish(
    runId: string,
    status: Extract<RunStatus, 'completed' | 'failed' | 'rejected'>,
    outcome: { result?: EngineToolResult; summary?: string; error?: string },
    stepUpdates: StepUpdate[] = [],
    records?: StepRun[],
  ): void {
    const now = this.iso();
    const run = this.deps.store.get(runId);
    // An ended run holds no slot.
    this.admitted.delete(runId);
    // A failed agent run's launch-time "Running in …" says nothing true any more.
    const stale = status === 'failed' && !outcome.summary ? sessionRunningIn(run) : null;
    this.deps.store.update(runId, {
      status,
      ...(stale !== null ? { summary: `Did not finish in “${stale}”.` } : {}),
      ...(outcome.result
        ? { summary: outcome.result.summary, result: compact(outcome.result.data) }
        : {}),
      ...(outcome.summary ? { summary: outcome.summary } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...((records ?? run?.steps)
        ? { steps: closeSteps(records ?? run!.steps!, now, stepUpdates, status) }
        : {}),
      updatedAt: now,
      finishedAt: now,
    });
    this.broadcastRun(runId);
  }

  private notify(title: string, body: string, runId: string): void {
    const workspaceId = this.deps.store.get(runId)?.attribution.workspaceId;
    if (!workspaceId) return;
    this.deps.notify({ title, body, runId, workspaceId, needsApproval: false });
  }

  private broadcastRun(runId: string): void {
    const workspaceId = this.deps.store.get(runId)?.attribution.workspaceId;
    if (workspaceId) this.broadcast(workspaceId);
  }

  private broadcast(workspaceId: string): void {
    if (this.factories.has(workspaceId))
      this.deps.broadcast(workspaceId, this.snapshot(workspaceId));
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }
}

/** The scope an entry names in its workspace (none when it names none), or why there is no such scope. */
function scopeNamed(
  workspace: WorkspaceView | undefined,
  name: string | undefined,
): { scope?: ScopeView } | { problem: string } {
  if (!name) return {};
  const scope = workspace?.scopes.find((candidate) => candidate.name === name);
  if (scope) return { scope };
  const names = workspace?.scopes.map((candidate) => candidate.name).join(', ');
  return {
    problem: `no scope named "${name}" in this workspace${names ? `; it has: ${names}` : ''}`,
  };
}

/**
 * The workspace action an entry names, or why there is none by that name or
 * it does not apply to its items: it must apply to every type the source's
 * items can be. A poll with `item:` is the exception, since which types its
 * check returns is known only when it runs: there it must apply to one of
 * them, and a run on an item of the other type fails at that step
 * (`agentStepLaunch`, from the types `typesItMayMiss` kept in its
 * definition), or, for a one-step entry, as it fires (`fireItem`).
 */
function actionNamed(
  workspace: WorkspaceView | undefined,
  name: string,
  automation: Automation,
  source: ItemSource | undefined,
): { action: ActionView } | { problem: string } {
  const action = workspace?.actions.find((candidate) => candidate.name === name);
  if (!action) return { problem: `no action named ${name} in this workspace` };
  const types = source?.itemTypes ?? [];
  const { trigger } = automation;
  if (trigger.kind === 'poll' && trigger.item !== undefined) {
    if (!types.some((type) => action.appliesTo.includes(type))) {
      return {
        problem: `the ${name} action applies to neither pull requests nor issues; write it as a prompt`,
      };
    }
    return { action };
  }
  const missing = types.find((type) => !action.appliesTo.includes(type));
  if (missing)
    return {
      problem: `the ${name} action does not apply to ${missing === 'pr' ? 'pull requests' : 'issues'}`,
    };
  return { action };
}

/**
 * The types an action applies to, kept when the source's items may be of
 * another (a poll's with `item:`, which `actionNamed` lets through when the
 * action applies to one of them), so that a run on an item of another type
 * is refused (`actionTypeRefusal`). Undefined when it applies to every type
 * its items can be: then nothing records them, and definitions stay as they
 * were.
 */
function typesItMayMiss(
  action: ActionView,
  source: ItemSource | undefined,
): Array<'pr' | 'issue'> | undefined {
  const types = source?.itemTypes ?? [];
  return types.every((type) => action.appliesTo.includes(type)) ? undefined : [...action.appliesTo];
}

/** What one of an entry's runs is about, by its source's items; undefined when its runs have no item. */
function takesItemOf(entry: Resolved): AutomationView['takesItem'] {
  const { source } = entry;
  if (!source) return undefined;
  const types = source.itemTypes;
  if (types.length === 0) return entry.automation.trigger.kind === 'poll' ? 'item' : undefined;
  if (types.length > 1) return 'pr-or-issue';
  return types[0];
}

/**
 * A poll's check as written (its command, its interval in words, and the
 * field whose change fires an item again), and what its last check came to:
 * when it ended, and what it found or why it failed.
 */
function checkViewOf(trigger: PollTrigger, outcome: CheckState['outcome']): CheckView {
  const last: Partial<CheckView> = !outcome
    ? {}
    : 'error' in outcome
      ? { lastAt: outcome.at, error: outcome.error }
      : {
          lastAt: outcome.at,
          items: outcome.items,
          fired: outcome.fired,
          skipped: outcome.skipped,
          ...(outcome.baseline ? { baseline: true as const } : {}),
        };
  return {
    command: trigger.run,
    every: describeEvery(trigger.everyMs).words,
    ...(trigger.changed !== undefined ? { changed: trigger.changed } : {}),
    ...last,
  };
}

/** A started run's definition, read from its folder, or why it cannot be (`definitionOf`). */
type LoadedDefinition =
  | { definition: RunDefinition }
  | { problem: string; gone: true }
  | { problem: string; gone: false; error: unknown };

/** What an agent run says while its turn runs. */
function runningIn(sessionName: string): string {
  return `Running in “${sessionName}”.`;
}

/** The session an agent run's summary still says it is running in; null once it says anything else. */
function sessionRunningIn(run: RunRecord | undefined): string | null {
  if (!run || !isAgentRun(run)) return null;
  return /^Running in “(.*)”\.$/.exec(run.summary ?? '')?.[1] ?? null;
}

/** A run that starts a session: its result is the preview of what it starts. */
function isAgentRun(run: RunRecord): boolean {
  return (run.result as { kind?: unknown } | undefined)?.kind === 'agent-run';
}

/**
 * A run as the activity list shows it: its kind, and its result only while
 * it waits for a person or a slot. Everything else is `getRun`'s.
 */
function toListEntry(run: RunRecord): RunListEntry {
  const { result, approval: _approval, steps: _steps, ...rest } = run;
  const step = currentStep(run);
  return {
    ...rest,
    kind: runKind(run),
    ...(run.status === 'needs-approval' || run.status === 'queued' ? { result } : {}),
    ...(step ? { step } : {}),
  };
}

/**
 * The step a list row names: the first leaf queued, running or waiting (a
 * gate, a retry), else a loop's row waiting at its exhaustion gate.
 * Otherwise where the run ended: a failed run's failed step (a failed leaf
 * before the failed row of the loop it is in, as `retryTargetOf` orders
 * them, review S10), or, when it failed between steps, the first step it did
 * not reach (`not-run`), so the row never reads "failed at" a step that
 * completed; none when it failed before its first step, or after its last.
 * A run rejected at a gate: that gate's row. For any other ended run, the
 * last step that ran. A skipped or not-run step has not run.
 */
function currentStep(run: RunRecord): RunListEntry['step'] {
  const { steps, status } = run;
  if (!steps?.length) return undefined;
  const leaf = (step: StepRun) => !isLoopRow(step);
  let at = steps.findIndex(
    (step) =>
      leaf(step) &&
      (step.status === 'queued' || step.status === 'running' || step.status === 'waiting'),
  );
  if (at < 0) at = steps.findIndex((step) => isLoopRow(step) && step.status === 'waiting');
  if (at < 0 && status === 'failed') {
    at = steps.findIndex((step) => step.status === 'failed' && leaf(step));
    if (at < 0) at = steps.findIndex((step) => step.status === 'failed');
    if (at < 0) {
      const unreached = steps.findIndex((step) => step.status === 'not-run');
      if (unreached <= 0) return undefined;
      at = unreached;
    }
  }
  if (at < 0 && status === 'rejected')
    at = steps.findIndex((step) => step.gate?.decision === 'reject');
  if (at < 0) {
    for (let index = steps.length - 1; index >= 0 && at < 0; index--) {
      if (['completed', 'failed', 'reported'].includes(steps[index].status)) at = index;
    }
  }
  if (at < 0) return undefined;
  const row = steps[at];
  // The run's preview says which loop each row is inside; the loop's own row, its rounds.
  const preview = run.result as Partial<StepsRunPreview> | undefined;
  const loop = preview?.steps?.find((step) => step.id === row.id)?.loop;
  const max = isLoopRow(row)
    ? row.max
    : loop === undefined
      ? undefined
      : steps.find((step) => step.id === loop)?.max;
  const atGate =
    row.gate !== undefined && (row.status === 'waiting' || row.gate.decision === 'reject');
  return {
    id: row.id,
    status: row.status,
    index: at + 1,
    count: steps.length,
    kind: row.kind,
    ...(row.round !== undefined ? { round: row.round } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(row.retryAt !== undefined ? { retryAt: row.retryAt } : {}),
    ...(atGate ? { gate: true as const } : {}),
  };
}

/** Waiting for a person, a slot, a gate's answer or a retry, or working: the snapshot never leaves these out. */
const LIVE_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'needs-approval',
  'queued',
  'running',
  'waiting',
]);

function isLiveRun(run: RunRecord): boolean {
  return LIVE_RUN_STATUSES.has(run.status);
}

/** Newest first by `createdAt`, ties by id descending, so the order is stable. */
function newestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return (
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** A steps run is an agent run when any step is an agent step, so "Prompts & reviews" holds it; else a tool run. */
function runKind(run: RunRecord): RunKind {
  if (isAgentRequest(run)) return 'request';
  if (isAgentRun(run)) return 'agent';
  if (isStepsRun(run)) return run.steps?.some((step) => step.kind === 'agent') ? 'agent' : 'tool';
  return 'tool';
}

/**
 * Whether an entry runs unattended only at a version a person accepted, so a
 * new or edited one asks first: `auto`, and a `notify` steps entry whose dry
 * run starts something (an agent step, or a `dry_run: run` command). A dry
 * run that only reports starts nothing, and a one-step entry under `notify`
 * starts nothing either; neither asks. A poll entry asks by the same rule,
 * but only Allow accepts one (`allow`), never an approved run.
 */
function asksUntilAccepted(entry: Resolved): boolean {
  const { mode } = entry.automation;
  return mode === 'auto' || (mode === 'notify' && entry.steps?.startsInDryRun === true);
}

/** What a steps run says while it waits to start: what it runs, and the item or scope it is about. */
function stepsRunLine(
  automation: StepsAutomation,
  about: { item?: string; scope?: string },
): string {
  const runs = describeRun(automation);
  return about.item ? `${runs}: ${about.item}.` : `${runs} in ${about.scope ?? ''}.`;
}

/** What the sequencer reads a run's item with: its source's fields, and whether they are untyped (a poll's). */
function stepItemOf(
  run: RunRecord,
  { source, polled }: { source: ItemSource | undefined; polled?: Record<string, unknown> },
): { itemValue?: (field: string) => ExprValue | undefined; untypedItem?: boolean } {
  const item = run.trigger.item;
  if (!source || !item) return {};
  return {
    itemValue: (field) => source.itemValue(item, field, polled),
    ...(source.itemFields ? {} : { untypedItem: true }),
  };
}

/** The key of the automation a run belongs to (`automationKey`); undefined for a run of no workspace. */
function automationKeyOf(run: RunRecord): string | undefined {
  const { workspaceId } = run.attribution;
  return workspaceId === undefined
    ? undefined
    : automationKey({ workspaceId, automation: { name: run.automationId } });
}

/** Whether a source fired the run (the Inbox, or a poll's check), rather than a person or an agent asking. */
function firedBySource(run: RunRecord): boolean {
  return run.trigger.kind === 'event' || run.trigger.kind === 'poll';
}

/** A run's trigger with its item's title (and author, when the source knows one) as its source has it now. */
function refreshedTrigger(
  run: RunRecord,
  item: SourceItem,
): Pick<RunRecord, 'trigger'> | Record<string, never> {
  const recorded = run.trigger.item;
  if (!recorded) return {};
  return {
    trigger: {
      ...run.trigger,
      item: {
        ...recorded,
        title: item.title,
        ...(item.author !== undefined ? { author: item.author } : {}),
      },
    },
  };
}

/** What an entry's runs take, as a refusal names it: "pull requests", "issues", "pull requests or issues", or "an item of its last check". */
function itemsInWords(source: ItemSource): string {
  const types = source.itemTypes;
  if (types.length === 0) return 'an item of its last check';
  if (types.length > 1) return 'pull requests or issues';
  return types[0] === 'pr' ? 'pull requests' : 'issues';
}

/** An Inbox item as a run on a chosen item takes it: whatever the filter says, it passes. */
function inboxSourceItem(inbox: InboxItemView): SourceItem {
  return {
    key: inbox.key,
    passes: true,
    title: inbox.title,
    url: inbox.url,
    author: inbox.author,
    workItem: inbox.workItem,
    inbox,
  };
}

/** A run's item as it recorded it, its work item rebuilt from its trigger (`itemRefOf`): what a run on a chosen item starts with when its source no longer has it. */
function recordedItem(run: RunRecord, item: RunItem): SourceItem {
  const workItem = itemRefOf(run);
  return {
    key: item.key,
    passes: true,
    title: item.title,
    url: item.url,
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(workItem ? { workItem } : {}),
  };
}

/** A problem with one entry of factory.yml, rather than with the file as a whole. */
function isEntryIssue(issue: FactorySpecIssue): boolean {
  return issue.path.startsWith('automations[');
}

/** The file an entry of that name lives in, as `whereIs` found it. */
function homeFile(name: string, where: 'factory.yml' | 'file'): string {
  return where === 'factory.yml' ? 'factory.yml' : `automations/${name}.yaml`;
}

/** An applied version's skill files, by skill name, as `factoryFilesOf` takes them; none for a version kept with none. */
function skillFilesOf(record: AppliedFactory): Record<string, AppliedSkill['files']> | undefined {
  if (!record.skills) return undefined;
  const files: Record<string, AppliedSkill['files']> = {};
  for (const name of Object.keys(record.skills)) files[name] = record.skills[name].files;
  return files;
}

/** Each skill's hash by its name, sorted: what "the same skills" compares. */
function skillHashesOf(skills: Record<string, AppliedSkill> | undefined): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(skills ?? {}).sort()) hashes[name] = skills![name].hash;
  return hashes;
}

/**
 * Whether a folder keeps its workspace's lists (seen items, additions,
 * revocations) and check logs whatever its entries say: it read with
 * issues, or it does not apply, so what runs is not what the files say.
 */
function holdsLists(factory: Pick<WorkspaceFactory, 'read' | 'standing'>): boolean {
  return factory.read.parse.issues.length > 0 || factory.standing !== undefined;
}

/** An entry as an applied version has it: its factory.yml item, or its whole file; null when it has none. */
function appliedEntryText(
  applied: { record: AppliedFactory; parse: FactoryParseResult },
  name: string,
): string | null {
  const entry = applied.parse.automations.find((candidate) => candidate.name === name);
  if (!entry?.file) return null;
  const text = applied.record.texts[entry.file];
  if (text === undefined) return null;
  return entry.file === 'factory.yml' ? automationEntryText(text, name) : text;
}

/** What keeps a folder from applying, as a save's result says it: `<file>:<line>: <message>`. */
function describeBlocking(issue: FactorySpecIssue): string {
  const where = [issue.file, issue.line].filter((part) => part !== undefined).join(':');
  const message = issue.message.trim().replace(/\.$/, '');
  return where ? `${where}: ${message}` : message;
}

/** An issue as a reason: where it is, then what is wrong. */
function describeIssue(issue: FactorySpecIssue): string {
  const where = issue.path || (issue.line ? `line ${issue.line}` : '');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/** A save refused, with every reason: what the agent reads and acts on. */
/**
 * Why an entry cannot be saved because a step names an agent whose file is
 * in the folder but has problems of its own (or could not be read): said as
 * the folder's issues say it, never as a file that is not there. Null when
 * every agent it names is valid, or not there at all (which `resolveSteps`
 * says).
 */
function agentWithProblems(automation: Automation, read: FactoryParseResult): string | null {
  if (!isStepsEntry(automation)) return null;
  for (const step of leafSteps(automation.steps)) {
    if (step.kind !== 'agent' || step.agent === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(read.agents, step.agent)) continue;
    const file = `agents/${step.agent}.md`;
    if (read.present.includes(file) || read.present.includes('agents/'))
      return `its step \`${step.id}\` names the agent \`${step.agent}\`, which has problems of its own in ${file}; save it once they are fixed`;
  }
  return null;
}

function notSaved(reasons: string[]): Error {
  return new Error(
    `Not saved: ${reasons.map((reason) => reason.trim().replace(/\.$/, '')).join('; ')}.`,
  );
}

/** A run of this automation, in this workspace. */
function isRunOf(run: RunRecord, entry: Resolved): boolean {
  return (
    !isAgentRequest(run) &&
    run.attribution.workspaceId === entry.workspaceId &&
    run.automationId === entry.automation.name
  );
}

/** An agent's call waiting for a person, as opposed to a run of an automation. */
function isAgentRequest(run: RunRecord): boolean {
  return run.source === 'manual';
}

/** What a request asks for — tool and exact arguments — so asking twice for one plan is recognised. */
function requestVersion(ref: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify([ref, args]))
    .digest('hex')
    .slice(0, 16);
}

function compact(data: unknown): unknown {
  try {
    return JSON.stringify(data).length > MAX_RESULT_CHARS ? { truncated: true } : data;
  } catch {
    return undefined;
  }
}

import type {
  AutomationMode,
  FactoryNotice,
  FactorySpecIssue,
  McpServerDefinition,
  RunRecord,
  RunStatus,
  StepRunStatus,
} from '@consola/factory-spec';
import type { RunFilter } from './runFilter';
import type { ServerCheckView } from './servers/checkServer';
import type { ServerFacts } from './servers/serverFacts';
import type { CallView } from './steps/definition';

/** A factory server an entry's calls use, as its page shows it: its facts, and how its last Check server went. */
export interface ServerUseView extends ServerFacts {
  lastCheck?: ServerCheckView;
}
import type { SecretBindingView } from './secrets/secretsView';

/** One automation from a workspace's factory folder, as the app shows it. */
export interface AutomationView {
  name: string;
  mode: AutomationMode;
  /** The trigger in words: "When a pull request asks for your review", "Weekdays at 9:00". */
  trigger: string;
  /** A cron trigger's expression, as written. */
  schedule?: string;
  /** What starts it: a clock, the Inbox's events, a check command, or only a person (or an agent) asking. */
  source: 'cron' | 'event' | 'poll' | 'manual';
  /** Fired by what it watches (an event or a poll) rather than a clock: its Run now is "Check now". */
  onEvent: boolean;
  /**
   * What one of its runs is about: pull requests, issues or either (work
   * items), or an item of its poll's last check. Absent when its runs have
   * no item, as a schedule's do, and while it has a problem.
   */
  takesItem?: 'pr' | 'issue' | 'pr-or-issue' | 'item';
  /** A poll's check: its command and interval as written, and how its last check went. */
  check?: CheckView;
  /** A poll entry whose command no person has allowed at this version: it does not check. */
  needsAllow?: true;
  /** Present with `needsAllow`: the version Allow sends back, refused once the entry changed. */
  version?: string;
  /** A tool run in-process, or an agent session. A `steps:` entry is `agent` when any step is an agent step. */
  kind: 'tool' | 'agent';
  /** What it runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions", "Steps: review → publish". */
  runs: string;
  /** The `run:` target as written: a tool reference, an action's name, or `prompt`; `steps` for a `steps:` entry. */
  target: string;
  /**
   * A `steps:` entry's steps in file order, as its pipeline draws them, problem or not.
   * `summary` is "Prompt", "Review action", an agent-only step's agent, a command's first line, or a call's
   * `<server>#<tool>`.
   */
  steps?: Array<{
    id: string;
    kind: 'agent' | 'run' | 'uses';
    if?: string;
    summary: string /** A command or a call marked `dry_run: run`: it runs when the run only reports. */;
    dryRun?: true;
    /** The agent it runs as, as its node names it: "investigator · claude-work · opus". */
    agent?: string;
    /** The agent's file, "agents/investigator.md": what the Allow card lists. */
    agentFile?: string;
    /** The servers its agent names, each narrowed to `tools` when it is; absent when it names none. */
    servers?: Array<{ name: string; tools?: string[] }>;
    /** The skills its agent names, by folder name; absent when it names none. */
    skills?: string[];
  }>;
  /** The file it lives in, relative to the factory folder: `factory.yml` or `automations/<name>.yaml`. */
  file?: string;
  /** 1-based line in its file: an automation file's entry is its line 1. */
  line?: number;
  /** Next scheduled occurrence (ISO), or null when it is not on a schedule or will not run. */
  nextRunAt: string | null;
  /**
   * An `auto` automation that is new or changed since a person last
   * approved it: its next run asks first, then it runs on its own.
   */
  asksFirst?: boolean;
  /**
   * Why it is not scheduled even though the file parsed: an unknown tool,
   * action, scope or event, or arguments the tool rejects.
   */
  problem?: string;
  /** The names its problem says are not bound: its row offers Bind…. */
  unbound?: string[];
  /** The factory servers its calls use, for the page's Check server; absent when none. */
  servers?: ServerUseView[];
  /**
   * Its problem came from asking a harness's CLI about servers (a probe
   * that failed, or a server refused against its answer): Check again asks
   * again. Absent otherwise.
   */
  recheck?: true;
  /** The session whose agent wrote it into the file; new until a person opens its details. */
  addedBy?: { sessionName: string; sessionId: string; isNew: boolean };
}

/**
 * The item a person or an agent picks to run an automation on: a work item of
 * its connection, by identity or by a pasted URL (Call 24), or an item of its
 * poll's last check, by key. Not factory-spec's `RunTarget`, which is what a
 * `run:` step runs.
 */
export type ItemTarget =
  | { workItem: { repo: string; number: number; type: 'pr' | 'issue' } }
  | { key: string }
  | { url: string };

/** One item Run on… offers (Call 26). */
export interface ItemTargetRow {
  /** What choosing it sends back. */
  target: ItemTarget;
  /** "sprocket/catalog-portal#51 “Fix the cart total”"; a key item's is "“Title”". */
  label: string;
  /** Its page; empty for an item of a poll with `key:`. */
  url: string;
  /**
   * This automation's newest run on the item, from run history: `at` is
   * when it ended, or, while it has not, when it was made.
   */
  lastRun?: { id: string; status: RunStatus; at: string };
  /** Why it cannot be run on: "<owner/repo> is not cloned in this workspace." Absent when it can. */
  unavailable?: string;
}

/** What Run on… lists for an automation whose runs take an item. Read from memory and history only. */
export interface ItemTargets {
  takesItem: NonNullable<AutomationView['takesItem']>;
  /** It takes a pasted pull request or issue URL: its items are work items of a connection that reads URLs. */
  acceptsUrl: boolean;
  /** Its poll's last successful check, in the order the command printed it; empty for an entry without a check. */
  items: ItemTargetRow[];
  /** For an entry on work items, the Inbox's items of a type it takes; empty otherwise. */
  inbox: ItemTargetRow[];
}

/** A poll entry's check, as its automation's page shows it. */
export interface CheckView {
  /** The command, in full, as written. */
  command: string;
  /** Its interval in words: "30 minutes". */
  every: string;
  /** The `changed:` field path as written (".head"), for "when `.head` changes". */
  changed?: string;
  /** When the last check ended (ISO), and what it found: items in its result, how many fired, how many were skipped. */
  lastAt?: string;
  items?: number;
  fired?: number;
  skipped?: number;
  /** The last check recorded what was there and fired nothing. */
  baseline?: true;
  /** Why the last check failed. */
  error?: string;
  /** When the next check is due (ISO). */
  nextAt?: string;
}

/** A ready-made automation Consola ships, as the Templates tab shows it. */
export interface TemplateView {
  id: string;
  title: string;
  description: string;
  /** What it is for, as the gallery groups it: "Code review", "Housekeeping". */
  category: string;
  /** What it works with, where it listens first. The agent CLI that runs a prompt is the workspace's, not the template's. */
  services: TemplateService[];
  /** What the workspace must have for it to run, each with whether it does. */
  needs: TemplateNeed[];
  /** What this workspace lacks for it, said as what to do: it is shown dimmed. */
  missing?: string;
  /** The entry in the file that already does this, by name. */
  addedAs?: string;
  /** The entry "Add" would write for this workspace, described as the Automations tab describes one. */
  preview?: TemplatePreview;
}

/** A service a template works with. */
export type TemplateService = 'github' | 'git' | 'consola';

/** Where in Workspace settings a template's need is met. */
export type TemplateNeedSection = 'provider' | 'actions' | 'scopes';

export interface TemplateNeed {
  /** What it is: "GitHub connection". */
  label: string;
  met: boolean;
  /** What to do when it is not, and the Workspace settings section where it is done. */
  fix: { label: string; section: TemplateNeedSection };
}

/** What adding a template would put in factory.yml, in the words an `AutomationView` uses. */
export interface TemplatePreview {
  trigger: string;
  schedule?: string;
  source: AutomationView['source'];
  onEvent: boolean;
  kind: 'tool' | 'agent';
  runs: string;
  target: string;
  mode: AutomationMode;
  /** Its first scheduled run if it were added now (ISO); null when not on a schedule. */
  nextRunAt: string | null;
  /** A `steps:` template's steps in file order, as `AutomationView.steps` has them; absent for a legacy entry. */
  steps?: AutomationView['steps'];
  /** The entry exactly as "Add" writes it: one `- name: …` list item. */
  entry: string;
}

/** What saving one entry into the factory folder wrote. */
export interface SavedAutomation {
  name: string;
  /** Where it was written: `factory.yml`, or the automation file it replaced (`automations/<name>.yaml`). */
  file: string;
  /** It replaced an entry of that name rather than adding one. */
  replaced: boolean;
  /** The entry as given: one `- name: …` list item. */
  entry: string;
  /** 1-based line of the entry in its file. */
  line?: number;
  /** A poll entry it wrote: it does not check until a person allows it on its page. */
  needsAllow?: true;
  /**
   * The folder does not apply after the save, so what it wrote is not running
   * yet: what keeps it (each `<file>:<line>: <message>`, its last full stop
   * removed), and when the version that keeps running applied, in words.
   */
  notApplied?: { issues: string[]; since: string };
}

/**
 * One agent an entry's steps run as, as the version that runs has it: what
 * the Allow card shows before Allow accepts that version. While the folder
 * does not apply, that is the applied version's agent, never the live file.
 */
export interface EntryAgentView {
  name: string;
  /** `agents/<name>.md`. */
  file: string;
  description?: string;
  harnessId?: string;
  model?: string;
  maxTurns?: number;
  /** Its standing instructions, exactly as written. */
  body: string;
  /**
   * The servers it names, each narrowed to `tools` when it is. `knownTools`:
   * a whole server's tools as its harness's last settled probe listed them,
   * filled in by the host; absent when unknown (review S2).
   */
  mcpServers: Array<{ name: string; tools?: string[]; knownTools?: string[] }>;
  /** The skills it names, by folder name. */
  skills: string[];
  /**
   * Each skill it names, in `skills` order, by its `SKILL.md` as the version
   * holds it (while the folder does not apply, the running version's, never
   * the live file): the Allow card shows what it accepts (review M4). Absent
   * when it names none.
   */
  skillTexts?: Array<{ name: string; text: string }>;
}

/** An entry's agents, each once in step order, at `version`: the one Allow sends back. */
export interface EntryAgentsView {
  version: string;
  /** Its runs carry an item, text other people wrote (`entryReadsItems`): the Allow card's item line (review B3). */
  readsItems: boolean;
  agents: EntryAgentView[];
  /** The factory servers its calls use, each once in step order, as the version holds them; absent when none. */
  servers?: McpServerDefinition[];
  /** Each `uses:` step's call, in step order; absent when it has none. */
  calls?: Array<CallView & { step: string }>;
}

/** A factory folder that does not apply: the last applied version keeps running. */
export interface FactoryStanding {
  /** The banner's sentence, worded when the snapshot is built. */
  message: string;
  /** When the running version applied (ISO). */
  appliedAt: string;
  /** Entries a removal stopped at this read although the rest did not apply (recomputed at each read). */
  removed: string[];
}

/** What a run is, as the activity list groups it: an agent session, an in-process tool, or an agent's call waiting for a person. */
export type RunKind = 'agent' | 'tool' | 'request';

/**
 * A run as the activity list shows it: no approval, and its result only
 * while it waits (the Waiting card's preview). The panel reads the rest
 * with getRun.
 */
export type RunListEntry = Omit<RunRecord, 'result' | 'approval' | 'steps'> & {
  kind: RunKind;
  result?: unknown;
  /**
   * Where a steps run is: its queued or running step, else the step it
   * ended at (the failed one; for a completed run the last that ran).
   * `index` is 1-based. Absent for a legacy run and for one no step of
   * which ran. The rest of the steps are `getRun`'s.
   */
  step?: { id: string; status: StepRunStatus; index: number; count: number };
};

/** How many ended runs a snapshot carries beside every live one. */
export const SNAPSHOT_ENDED_RUNS = 200;

/** What a conversation is read from: a run's own fields, or a step's pointer and window laid over them. */
export type ConversationTarget = Pick<
  RunRecord,
  'conversation' | 'sessionId' | 'startedAt' | 'createdAt' | 'finishedAt' | 'attribution'
>;

/** One page of a workspace's history, newest first, read from main rather than pushed. */
export interface ListRunsQuery {
  /**
   * A run id: the page holds the runs strictly older in newest-first order.
   * A caller paging after the snapshot passes the oldest *ended* run it
   * shows, never the snapshot's last row, and dedupes by id: that last row
   * can be an old live run, and starting after it would skip ended runs.
   * An id that names no run of the workspace (or one the filter drops)
   * gives an empty page.
   */
  before?: string;
  /** How many runs, 1 to 200. */
  limit: number;
  query?: string;
  kind?: RunFilter;
  /** A run's `automationId`. */
  automation?: string | null;
}

export interface RunListPage {
  runs: RunListEntry[];
  /** Whether runs remain after this page. */
  hasOlder: boolean;
}

/**
 * What an agent run will start, kept on its run as `result`: shown before a
 * person approves it, and what approving sends — the prompt exactly.
 */
export interface AgentRunPreview {
  kind: 'agent-run';
  /** "Review action", "Prompt". */
  runs: string;
  /** The exact prompt the session starts with. */
  prompt: string;
  /** The item an event run is about. Title and author are the author's own text. */
  item?: { url: string; title: string; author: string; label: string };
  /** A scheduled run's scope. */
  scope?: string;
  /**
   * The seen record its item fired under (its `definition`), for a run its
   * source fired: when Consola turns the run away because its automation
   * changed, the item is given back to that record only, never to one that
   * re-baselined since (Call 12).
   */
  firedUnder?: string;
}

/** Everything a workspace's Automations panel renders, pushed as one snapshot. */
export interface AutomationsSnapshot {
  filePath: string;
  fileExists: boolean;
  automations: AutomationView[];
  /**
   * Problems with the folder's files or with individual entries, each with its
   * `file`; while the folder does not apply, everything that keeps it from
   * applying, a changed entry's harness problem included.
   */
  issues: FactorySpecIssue[];
  /**
   * What the person should know that stops nothing: a folder a later slice
   * reads, a model the harness does not list.
   */
  notices: FactoryNotice[];
  /** This workspace's runs, newest first: every live run (waiting for approval or a slot, or working) and the newest ended ones. */
  runs: RunListEntry[];
  /** Whether ended runs were left out; `listRuns` pages them. */
  hasOlder: boolean;
  /** Each queued run's place in the one line every workspace shares, 1 first. */
  queue: Record<string, number>;
  /**
   * Offer automatic reviews of pull requests assigned to the person: the
   * workspace is bound to GitHub, its file loads, and nothing in it already
   * reviews requests or assignments.
   */
  suggestAssignedReviews: boolean;
  /** The ready-made automations, with what this workspace lacks for each and which are already in the file. */
  templates: TemplateView[];
  /** Present only while the folder does not apply: the last applied version keeps running. */
  standing?: FactoryStanding;
  /** The factory's secrets, for the cards: names, where each is bound and goes; absent when it names none and binds none. */
  secrets?: SecretBindingView[];
}

/** A PR or issue, named the way the engine needs it: the provider is an opaque id here. */
export interface ItemRef {
  provider: string;
  /** "owner/name". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}

/** One inbox item as the runner reads it; `key` is the host's identity for the item. */
export interface InboxItemView {
  workItem: ItemRef;
  key: string;
  title: string;
  author: string;
  url: string;
  roles: string[];
  isDraft: boolean;
  state: string;
}

export interface ItemSnapshot {
  workspaceId: string;
  items: InboxItemView[];
  /** Epoch ms of the last successful fetch; 0 when nothing ever succeeded. */
  fetchedAt: number;
  error?: string;
}

/** A workspace action, as an automation names it. */
export interface ActionView {
  name: string;
  appliesTo: Array<'pr' | 'issue'>;
  prompt: string;
  groupId?: string;
}

export interface ScopeView {
  id: string;
  name: string;
  path: string;
}

export interface SessionView {
  id: string;
  workspaceId: string;
  name: string;
  scopeId: string;
  harnessId: string;
  claudeSessionId: string;
  cwd?: string;
  createdAt: number;
  /**
   * The automation run that started it, and for a step of a `steps:` run,
   * which step and attempt: fixed for the session's life, and the only
   * scope its step tools act in.
   */
  automation?: { name: string; runId: string; step?: { id: string; attempt: number } };
  /** The host's key for the item the session is about. */
  workItemKey?: string;
  workItemAction?: string;
  toolPolicy?: 'read-only';
}

export interface WorkspaceView {
  id: string;
  provider?: { id: string; accountLogin: string; org?: string };
  actions: ActionView[];
  scopes: ScopeView[];
  sessions: SessionView[];
}

/**
 * A step turn's `system/init`, as the host read it from the CLI: the model it
 * runs and every MCP server it loaded, with how each connected. `signInHint`
 * is the harness's words for where a server is signed in to.
 */
export interface TurnInitView {
  model?: string;
  servers: Array<{ name: string; status: string }>;
  signInHint?: string;
}

/**
 * A step turn's `result`, as the host read it from the CLI. Its text, status
 * and tool names are the CLI's own, already one line and cut short by the
 * host; the engine still cuts what it quotes.
 */
export interface TurnResultView {
  subtype: string;
  isError: boolean;
  /**
   * The CLI's cost estimate for the conversation so far, as it reported it at
   * the turn's end: a resumed turn's includes every earlier turn of its
   * conversation (Claude's does, canary row 14), so the engine records the
   * difference (`withTurnRecorded`). Absent when it reported none.
   */
  costUsd?: number;
  /** The turns this turn took: its own, a resumed one's included (canary row 14). */
  turns?: number;
  text?: string;
  apiErrorStatus?: string | number;
  /** The tools it was refused, distinct. */
  deniedTools: string[];
}

/** What a reporting turn said about itself: the host's parse of the CLI's stream. */
export interface TurnReportView {
  init?: TurnInitView;
  result?: TurnResultView;
  /** The lines that were not JSON, the last 200. */
  otherLines: string[];
  /** The cap this launch ran with, as the host launched it. */
  maxTurns?: number;
  /** The CLI's own `system/init` and `result` objects, for turn.json. */
  raw: { init?: unknown; result?: unknown };
}

/** How an unattended turn's process ended, as the host reports it; `report` when the turn reported itself. */
export interface TurnOutcome {
  exitCode: number;
  lastLine?: string;
  stopped?: string;
  report?: TurnReportView;
}

/** One reporting turn, as `turn.json` keeps it. */
export interface StepTurnFile {
  endedAt: string;
  exitCode: number;
  stopped?: string;
  maxTurns?: number;
  init?: unknown;
  result?: unknown;
  otherLines: string[];
}

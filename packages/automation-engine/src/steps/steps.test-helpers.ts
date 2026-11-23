import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onTestFinished } from 'vitest';
import {
  appendAutomationEntry,
  AUTOMATION_NAME_PATTERN,
  automationEntryText,
  factoryFilesOf,
  LATER_FOLDERS,
  replaceAutomationEntry,
} from '@consola/factory-spec';
import {
  AutomationService,
  type AutomationNotice,
  type AutomationServiceDeps,
} from '../AutomationService';
import { itemKey } from '../inboxItems.test-helpers';
import { RunFolder } from '../node/runFolder';
import type {
  AgentHarnessAnswer,
  AgentHarnessQuery,
  AgentLaunchRequest,
  AppliedFactory,
  AppliedFactoryStore,
  CommandResult,
  CommandSpec,
  FactoryFolderHandle,
  RunningCommand,
  WorkItemPort,
} from '../ports';
import { RunStore, type AutomationStateFile } from '../RunStore';
import { memoryHistory } from '../runHistory.test-helpers';
import { StartedByHandError } from '../support';
import { FakeToolRegistry, type TestTool } from '../tools.test-helpers';
import type {
  InboxItemView,
  ItemRef,
  ItemSnapshot,
  SessionView,
  TurnOutcome,
  TurnReportView,
  TurnResultView,
  WorkspaceView,
} from '../views';
import type { CheckoutRequest } from './checkout';
import {
  runOwnedDirName,
  type RunCheckoutPort,
  type SettleResult,
  type StepProcesses,
} from './runCheckout';
import { maskSecrets } from './commandIO';
import type { StepToolAnswer } from './stepTools';

/*
 * The one harness every steps test runs through: a real `AutomationService`
 * over a memory `RunStore` and a disk `RunFolder` in a temp root (removed when
 * the test finishes), and a fake host whose every dependency records each call
 * in `world`. A task that adds a dependency adds its fake to `deps` below and
 * what it records to `StepsWorld`; nothing else changes, so earlier tests keep
 * working as written. `relaunch` quits the service and starts another over the
 * same state, history, run folder, files, clock and world, as reopening
 * Consola would. ws-1's factory folder is held in memory, file by file
 * (`factory.yml`, `automations/<name>.yaml`, `agents/<name>.md`), and so is
 * the applied version of each folder (`memoryAppliedStore`).
 */

export const WORKSPACE_ID = 'ws-1';

/** The Review action's body: what an action step on a pull request runs. */
export const REVIEW_BODY = 'Review {{title}} and say what should change before it merges.';
export const TRIAGE_BODY = 'Triage {{title}}: say what it needs and who should look at it.';

/** The commit every fake preparation reports, unless a test sets another. */
export const CHECKOUT_HEAD = '5f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a';

/** Where the fake host keeps an item's automation checkout: `/worktrees/catalog-portal-pr-51-automation`. */
export function checkoutPathFor(workItem: ItemRef): string {
  return `/worktrees/${workItem.repo.split('/')[1]}-${workItem.type}-${workItem.number}-automation`;
}

/**
 * A TurnReportView from flat fields, as the desktop would hand it over. A result is made
 * (subtype `success`, `isError` false, `deniedTools` []) unless `noResult`; an init is made
 * (`{ model, servers: [] }`) when `model` is given; `raw` holds CLI-shaped objects built from
 * the same fields (`{ type: 'system', subtype: 'init', model }`, `{ type: 'result', subtype,
 * is_error, total_cost_usd, num_turns, result }`), so turn.json assertions have something to match.
 */
export function turnReport(
  fields: {
    subtype?: string;
    isError?: boolean;
    cost?: number;
    turns?: number;
    text?: string;
    model?: string;
    deniedTools?: string[];
    maxTurns?: number;
    otherLines?: string[];
    noResult?: boolean;
  } = {},
): TurnReportView {
  const { subtype = 'success', isError = false, cost, turns, text, model } = fields;
  const result: TurnResultView | undefined = fields.noResult
    ? undefined
    : {
        subtype,
        isError,
        deniedTools: fields.deniedTools ?? [],
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(turns !== undefined ? { turns } : {}),
        ...(text !== undefined ? { text } : {}),
      };
  return {
    ...(model !== undefined ? { init: { model, servers: [] } } : {}),
    ...(result ? { result } : {}),
    otherLines: fields.otherLines ?? [],
    ...(fields.maxTurns !== undefined ? { maxTurns: fields.maxTurns } : {}),
    raw: {
      ...(model !== undefined ? { init: { type: 'system', subtype: 'init', model } } : {}),
      ...(result
        ? {
            result: {
              type: 'result',
              subtype,
              is_error: isError,
              ...(cost !== undefined ? { total_cost_usd: cost } : {}),
              ...(turns !== undefined ? { num_turns: turns } : {}),
              ...(text !== undefined ? { result: text } : {}),
            },
          }
        : {}),
    },
  };
}

/** The base environment the fake host gives every command: the login env and the bound account's token. */
export const COMMAND_ENV = { env: { PATH: '/bin', GH_TOKEN: 'gho_stub' }, secrets: ['gho_stub'] };

/** One command the engine started, held until the test ends it. */
export interface FakeCommand {
  spec: CommandSpec;
  /**
   * It wrote `outputs` to its `$CONSOLA_OUTPUT` and its logs (masked, as
   * the executor masks them), then ended as `result` says: exit 0 unless
   * told. Then whatever that set going.
   */
  end(how?: {
    outputs?: string;
    stdout?: string;
    stderr?: string;
    result?: Partial<CommandResult>;
  }): Promise<void>;
  /** Its result rejects, as the executor's does when the shell never started. */
  neverStarted(error: unknown): Promise<void>;
  /** How many times it was asked to stop. */
  stops: number;
  /** It was ended, or its result rejected: `end` or `neverStarted` was called. */
  ended: boolean;
}

export interface StepsHarnessOptions {
  /** ws-1's factory.yml; without one, the workspace has no file. */
  yaml?: string;
  /**
   * ws-1's other factory files, by path in the folder: `automations/<name>.yaml`,
   * `agents/<name>.md`, `skills/<name>/<path>` (read as its UTF-8 bytes); a file
   * under `environments/`, `connections/` or `evals/` makes that folder exist.
   */
  files?: Record<string, string>;
  /** The harnesses an agent may name, by id, as the agent check answers for each. Default: none. */
  agentHarnesses?: StepsWorld['agentHarnesses'];
  /** Where each folder's applied version is kept; it outlives `relaunch`. Default: a new, empty one. */
  appliedStore?: MemoryAppliedStore;
  /** What `process.platform` would say on the host. Default `darwin`. */
  platform?: NodeJS.Platform;
  /** The default harness, as the agent check sees it. Default: Claude, able to run read-only and steps. */
  harness?: StepsWorld['harness'];
  /** Local wall-clock start. */
  now?: Date;
  /** Agent sessions automations may have working at once; `world.maxConcurrentAgents` changes it later. Default: the engine's. */
  maxConcurrentAgents?: number;
  /** Commands automations may have running at once; `world.maxConcurrentCommands` changes it later. Default: the engine's. */
  maxConcurrentCommands?: number;
  /** Tools the registry offers; none by default. */
  tools?: TestTool[];
  /** The host's work items. Default: a host that reads no work item URL. */
  workItems?: WorkItemPort;
  /** Every declared retry's wait, as the host may set it (Call 7). Default: the engine's backoff. */
  retryBackoffMs?: number;
  /**
   * The host makes runs' own checkouts (slice 3-B): the fake `RunCheckoutPort`
   * (`world.runCheckouts`). Default: none, as a host without one; every
   * existing test runs without it.
   */
  runCheckouts?: boolean;
  /**
   * The host's launch holds an agent that writes to its environment (the
   * service's `writeAgents`, slice 3-B Call 2). Default: as `runCheckouts`,
   * so `{ runCheckouts: true, writeAgents: false }` is a host with the port
   * that cannot launch a write agent.
   */
  writeAgents?: boolean;
}

/** One call the fake `RunCheckoutPort` was asked, by its name. */
export type RunCheckoutCall =
  | { make: Parameters<RunCheckoutPort['make']>[0] }
  | { settle: Parameters<RunCheckoutPort['settle']>[0] }
  | { settleBetween: Parameters<RunCheckoutPort['settleBetween']>[0] }
  | { reset: { dir: string; before: string; branch?: string } }
  | { changes: { dir: string; base: string; head: string; maxBytes: number } }
  | { showAt: { dir: string; commit: string; path: string; maxBytes: number } }
  | { endStepProcesses: { dir: string; sessionId?: string } };

/** What the fake host holds and recorded. A test edits the first part to move the world, then resyncs. */
export interface StepsWorld {
  /** ws-1, "Sprocket". Edit its actions, scopes or provider, then `service.syncWorkspaces()`. */
  workspace: WorkspaceView & { name: string };
  /** ws-1 was deleted: the host no longer lists it. Set it, then `service.syncWorkspaces()`. */
  workspaceDeleted: boolean;
  /** `stepProblem`: its extra arguments override what a step's turn is launched with. */
  harness: { name: string; problem: string | null; stepProblem?: string | null };
  /**
   * The answer for an agent naming each harness, by id; an agent naming one
   * not here gets the host's unknown-harness words, and one naming none gets
   * `harness`. An entry may be a function of the query, to answer per agent
   * and per checkout kind. Edit it, then `service.syncWorkspaces()`.
   */
  agentHarnesses: Record<
    string,
    AgentHarnessAnswer | ((query: AgentHarnessQuery) => AgentHarnessAnswer)
  >;
  /** Every agent check asked, in order: an agent's query, or undefined for the default harness. */
  harnessQueries: Array<AgentHarnessQuery | undefined>;
  /** How many times ws-1's folder was read. */
  folderReads: number;
  /** Every read of a folder waits for this while it is set, after counting the read. */
  folderReadGate?: Promise<void>;
  /** Every read of a folder throws this while it is set, after counting the read. */
  folderReadThrows?: unknown;
  /** What each folder's `watch` was handed, by workspace id: call one to fire it, as a change on disk would. */
  watchers: Map<string, () => void>;
  /** ws-1's paths the adapter would find linking outside the folder (`FactoryFiles.outside`); none by default. */
  outsidePaths: string[];
  /** The host's harness records, as `listHarnesses` lists them, each with the servers its last probe listed. Default: none. */
  harnessRecords: Array<{
    id: string;
    name: string;
    enabled: boolean;
    archived: boolean;
    servers?: string[];
  }>;
  /** Each workspace's latest Inbox snapshot, as `inboxSnapshot` returns it. */
  inbox: Map<string, ItemSnapshot>;
  /** Sessions a pane has a live terminal for: a person opened them. */
  liveTerminals: Set<string>;
  /** The cap the service reads, read at every look: undefined is the engine's default. */
  maxConcurrentAgents?: number;
  /** The command lane's cap, read the same way. */
  maxConcurrentCommands?: number;
  /** What `commandEnv` resolves with: `COMMAND_ENV` unless a test sets another. */
  commandEnv: { env: NodeJS.ProcessEnv; secrets: string[] };
  /** `commandEnv` rejects with this while it is set: a token that cannot be borrowed. */
  commandEnvThrows?: unknown;
  /** `commandEnv` waits for this while it is set, after recording the call. */
  commandEnvGate?: Promise<void>;
  /** The workspace of every `commandEnv` asked for, in order. */
  commandEnvAsked: string[];
  /** Every command started, in order. */
  commands: FakeCommand[];
  /** Called inside the fake `start`, before it returns: nothing has run yet. */
  onCommand?: (spec: CommandSpec) => void;
  /** Folders a running session works in, as `checkoutBusy` answers. */
  busyFolders: Set<string>;
  /** Working folders that are gone from disk, as `folderExists` answers. */
  goneFolders: Set<string>;
  /** The automation checkout: every `prepare` asked for, the head it reports, and how the next one ends. */
  checkouts: {
    prepared: CheckoutRequest[];
    head: string;
    /** Every `prepare` throws this while it is set. */
    fails?: unknown;
    /** Every `prepare` waits for this while it is set. */
    gate?: Promise<void>;
  };
  /** Every launch throws this while it is set, after recording the request. */
  launchThrows?: unknown;
  /** Every launch waits for this while it is set, after recording the request and before its session exists. */
  launchGate?: Promise<void>;
  /** Every resume waits for this while it is set, after recording the call. */
  resumeGate?: Promise<void>;
  /** Every resume throws this while it is set, after recording the call. */
  resumeThrows?: unknown;
  /**
   * While set, a launch that asks after a review by hand (`startedByHandSince`)
   * refuses with `StartedByHandError` when the workspace has one, as the desktop's does.
   */
  byHandRefuses?: boolean;
  /** Every reminder waits for this while it is set, after recording the call. */
  remindGate?: Promise<void>;
  /** While set, `stopAgent` records the call and finds no turn running: it returns false. */
  noTurnToStop?: boolean;
  /** Every broadcast throws this while it is set. */
  broadcastThrows?: unknown;
  /**
   * The fake `RunCheckoutPort` (with `runCheckouts: true`): every call but
   * `folderProblem`'s, in order; each `folderProblem` asked, by folder, apart
   * (review NB1), so a row that pins `calls` stays as written; the base a
   * `make` answers; what the next `make` throws; the answers `settle`,
   * `settleBetween` and `showAt` give, in order (each then its default).
   */
  runCheckouts: {
    calls: RunCheckoutCall[];
    folderChecks: string[];
    base: string;
    makeFails?: unknown;
    /** Every `make` waits for this while it is set, after recording the call. */
    makeGate?: Promise<void>;
    settleAnswers: SettleResult[];
    betweenAnswers: Array<SettleResult | null>;
    /** Every `settleBetween` waits for this while it is set, after recording the call. */
    betweenGate?: Promise<void>;
    showAnswers: Array<
      { ok: true; text: string } | { ok: false; reason: 'missing' | 'not-a-file' | 'too-large' }
    >;
  };
  /** While set, every command the engine starts says its process group ends when this resolves (`RunningCommand.ended`). */
  commandGroupEnded?: Promise<void>;
  /** What the port's `endStepProcesses` answers (default: clear), after `gate` while it is set. */
  processes: { end: StepProcesses; gate?: Promise<void> };
  /** The session the port's `holder` names for a folder, by folder. */
  holders: Map<string, { sessionId: string; name: string }>;
  /** What the port's `folderProblem` answers. Default: none. */
  folderProblem: (dir: string) => string | null;
  /** Whether a repository is cloned in a workspace, as `repoCloned` answers. Default: yes. */
  repoCloned: (workspaceId: string, repo: string) => boolean;
  /** Called inside the fake launch, once its session is on the workspace's record and before it resolves. */
  onLaunch?: (request: AgentLaunchRequest, session: SessionView) => void;
  /** A session's unattended turn ended, as the desktop reports it; then whatever that set going. Exit 0 unless told. */
  endTurn(sessionId: string, outcome?: TurnOutcome): Promise<void>;
  /** A step session's `consola_set_outputs`, through the service's step tools. */
  setOutputs(sessionId: string, values: Record<string, unknown>): StepToolAnswer;
  /** A step session's `consola_write_artifact`, through the service's step tools. */
  writeArtifact(sessionId: string, name: string, content: string): StepToolAnswer;

  launches: AgentLaunchRequest[];
  resumes: Array<{ sessionId: string; prompt: string }>;
  /** The cap each resume was asked for with (undefined: the record's own), in the same order. */
  resumeCaps: Array<number | undefined>;
  /** Every reminder turn asked for, in order. */
  reminders: Array<{ sessionId: string; prompt: string }>;
  /** The cap each reminder turn was asked for with, in the same order. */
  reminderCaps: number[];
  /** Every reminder throws this while it is set, after recording the call. */
  remindThrows?: unknown;
  stops: Array<{ sessionId: string; reason: string }>;
  refreshes: string[];
  /** The workspace id of every snapshot broadcast, in order. */
  broadcasts: string[];
}

export interface StepsHarness {
  service: AutomationService;
  store: RunStore;
  /** The run logs the store writes: one appended line per recorded change. */
  history: ReturnType<typeof memoryHistory>;
  folder: RunFolder;
  world: StepsWorld;
  notices: AutomationNotice[];
  /** For each notice, in the same order, how many lines history had appended when it was pushed (review S5). */
  noticeAppends: number[];
  /** Replace ws-1's factory.yml and reload it, as the file watcher would. */
  setYaml(yaml: string): Promise<void>;
  /** Each folder's applied version, as the service kept it: the same store across relaunches. */
  appliedStore: MemoryAppliedStore;
  /** Write one of ws-1's factory files (null deletes it), then reload, as the watcher would. */
  writeFile(relative: string, text: string | null): Promise<void>;
  /** ws-1's factory files as they are now, by path in the folder. */
  texts(): Map<string, string>;
  /** A successful Inbox fetch of ws-1 holding `items`, as main hands it over, then whatever it set going. */
  poll(items: InboxItemView[]): Promise<void>;
  /** Quit, then start a new service over the same state, history, run folder, files, clock and world. */
  relaunch(): Promise<StepsHarness>;
  /** Flip one byte of the run's copy of a skill's `SKILL.md`, on disk: an editor or a disk error, between attempts. */
  corruptSkill(workspaceId: string, runId: string, name: string): void;
  /** A scheduler tick, then whatever it set going. */
  tick(): Promise<void>;
  /** Let queued promise chains (launches awaited one after another) settle. */
  flush(): Promise<void>;
  now(): Date;
  advance(ms: number): void;
}

/**
 * The skill files among a folder's texts (`skills/<name>/<path>`), each
 * skill's by its path inside the skill's folder, as UTF-8 bytes: what the
 * folder's adapter hands `parseFactory` as `FactoryFiles.skills`.
 */
export function skillFilesOf(
  texts: ReadonlyMap<string, string>,
): Record<string, Array<{ path: string; bytes: Uint8Array }>> {
  const skills: Record<string, Array<{ path: string; bytes: Uint8Array }>> = {};
  for (const [relative, text] of texts) {
    const found = /^skills\/([^/]+)\/(.+)$/.exec(relative);
    if (!found) continue;
    const [, name, inside] = found;
    if (!Object.prototype.hasOwnProperty.call(skills, name)) skills[name] = [];
    skills[name].push({ path: inside, bytes: new TextEncoder().encode(text) });
  }
  return skills;
}

/** An applied-version store held in memory, copied on the way in and out as a file would be. */
export interface MemoryAppliedStore extends AppliedFactoryStore {
  /** What it holds, by folder. */
  records: Map<string, AppliedFactory>;
  /** How many reads and writes it was asked for. */
  reads: number;
  writes: number;
  /** Every folder `forget` was asked for, in order. */
  forgotten: string[];
  /** While set, `read` returns null whatever it holds: a damaged file, logged and moved aside. */
  damaged: boolean;
  /** While set, `read` throws it: a store that cannot say. */
  readThrows?: unknown;
  /** While set, `write` throws it, after counting the call, and keeps nothing. */
  writeThrows?: unknown;
}

export function memoryAppliedStore(): MemoryAppliedStore {
  const store: MemoryAppliedStore = {
    records: new Map(),
    reads: 0,
    writes: 0,
    forgotten: [],
    damaged: false,
    read(folder) {
      store.reads++;
      if (store.readThrows) throw store.readThrows;
      const record = store.records.get(folder);
      return record && !store.damaged ? structuredClone(record) : null;
    },
    write(applied) {
      store.writes++;
      if (store.writeThrows) throw store.writeThrows;
      store.records.set(applied.folder, structuredClone(applied));
    },
    forget(folder) {
      store.forgotten.push(folder);
      store.records.delete(folder);
    },
  };
  return store;
}

/** A state file held in memory, copied on write as a real one would be. */
function memoryStateFile() {
  let stored: AutomationStateFile | null = null;
  return {
    read: () => stored,
    write: (value: AutomationStateFile) => {
      stored = JSON.parse(JSON.stringify(value));
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
}

/** Sprocket: two scopes, GitHub bound as JaviDev, and the two actions every steps test names. */
function sprocket(): StepsWorld['workspace'] {
  return {
    id: WORKSPACE_ID,
    name: 'Sprocket',
    provider: { id: 'github', accountLogin: 'JaviDev' },
    actions: [
      { name: 'Review', appliesTo: ['pr'], prompt: REVIEW_BODY, groupId: 'g-1' },
      { name: 'Triage', appliesTo: ['issue'], prompt: TRIAGE_BODY },
    ],
    scopes: [
      { id: 'scope-catalog-portal', name: 'catalog-portal', path: '/code/catalog-portal' },
      { id: 'scope-api', name: 'api', path: '/code/api' },
    ],
    sessions: [],
  };
}

/** A started service over Sprocket. Call it inside a test: its run folder goes when the test ends. */
export async function stepsHarness(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const {
    yaml,
    platform = 'darwin',
    harness = { name: 'Claude', problem: null },
    now = new Date(2026, 10, 16, 8, 0),
  } = options;
  let clock = now;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-harness-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  // The service now running: `relaunch` replaces it, and the world's step calls follow.
  let current: AutomationService;

  const world: StepsWorld = {
    workspace: sprocket(),
    workspaceDeleted: false,
    harness,
    agentHarnesses: { ...options.agentHarnesses },
    harnessQueries: [],
    folderReads: 0,
    watchers: new Map(),
    outsidePaths: [],
    harnessRecords: [],
    inbox: new Map(),
    liveTerminals: new Set(),
    maxConcurrentAgents: options.maxConcurrentAgents,
    maxConcurrentCommands: options.maxConcurrentCommands,
    commandEnv: structuredClone(COMMAND_ENV),
    commandEnvAsked: [],
    commands: [],
    busyFolders: new Set(),
    goneFolders: new Set(),
    checkouts: { prepared: [], head: CHECKOUT_HEAD },
    runCheckouts: {
      calls: [],
      folderChecks: [],
      base: 'b0',
      settleAnswers: [],
      betweenAnswers: [],
      showAnswers: [],
    },
    processes: { end: { kind: 'clear' } },
    holders: new Map(),
    folderProblem: () => null,
    repoCloned: () => true,
    async endTurn(sessionId, outcome = { exitCode: 0 }) {
      current.turnEnded(sessionId, outcome);
      await flush();
    },
    setOutputs: (sessionId, values) => current.stepIO().setOutputs(sessionId, values),
    writeArtifact: (sessionId, name, content) =>
      current.stepIO().writeArtifact(sessionId, name, content),
    launches: [],
    resumes: [],
    resumeCaps: [],
    reminders: [],
    reminderCaps: [],
    stops: [],
    refreshes: [],
    broadcasts: [],
  };
  const notices: AutomationNotice[] = [];
  const noticeAppends: number[] = [];
  // ws-1's factory folder, file by file; every other workspace's is empty.
  const folders = new Map<string, Map<string, string>>([
    [
      WORKSPACE_ID,
      new Map([
        ...(yaml === undefined ? [] : ([['factory.yml', yaml]] as Array<[string, string]>)),
        ...Object.entries(options.files ?? {}),
      ]),
    ],
  ]);
  // What outlives a quit: the state file, the run logs and the run folder.
  const stateFile = memoryStateFile();
  const history = memoryHistory();
  const appliedStore = options.appliedStore ?? memoryAppliedStore();
  const folder = new RunFolder((workspaceId) => path.join(root, workspaceId));
  let id = 0;

  const filesOf = (workspaceId: string): Map<string, string> => {
    let files = folders.get(workspaceId);
    if (!files) {
      files = new Map();
      folders.set(workspaceId, files);
    }
    return files;
  };
  // The folder as `FactoryFolder` keeps it, in memory: no strays; skill files as their UTF-8 bytes.
  const folderFor = (workspaceId: string): FactoryFolderHandle => {
    const folderPath = `/home/me/.consola/workspaces/${workspaceId}`;
    const filePath = `${folderPath}/factory.yml`;
    const files = () => filesOf(workspaceId);
    // As the adapter's: a name that is no name is never a path.
    const automationFile = (name: string) => {
      if (!AUTOMATION_NAME_PATTERN.test(name))
        throw new Error(`Not an automation name: ${JSON.stringify(name)}.`);
      return `automations/${name}.yaml`;
    };
    return {
      folderPath,
      filePath,
      read: async () => {
        if (workspaceId === WORKSPACE_ID) world.folderReads++;
        if (world.folderReadGate) await world.folderReadGate;
        if (world.folderReadThrows) throw world.folderReadThrows;
        const paths = [...files().keys()];
        return {
          exists: files().has('factory.yml'),
          files: {
            ...factoryFilesOf(Object.fromEntries(files()), skillFilesOf(files())),
            laterFolders: Object.keys(LATER_FOLDERS).filter((folder) =>
              paths.some((relative) => relative.startsWith(`${folder}/`)),
            ),
            outside: workspaceId === WORKSPACE_ID ? [...world.outsidePaths] : [],
          },
        };
      },
      watch: (onChange) => {
        world.watchers.set(workspaceId, onChange);
      },
      unwatch: () => {
        world.watchers.delete(workspaceId);
      },
      ensureExists: async (template) => {
        if (!files().has('factory.yml')) files().set('factory.yml', template);
        return filePath;
      },
      appendAutomation: async (entryYaml) => {
        files().set('factory.yml', appendAutomationEntry(files().get('factory.yml')!, entryYaml));
      },
      replaceAutomation: async (name, entryYaml) => {
        const text = files().get('factory.yml')!;
        files().set('factory.yml', replaceAutomationEntry(text, name, entryYaml));
      },
      writeAutomationFile: async (name, text) => {
        files().set(automationFile(name), text);
      },
      whereIs: async (name) => {
        const text = files().get('factory.yml');
        if (text !== undefined && automationEntryText(text, name) !== null) return 'factory.yml';
        return files().has(`automations/${name}.yaml`) ? 'file' : null;
      },
      readText: async () => files().get('factory.yml') ?? null,
      readAutomationFile: async (name) => files().get(automationFile(name)) ?? null,
      // As the adapter's: only the folder's own files, never another path.
      pathOf: (relative) => {
        const named = (name: string | undefined) =>
          name !== undefined && AUTOMATION_NAME_PATTERN.test(name);
        const own =
          relative === 'factory.yml' ||
          named(/^automations\/([^/]+)\.yaml$/.exec(relative)?.[1]) ||
          named(/^agents\/([^/]+)\.md$/.exec(relative)?.[1]) ||
          named(/^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1]);
        return own ? `${folderPath}/${relative}` : null;
      },
    };
  };

  // Like the executor: its logs exist from the start, and what it prints reaches them masked.
  const startFakeCommand = (spec: CommandSpec): RunningCommand => {
    for (const log of [spec.stdoutPath, spec.stderrPath]) {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, '');
    }
    let settle!: { resolve: (result: CommandResult) => void; reject: (error: unknown) => void };
    const result = new Promise<CommandResult>((resolve, reject) => (settle = { resolve, reject }));
    const command: FakeCommand = {
      spec,
      stops: 0,
      ended: false,
      async end({ outputs, stdout = '', stderr = '', result: ending = {} } = {}) {
        command.ended = true;
        if (outputs !== undefined) fs.appendFileSync(String(spec.env.CONSOLA_OUTPUT), outputs);
        fs.appendFileSync(spec.stdoutPath, maskSecrets(stdout, spec.secrets));
        fs.appendFileSync(spec.stderrPath, maskSecrets(stderr, spec.secrets));
        settle.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stopped: false,
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
          truncated: false,
          ...ending,
        });
        await flush();
      },
      async neverStarted(error) {
        command.ended = true;
        settle.reject(error);
        await flush();
      },
    };
    world.commands.push(command);
    world.onCommand?.(spec);
    return {
      pid: 4242,
      result,
      ...(world.commandGroupEnded ? { ended: world.commandGroupEnded } : {}),
      stop: () => {
        command.stops++;
      },
    };
  };

  const registry = new FakeToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);

  const deps = (store: RunStore): AutomationServiceDeps => ({
    folderFor,
    appliedStore,
    store,
    runFolder: folder,
    workItems: options.workItems ?? {
      canParseUrls: () => false,
      parseUrl: () => null,
      keyOf: (ref) => `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`,
      urlOf: (ref) => `https://example.test/${ref.repo}/${ref.type}/${ref.number}`,
      inWorkspace: () => true,
      repoCloned: (workspaceId, repo) => world.repoCloned(workspaceId, repo),
    },
    registry,
    getWorkspaces: () => (world.workspaceDeleted ? [] : [world.workspace]),
    now: () => clock,
    newId: () => `run-${++id}`,
    notify: (notice) => {
      notices.push(notice);
      noticeAppends.push(history.appends.length);
    },
    broadcast: (workspaceId) => {
      if (world.broadcastThrows) throw world.broadcastThrows;
      world.broadcasts.push(workspaceId);
    },
    every: () => () => {},
    ...(options.retryBackoffMs !== undefined ? { retryBackoffMs: options.retryBackoffMs } : {}),
    inboxSnapshot: (workspaceId) => world.inbox.get(workspaceId) ?? null,
    refreshInbox: async (workspaceId) => {
      world.refreshes.push(workspaceId);
    },
    // Like the desktop: the session is on the workspace's record by the time the launch resolves.
    launchAgent: async (request) => {
      world.launches.push(request);
      if (world.launchGate) await world.launchGate;
      if (world.launchThrows) throw world.launchThrows;
      const since = request.item?.startedByHandSince;
      if (world.byHandRefuses && request.item && since !== undefined) {
        const key = itemKey(request.item.workItem);
        const label = request.item.label;
        const byHand = world.workspace.sessions.find(
          (session) =>
            !session.automation &&
            session.workItemKey === key &&
            session.workItemAction === label &&
            session.createdAt > Date.parse(since),
        );
        if (byHand) throw new StartedByHandError(byHand.name);
      }
      const { step } = request;
      const session: SessionView = {
        id: `session-${world.launches.length}`,
        workspaceId: request.workspaceId,
        name: step?.name ?? request.item?.title ?? request.run.automation,
        scopeId: step?.scopeId ?? request.scopeId ?? 'scope-catalog-portal',
        harnessId: 'claude',
        claudeSessionId: `claude-${world.launches.length}`,
        ...(step ? { cwd: step.cwd } : {}),
        createdAt: clock.getTime(),
        automation: {
          name: request.run.automation,
          runId: request.run.id,
          ...(step ? { step: { id: step.id, attempt: step.attempt } } : {}),
        },
        ...(request.item ? { workItemAction: request.item.label } : {}),
        toolPolicy: 'read-only',
      };
      world.workspace.sessions.push(session);
      world.onLaunch?.(request, session);
      return session;
    },
    resumeAgent: async (session, prompt, maxTurns) => {
      world.resumes.push({ sessionId: session.id, prompt });
      world.resumeCaps.push(maxTurns);
      if (world.resumeGate) await world.resumeGate;
      if (world.resumeThrows) throw world.resumeThrows;
    },
    remindAgent: async (session, prompt, maxTurns) => {
      world.reminders.push({ sessionId: session.id, prompt });
      world.reminderCaps.push(maxTurns);
      if (world.remindGate) await world.remindGate;
      if (world.remindThrows) throw world.remindThrows;
    },
    hasLiveTerminal: (session) => world.liveTerminals.has(session.id),
    agentHarness: (_workspaceId, agent) => {
      world.harnessQueries.push(agent);
      const id = agent?.harnessId;
      if (id === undefined) return world.harness;
      if (Object.prototype.hasOwnProperty.call(world.agentHarnesses, id)) {
        const answer = world.agentHarnesses[id];
        return typeof answer === 'function' ? answer(agent!) : answer;
      }
      return {
        name: id,
        problem: null,
        stepProblem: null,
        agentProblem: `\`${id}\` is not one of Consola's harnesses: add it in Settings › Harnesses, or change \`harness:\``,
        warning: null,
      };
    },
    listHarnesses: () => world.harnessRecords,
    stopAgent: (session, reason) => {
      world.stops.push({ sessionId: session.id, reason });
      return !world.noTurnToStop;
    },
    get maxConcurrentAgents() {
      return world.maxConcurrentAgents;
    },
    get maxConcurrentCommands() {
      return world.maxConcurrentCommands;
    },
    commandEnv: async (workspaceId) => {
      world.commandEnvAsked.push(workspaceId);
      if (world.commandEnvGate) await world.commandEnvGate;
      if (world.commandEnvThrows) throw world.commandEnvThrows;
      return structuredClone(world.commandEnv);
    },
    commands: { start: startFakeCommand },
    platform,
    checkout: {
      pathFor: (_workspaceId, workItem) => checkoutPathFor(workItem),
      prepare: async (request) => {
        world.checkouts.prepared.push(request);
        if (world.checkouts.gate) await world.checkouts.gate;
        if (world.checkouts.fails) throw world.checkouts.fails;
        return {
          cwd: checkoutPathFor(request.workItem),
          scopeId: 'scope-catalog-portal',
          head: world.checkouts.head,
        };
      },
    },
    checkoutBusy: (dir) => world.busyFolders.has(dir),
    folderExists: (dir) => !world.goneFolders.has(dir),
    ...(options.runCheckouts ? { runCheckout: fakeRunCheckout(world) } : {}),
    ...((options.writeAgents ?? options.runCheckouts) ? { writeAgents: true as const } : {}),
  });

  const launch = async (): Promise<StepsHarness> => {
    const store = new RunStore(stateFile, history);
    const service = new AutomationService(deps(store));
    current = service;
    await service.start();

    return {
      service,
      store,
      history,
      folder,
      world,
      notices,
      noticeAppends,
      async setYaml(next) {
        filesOf(WORKSPACE_ID).set('factory.yml', next);
        await service.reload(WORKSPACE_ID);
      },
      async writeFile(relative, text) {
        if (text === null) filesOf(WORKSPACE_ID).delete(relative);
        else filesOf(WORKSPACE_ID).set(relative, text);
        await service.reload(WORKSPACE_ID);
      },
      texts: () => filesOf(WORKSPACE_ID),
      appliedStore,
      async poll(items) {
        const snapshot: ItemSnapshot = {
          workspaceId: WORKSPACE_ID,
          items,
          fetchedAt: clock.getTime(),
        };
        world.inbox.set(WORKSPACE_ID, snapshot);
        service.observeInbox(snapshot);
        await flush();
      },
      async relaunch() {
        service.shutdown();
        return launch();
      },
      corruptSkill(workspaceId, runId, name) {
        const file = path.join(folder.skillsDir(workspaceId, runId), name, 'SKILL.md');
        const bytes = fs.readFileSync(file);
        bytes[bytes.length - 1] ^= 0x01;
        fs.writeFileSync(file, bytes);
      },
      async tick() {
        await service.tick();
        await flush();
      },
      flush,
      now: () => clock,
      advance(ms) {
        clock = new Date(clock.getTime() + ms);
      },
    };
  };
  return launch();
}

/** A run's own checkout folder, as the fake port places it. */
export const runCheckoutPathFor = (runId: string, repo: string) =>
  `/w/${runOwnedDirName(repo, runId)}`;

/** The fake `RunCheckoutPort`: it records every call and answers from the world. */
function fakeRunCheckout(world: StepsWorld): RunCheckoutPort {
  const { runCheckouts } = world;
  return {
    pathFor: runCheckoutPathFor,
    make: async (request) => {
      runCheckouts.calls.push({ make: request });
      if (runCheckouts.makeGate) await runCheckouts.makeGate;
      if (runCheckouts.makeFails) throw runCheckouts.makeFails;
      return {
        cwd: runCheckoutPathFor(request.runId, request.repo),
        scopeId: 'scope-catalog-portal',
        base: runCheckouts.base,
      };
    },
    settle: async (request) => {
      runCheckouts.calls.push({ settle: request });
      return runCheckouts.settleAnswers.shift() ?? { ok: true, after: 'c1', files: 2, flagged: [] };
    },
    settleBetween: async (request) => {
      runCheckouts.calls.push({ settleBetween: request });
      if (runCheckouts.betweenGate) await runCheckouts.betweenGate;
      return runCheckouts.betweenAnswers.length > 0 ? runCheckouts.betweenAnswers.shift()! : null;
    },
    reset: async (dir, before, branch) => {
      runCheckouts.calls.push({
        reset: { dir, before, ...(branch !== undefined ? { branch } : {}) },
      });
    },
    changes: async (dir, base, head, maxBytes) => {
      runCheckouts.calls.push({ changes: { dir, base, head, maxBytes } });
      return { text: '', truncated: false, bytes: 0 };
    },
    showAt: async (dir, commit, path, maxBytes) => {
      runCheckouts.calls.push({ showAt: { dir, commit, path, maxBytes } });
      return runCheckouts.showAnswers.shift() ?? { ok: false, reason: 'missing' };
    },
    folderProblem: (dir) => {
      runCheckouts.folderChecks.push(dir);
      return world.folderProblem(dir);
    },
    endStepProcesses: async (request) => {
      runCheckouts.calls.push({ endStepProcesses: request });
      if (world.processes.gate) await world.processes.gate;
      return world.processes.end;
    },
    holder: (dir) => world.holders.get(dir) ?? null,
  };
}

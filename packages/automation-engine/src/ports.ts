/**
 * What a host supplies to the engine. The host's full contract is this file
 * plus `AutomationServiceDeps` in `AutomationService.ts`.
 */
import type { FactoryFiles, RunRecord } from '@consola/factory-spec';
import type { ItemRef, SessionView, StepTurnFile } from './views';
import type { RunDefinition } from './steps/definition';

/** One persisted JSON document, read and written whole. The engine's stores take this; `node/JsonStateFile` is the disk-backed one. */
export interface StateFile<T> {
  read(): T | null;
  write(value: T): void;
}

/** Where runs live: one log per workspace, so recording a change never rewrites another workspace's. */
export interface RunHistory {
  /** Every workspace's runs as last written: last line per id wins. */
  load(): Map<string, RunRecord[]>;
  /** Persist one run's current state; `live` is the workspace's runs now, for compaction. */
  append(workspaceId: string, run: RunRecord, live: () => RunRecord[]): void;
  /** `append`, then fsync, with the same compaction rule. Throws on any failure: the caller needs to know the line is on disk. */
  appendDurably(workspaceId: string, run: RunRecord, live: () => RunRecord[]): void;
  rewrite(workspaceId: string, runs: RunRecord[]): void;
  remove(workspaceId: string): void;
}

/** What reading a workspace's factory folder yields. */
export interface FactoryFolderRead {
  /** `factory.yml` exists: what Open file creates. */
  exists: boolean;
  files: FactoryFiles;
}

/**
 * One workspace's factory folder: `factory.yml`, `automations/`, `agents/`
 * and `skills/`, read, watched and written. Every write is whole and atomic,
 * through a symlink that stays inside the folder; one whose real path
 * leaves it is never read nor written through.
 */
export interface FactoryFolderHandle {
  readonly folderPath: string;
  /** Its `factory.yml`. */
  readonly filePath: string;
  read(): Promise<FactoryFolderRead>;
  watch(onChange: () => void): void;
  unwatch(): void;
  /** Create `factory.yml` from `template` when it is missing; returns its path. */
  ensureExists(template: string): Promise<string>;
  /** Add one automation (a `- name: …` item) at the end of `factory.yml`'s list, keeping everything else. */
  appendAutomation(entryYaml: string): Promise<void>;
  /** Swap the automation called `name` in `factory.yml` for `entryYaml`, in place, keeping every byte outside it. */
  replaceAutomation(name: string, entryYaml: string): Promise<void>;
  /** Write `automations/<name>.yaml` whole, atomically. */
  writeAutomationFile(name: string, text: string): Promise<void>;
  /** Where an entry of that name is written now, read now: `factory.yml` first. */
  whereIs(name: string): Promise<'factory.yml' | 'file' | null>;
  /** `factory.yml` as written, or null when there is none yet. */
  readText(): Promise<string | null>;
  /** `automations/<name>.yaml` as written, or null when there is none. */
  readAutomationFile(name: string): Promise<string | null>;
  /** The absolute path of one of the folder's own files; null for any other path. */
  pathOf(relative: string): string | null;
}

/** One skill of an applied version: its files, by path inside its folder, and `skillHash` of them. */
export interface AppliedSkill {
  hash: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
}

/** A factory folder's last applied version: the texts and skill files it applied from. */
export interface AppliedFactory {
  folder: string;
  /** When it applied (ISO). */
  appliedAt: string;
  /** It applied as a unit; false while a first start applies entries one by one. */
  clean: boolean;
  /** By path relative to the folder. No list of removals: they are recomputed at each read. */
  texts: Record<string, string>;
  /**
   * By skill name: every skill a clean apply read, or, on a first start, the
   * skills of the agents its applied entries name. Absent when there are
   * none (and in a version kept before skills were).
   */
  skills?: Record<string, AppliedSkill>;
}

/** Where the applied version of each factory folder is kept, in Consola's own state. */
export interface AppliedFactoryStore {
  /** Null when none was written, or when what was written is damaged. */
  read(folder: string): AppliedFactory | null;
  write(applied: AppliedFactory): void;
  /** The folder's workspace was deleted: its applied version goes with it. */
  forget(folder: string): void;
}

/*
 * The tool contract. Declared with method syntax throughout so the desktop's
 * `ToolRegistry` satisfies `ToolsPort` structurally, with no adapter:
 * method parameters are bivariant, so its narrower `ToolDefinition` fits.
 */

/** Who is calling. Context for the tool, never the source of authority. */
export type EngineToolCaller =
  | { kind: 'agent'; sessionId: string; workspaceId: string }
  | { kind: 'automation'; automation: string };

/** What the caller may act on. */
export interface EngineToolScope {
  workspaceIds: readonly string[] | 'all';
  /** Sessions the call must never touch: the calling session itself. */
  excludeSessionIds: readonly string[];
}

export interface EngineToolContext {
  caller: EngineToolCaller;
  scope: EngineToolScope;
}

export interface EngineToolResult {
  summary: string;
  data: unknown;
  actionable?: number;
  approvalArgs?: Record<string, unknown>;
}

export interface EngineTool {
  name: string;
  description: string;
  /** Its arguments by name. A schema's `description` is read where there is one (zod's own types do not declare it). */
  input: Readonly<Record<string, unknown>>;
  mutating: boolean;
  destructive?: boolean;
  automatable: boolean;
  fullToolsOnly?: boolean;
}

export interface ToolsPort {
  get(ref: string): EngineTool | undefined;
  list(): EngineTool[];
  validate(
    tool: EngineTool,
    raw: unknown,
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
  invoke(
    ref: string,
    raw: unknown,
    context: EngineToolContext,
    mode?: 'preview' | 'run',
  ): Promise<EngineToolResult>;
}

/**
 * Whose checkout a run works in: `item`, a checkout of the item's own
 * repository (someone else's pull request or issue, the author's code), or
 * `scope`, one of the workspace's own folders. What a host compiles an
 * agent's servers for.
 */
export type CheckoutKind = 'item' | 'scope';

/** A request to start one agent run's session. */
export interface AgentLaunchRequest {
  workspaceId: string;
  run: { id: string; automation: string };
  /** The exact prompt the session starts with — the one its preview showed. */
  prompt: string;
  /**
   * An item run: it runs in a worktree of the item's own repo. When
   * `startedByHandSince` is set, a session the person started on the item
   * with the same action after that time refuses the launch
   * (`StartedByHandError`), checked under the lock an Inbox click takes.
   */
  item?: {
    workItem: ItemRef;
    title: string;
    label: string;
    groupId?: string;
    startedByHandSince?: string;
  };
  /** A scheduled run: it runs in this scope's folder. */
  scopeId?: string;
  /**
   * A step of a `steps:` run: the session is that step's attempt, named
   * `name`, in the folder the engine prepared (`cwd`, in scope `scopeId`),
   * so the host prepares no worktree of its own. `maxTurns` is the step's
   * cap (`stepCap`: its own `max_turns`, else its agent's), present only when
   * a file writes one. `agent` is the step's agent's requirements, present
   * only when the step names one: the host launches on its harness (absent,
   * the workspace's default) with its model, and refuses what it cannot
   * compile rather than launch looser.
   */
  step?: {
    id: string;
    attempt: number;
    cwd: string;
    scopeId: string;
    name: string;
    /** The run's checkout kind (`runCheckoutKind`): what the host compiles the agent's servers for. */
    checkout: CheckoutKind;
    /** `<attempt dir>/plugin`, where the host builds the step's plugin: only when its agent names skills. */
    pluginDir?: string;
    maxTurns?: number;
    agent?: {
      name: string;
      harnessId?: string;
      model?: string;
      mcpServers: Array<{ name: string; tools?: string[] }>;
      skills: string[];
      /** The run's copy of its skills (`runs/<run>/skills/`), checked against its definition: only when it names skills. */
      skillsDir?: string;
    };
  };
}

/** What the engine asks the host of an agent: whether its harness can run it (`agentHarness`). */
export interface AgentHarnessQuery {
  /** The agent file's `harness:`; absent, the workspace's default. */
  harnessId?: string;
  model?: string;
  mcpServers: ReadonlyArray<{ name: string; tools?: readonly string[] }>;
  skills: readonly string[];
}

/** The host's answer of a harness: the workspace's default, or the one an agent names. */
export interface AgentHarnessAnswer {
  /** Its display name (an unknown harness's id). */
  name: string;
  /** Why it cannot run a read-only unattended session; null when it can. */
  problem: string | null;
  /**
   * Why its steps' reporting turns would not launch as Consola compiles them
   * (its extra arguments override a flag they need); absent or null, they would.
   */
  stepProblem?: string | null;
  /** Why this agent cannot run on that harness at all: unknown, archived, turned off, or what it names. */
  agentProblem?: string | null;
  /** Shown, never blocking: a model the harness does not list. */
  warning?: string | null;
}

/**
 * The session `launchAgent` resolves with. Contract: it must already appear in
 * the host's `getWorkspaces()` when it resolves, and a launch the person beat
 * to it must throw `StartedByHandError`.
 */
export type LaunchedSession = Pick<
  SessionView,
  'id' | 'name' | 'harnessId' | 'claudeSessionId' | 'cwd' | 'scopeId'
>;

/** The host's identity of work items: what turns a URL into one, its key, and whether its repository is here. */
export interface WorkItemPort {
  canParseUrls(connection: string): boolean;
  /** The work item a URL names on `connection`, or null: another host, another shape, or a connection that cannot read URLs. */
  parseUrl(connection: string, url: string): ItemRef | null;
  keyOf(ref: ItemRef): string;
  urlOf(ref: ItemRef): string;
  /** Whether one of the workspace's scopes holds a clone of the item's repository. */
  inWorkspace(workspaceId: string, ref: ItemRef): boolean;
}

/**
 * One run's folder: its definition snapshot and, per step attempt, artifacts,
 * outputs and logs. Every path component is a validated token. `node/runFolder`
 * is the disk-backed one.
 */
export interface RunFolderPort {
  /** Where `factory.yml` is: a check's working directory. */
  workspaceDir(workspaceId: string): string;
  /** `<workspace>/checks/<automation>/…`: a check's logs, overwritten each check. */
  checkFiles(workspaceId: string, automation: string): { stdout: string; stderr: string };
  /** Atomic: `runs/<run>/item.json`, the object a poll returned. */
  writeItem(workspaceId: string, runId: string, item: Record<string, unknown>): void;
  readItem(workspaceId: string, runId: string): Record<string, unknown> | null;
  /** The highest attempt folder a step has in a run, or null when it has none. */
  latestAttempt(workspaceId: string, runId: string, stepId: string): number | null;
  /** `runs/<run>/item.json`'s absolute path: what `CONSOLA_ITEM_FILE` names. */
  itemPath(workspaceId: string, runId: string): string;
  runDir(workspaceId: string, runId: string): string;
  attemptDir(workspaceId: string, runId: string, stepId: string, attempt: number): string;
  /** `runs/<run>/skills/`: the run's copy of every skill its steps' agents name. */
  skillsDir(workspaceId: string, runId: string): string;
  /** Each skill written whole under `runs/<run>/skills/<name>/`; refuses a name or a path that is no token, writing nothing. */
  writeSkills(
    workspaceId: string,
    runId: string,
    skills: Readonly<Record<string, ReadonlyArray<{ path: string; bytes: Uint8Array }>>>,
  ): void;
  /**
   * Each named skill's files as the run folder holds them, regular files
   * only, sorted by path; null for a skill that is not there, or that holds
   * anything but folders and regular files. Throws on a read that fails.
   */
  readSkills(
    workspaceId: string,
    runId: string,
    names: readonly string[],
  ): Record<string, Array<{ path: string; bytes: Uint8Array }> | null>;
  writeDefinition(workspaceId: string, runId: string, definition: RunDefinition): void;
  readDefinition(workspaceId: string, runId: string): RunDefinition | null;
  /** Atomic; throws over `MAX_ARTIFACT_BYTES`. `format` is required for `output`. */
  writeArtifact(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
    content: string,
    format?: 'json' | 'text',
  ): { bytes: number };
  artifactPath(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
    format?: 'json' | 'text',
  ): string;
  readArtifact(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
  ): string | null;
  writeJson(dir: string, file: 'command.json' | 'outputs.json', value: unknown): void;
  /** Atomic: `runs/<run>/<step>/<attempt>/turn.json` gains `turn` at the end of its `turns`. */
  appendTurn(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    turn: StepTurnFile,
  ): void;
  tail(file: string, bytes?: number): { text: string; bytes: number; truncated: boolean } | null;
  /** Null when missing; throws past `maxBytes`. */
  readText(file: string, maxBytes: number): string | null;
  /** Creates the file (and its folder) empty, or truncates it. */
  ensureEmptyFile(file: string): void;
  exists(file: string): boolean;
  /** Removes every `runs/<id>` not in `keep`. */
  sweep(workspaceId: string, keep: ReadonlySet<string>): void;
  /** Removes `checks/<name>` for every name not in `keep`. */
  sweepChecks(workspaceId: string, keep: ReadonlySet<string>): void;
  /** Removes `runs/` and `checks/`. */
  removeAll(workspaceId: string): void;
}

/** One `run:` step's command, as the executor is handed it. */
export interface CommandSpec {
  command: string;
  cwd: string;
  /** Already layered (`layerCommandEnv`): nothing is added to it. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  /** Replaced by *** in both logs, across chunk boundaries. */
  secrets: string[];
  /** Test seams: SIGTERM→SIGKILL grace (default KILL_GRACE_MS) and how long pipes may stay open after exit (default 2000). */
  killGraceMs?: number;
  pipeGraceMs?: number;
}

/** How a command ended. Exactly one of `exitCode` and `signal` is set. */
export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  /** What the command wrote, which the logs hold at most the first 1 MB of. */
  stdoutBytes: number;
  stderrBytes: number;
  /** A log stopped short of what the command wrote. */
  truncated: boolean;
  /** Without escape sequences or control characters, masked after they are stripped, and clipped to 300 characters. */
  lastStderrLine?: string;
}

export interface RunningCommand {
  readonly pid: number | undefined;
  /**
   * Resolves once the shell has exited and its pipes have closed, or at
   * most `pipeGraceMs` after it exited, whatever it left holding them.
   * Rejects only when the command never started: nothing ran.
   */
  readonly result: Promise<CommandResult>;
  /** SIGTERM to the whole process group, SIGKILL after the grace. */
  stop(): void;
}

/** Runs a step's command. `node/runCommand`'s `startCommand` is the one that spawns. */
export interface CommandPort {
  start(spec: CommandSpec): RunningCommand;
}

/**
 * What a host supplies to the engine. The host's full contract is this file
 * plus `AutomationServiceDeps` in `AutomationService.ts`.
 */
import type { FactorySpecParseResult, RunRecord } from '@consola/factory-spec';
import type { ItemRef, SessionView } from './views';
import type { RunDefinition } from './steps/definition';

/** One persisted JSON document, read and written whole. The engine's stores take this; `node/JsonStateFile` is the disk-backed one. */
export interface StateFile<T> {
    read(): T | null;
    write(value: T): void;
}

/** What reading a workspace's factory file yields: whether it exists, and its parse. */
export interface LoadedFactoryFile {
    exists: boolean;
    spec: FactorySpecParseResult;
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

/** One workspace's spec file. */
export interface FactoryFileHandle {
    readonly filePath: string;
    load(): Promise<LoadedFactoryFile>;
    watch(onChange: () => void): void;
    unwatch(): void;
    /** Create the file from `template` when it is missing; returns its path. */
    ensureExists(template: string): Promise<string>;
    /** Add one automation (a `- name: …` item) at the end of the list, keeping everything else. */
    appendAutomation(entryYaml: string): Promise<void>;
    /** Swap the automation called `name` for `entryYaml`, in place, keeping every byte outside it. */
    replaceAutomation(name: string, entryYaml: string): Promise<void>;
    /** The file as written, or null when there is none yet. */
    readText(): Promise<string | null>;
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
    input: Record<string, { description?: string }>;
    mutating: boolean;
    destructive?: boolean;
    automatable: boolean;
    fullToolsOnly?: boolean;
}

export interface ToolsPort {
    get(ref: string): EngineTool | undefined;
    list(): EngineTool[];
    validate(tool: EngineTool, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
    invoke(ref: string, raw: unknown, context: EngineToolContext, mode?: 'preview' | 'run'): Promise<EngineToolResult>;
}

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
    item?: { workItem: ItemRef; title: string; label: string; groupId?: string; startedByHandSince?: string };
    /** A scheduled run: it runs in this scope's folder. */
    scopeId?: string;
}

/**
 * The session `launchAgent` resolves with. Contract: it must already appear in
 * the host's `getWorkspaces()` when it resolves, and a launch the person beat
 * to it must throw `StartedByHandError`.
 */
export type LaunchedSession = Pick<SessionView, 'id' | 'name' | 'harnessId' | 'claudeSessionId' | 'cwd' | 'scopeId'>;

/**
 * One run's folder: its definition snapshot and, per step attempt, artifacts,
 * outputs and logs. Every path component is a validated token. `node/runFolder`
 * is the disk-backed one.
 */
export interface RunFolderPort {
    runDir(workspaceId: string, runId: string): string;
    attemptDir(workspaceId: string, runId: string, stepId: string, attempt: number): string;
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
    artifactPath(workspaceId: string, runId: string, stepId: string, attempt: number, name: string, format?: 'json' | 'text'): string;
    readArtifact(workspaceId: string, runId: string, stepId: string, attempt: number, name: string): string | null;
    writeJson(dir: string, file: 'command.json' | 'outputs.json', value: unknown): void;
    tail(file: string, bytes?: number): { text: string; bytes: number; truncated: boolean } | null;
    /** Null when missing; throws past `maxBytes`. */
    readText(file: string, maxBytes: number): string | null;
    /** Creates the file (and its folder) empty, or truncates it. */
    ensureEmptyFile(file: string): void;
    exists(file: string): boolean;
    /** Removes every `runs/<id>` not in `keep`. */
    sweep(workspaceId: string, keep: ReadonlySet<string>): void;
    /** Removes `runs/` only. */
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
    /** Masked, without escape sequences or control characters. */
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

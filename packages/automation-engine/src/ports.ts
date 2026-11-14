/**
 * What a host supplies to the engine. The host's full contract is this file
 * plus `AutomationServiceDeps` in `AutomationService.ts`.
 */
import type { FactorySpecParseResult, RunRecord } from '@consola/factory-spec';
import type { ItemRef, SessionView } from './views';

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

import type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';

export type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';

/** One automation from a workspace's factory.yml, as the app shows it. */
export interface AutomationView {
    name: string;
    cron: string;
    mode: AutomationMode;
    /** The `run:` reference as written. */
    target: string;
    /** 1-based line in factory.yml. */
    line?: number;
    /** Next scheduled occurrence (ISO), or null when it will not be scheduled. */
    nextRunAt: string | null;
    /**
     * An `auto` automation that is new or changed since a person last
     * approved it: its next run asks first, then it runs on its own.
     */
    asksFirst?: boolean;
    /**
     * Why it is not scheduled even though the file parsed: an unknown tool,
     * or arguments the tool rejects.
     */
    problem?: string;
}

/**
 * The automations surface of preload. Each workspace has its own factory.yml;
 * main owns the runner, and the renderer reads one workspace's snapshot and
 * sends intents — run, approve, dismiss, open the file.
 */
export interface AutomationsAPI {
    getSnapshot: (workspaceId: string) => Promise<AutomationsSnapshot>;
    runNow: (workspaceId: string, name: string) => Promise<RunRecord>;
    approve: (runId: string) => Promise<RunRecord>;
    dismiss: (runId: string) => Promise<RunRecord>;
    openFile: (workspaceId: string) => Promise<void>;
    onChanged: (callback: (change: AutomationsChange) => void) => () => void;
}

/** One workspace's automations changed: pushed to every window, each showing the ones it is open on. */
export interface AutomationsChange {
    workspaceId: string;
    snapshot: AutomationsSnapshot;
}

/** Everything a workspace's Automations panel renders, pushed as one snapshot. */
export interface AutomationsSnapshot {
    filePath: string;
    fileExists: boolean;
    automations: AutomationView[];
    /** Problems with the file itself or with individual entries. */
    issues: FactorySpecIssue[];
    /** This workspace's runs, newest first, capped. Includes runs waiting for approval. */
    runs: RunRecord[];
}

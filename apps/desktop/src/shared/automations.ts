import type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';

export type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';

/** One automation from factory.yml as the app shows it. */
export interface AutomationView {
    name: string;
    cron: string;
    mode: AutomationMode;
    /** The `run:` reference as written. */
    target: string;
    workspace?: string;
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
     * arguments the tool rejects, a workspace that does not exist.
     */
    problem?: string;
}

/**
 * The automations surface of preload. Main owns the runner; the renderer
 * reads snapshots and sends intents — run, approve, dismiss, open the file.
 */
export interface AutomationsAPI {
    getSnapshot: () => Promise<AutomationsSnapshot>;
    runNow: (name: string) => Promise<RunRecord>;
    approve: (runId: string) => Promise<RunRecord>;
    dismiss: (runId: string) => Promise<RunRecord>;
    openFile: () => Promise<void>;
    onChanged: (callback: (snapshot: AutomationsSnapshot) => void) => () => void;
}

/** Everything the Automations settings section renders, pushed as one snapshot. */
export interface AutomationsSnapshot {
    filePath: string;
    fileExists: boolean;
    automations: AutomationView[];
    /** Problems with the file itself or with individual entries. */
    issues: FactorySpecIssue[];
    /** Newest first, capped. Includes runs waiting for approval. */
    runs: RunRecord[];
}

import type { AutomationMode, FactorySpecIssue, RunRecord } from '@consola/factory-spec';

/** One automation from a workspace's factory.yml, as the app shows it. */
export interface AutomationView {
    name: string;
    mode: AutomationMode;
    /** The trigger in words: "When a pull request asks for your review", "Weekdays at 9:00". */
    trigger: string;
    /** A cron trigger's expression, as written. */
    schedule?: string;
    /** Fired by a connection's event rather than a clock: its Run now is "Check now". */
    onEvent: boolean;
    /** A tool run in-process, or an agent session. */
    kind: 'tool' | 'agent';
    /** What it runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions". */
    runs: string;
    /** The `run:` target as written: a tool reference, an action's name, or `prompt`. */
    target: string;
    /** 1-based line in factory.yml. */
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
    /** The session whose agent wrote it into the file; new until a person opens its details. */
    addedBy?: { sessionName: string; sessionId: string; isNew: boolean };
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
    onEvent: boolean;
    kind: 'tool' | 'agent';
    runs: string;
    target: string;
    mode: AutomationMode;
    /** Its first scheduled run if it were added now (ISO); null when not on a schedule. */
    nextRunAt: string | null;
    /** The entry exactly as "Add" writes it: one `- name: …` list item. */
    entry: string;
}

/** What saving one entry into factory.yml wrote. */
export interface SavedAutomation {
    name: string;
    /** It replaced an entry of that name rather than adding one. */
    replaced: boolean;
    /** The entry as written: one `- name: …` list item. */
    entry: string;
    /** 1-based line of the entry in factory.yml. */
    line?: number;
}

/** What a run is, as the activity list groups it: an agent session, an in-process tool, or an agent's call waiting for a person. */
export type RunKind = 'agent' | 'tool' | 'request';

/**
 * A run as the activity list shows it: no approval, and its result only
 * while it waits (the Waiting card's preview). The panel reads the rest
 * with getRun.
 */
export type RunListEntry = Omit<RunRecord, 'result' | 'approval'> & { kind: RunKind; result?: unknown };

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
}

/** Everything a workspace's Automations panel renders, pushed as one snapshot. */
export interface AutomationsSnapshot {
    filePath: string;
    fileExists: boolean;
    automations: AutomationView[];
    /** Problems with the file itself or with individual entries. */
    issues: FactorySpecIssue[];
    /** This workspace's runs, newest first, capped. Includes runs waiting for approval or a slot. */
    runs: RunListEntry[];
    /** Each queued run's place in the one line every workspace shares, 1 first. */
    queue: Record<string, number>;
    /**
     * Offer automatic reviews of pull requests assigned to the person, with
     * the action they would run — or null when the workspace cannot run
     * them, its file does not load, or the file already has them.
     */
    suggestAssignedReviews: { action: string } | null;
    /** The ready-made automations, with what this workspace lacks for each and which are already in the file. */
    templates: TemplateView[];
}

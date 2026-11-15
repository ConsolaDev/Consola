import type { AutomationMode, FactorySpecIssue, RunRecord, StepRunStatus } from '@consola/factory-spec';
import type { RunFilter } from './runFilter';

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
    /** A tool run in-process, or an agent session. A `steps:` entry is `agent` when any step is an agent step. */
    kind: 'tool' | 'agent';
    /** What it runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions", "Steps: review → publish". */
    runs: string;
    /** The `run:` target as written: a tool reference, an action's name, or `prompt`; `steps` for a `steps:` entry. */
    target: string;
    /**
     * A `steps:` entry's steps in file order, as its pipeline draws them, problem or not.
     * `summary` is "Prompt", "Review action", or a command's first line.
     */
    steps?: Array<{ id: string; kind: 'agent' | 'run'; if?: string; summary: string; /** A command marked `dry_run: run`: it runs when the run only reports. */ dryRun?: true }>;
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
    /** A `steps:` template's steps in file order, as `AutomationView.steps` has them; absent for a legacy entry. */
    steps?: AutomationView['steps'];
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
export type ConversationTarget = Pick<RunRecord, 'conversation' | 'sessionId' | 'startedAt' | 'createdAt' | 'finishedAt' | 'attribution'>;

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
}

/** Everything a workspace's Automations panel renders, pushed as one snapshot. */
export interface AutomationsSnapshot {
    filePath: string;
    fileExists: boolean;
    automations: AutomationView[];
    /** Problems with the file itself or with individual entries. */
    issues: FactorySpecIssue[];
    /** This workspace's runs, newest first: every live run (waiting for approval or a slot, or working) and the newest ended ones. */
    runs: RunListEntry[];
    /** Whether ended runs were left out; `listRuns` pages them. */
    hasOlder: boolean;
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

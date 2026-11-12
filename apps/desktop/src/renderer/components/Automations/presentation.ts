import type { AutomationsSnapshot, RunListEntry, RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';

/** What a run says about itself: a full record and a list entry both have it. */
export type RunFacts = Omit<RunRecord, 'result' | 'approval'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;

/** An automation's name; for an agent's request, what it asks to do ("Delete session"). */
export function runTitle(run: RunFacts): string {
    if (run.source !== 'manual') return run.automationId;
    const words = run.actionName.replace(/^consola#/, '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function triggerLabel(run: RunFacts): string {
    if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'catch-up' : 'scheduled';
    if (run.trigger.kind === 'event') return 'event';
    return run.trigger.by === 'agent' ? 'asked by an agent' : 'run now';
}

export function formatTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** How long a run worked: from when it started (not when it queued) to when it finished, or to now. */
export function formatDuration(run: RunFacts, now: Date): string | null {
    const start = Date.parse(run.startedAt ?? run.createdAt);
    const end = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** What a run was about: the item an event run looked at, else its summary, else where it stands. */
export function runAbout(run: RunFacts): string {
    if (run.trigger.kind === 'event' && run.trigger.item?.title) return run.trigger.item.title;
    return run.summary || run.status;
}

export type RunFilter = 'all' | 'agent' | 'tool' | 'failed';

/** The last 30 days of runs, newest first, narrowed by a filter and a text query. */
export function filterRuns(runs: RunListEntry[], query: string, filter: RunFilter, now: Date): RunListEntry[] {
    const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
    const needle = query.trim().toLowerCase();
    return runs
        .filter((run) => Date.parse(run.createdAt) >= cutoff)
        .filter((run) => {
            if (filter === 'agent') return run.kind === 'agent';
            if (filter === 'tool') return run.kind === 'tool' || run.kind === 'request';
            if (filter === 'failed') return run.status === 'failed';
            return true;
        })
        .filter((run) => {
            if (!needle) return true;
            return [run.automationId, run.trigger.item?.title, run.summary].some((text) =>
                text?.toLowerCase().includes(needle),
            );
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** When a run reached its outcome: its finish, else the last time it changed. */
function endedAt(run: RunFacts): number {
    return Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt);
}

export function activityCounts(
    snapshot: AutomationsSnapshot,
    now: Date,
): {
    automations: number;
    onEvents: number;
    waiting: number;
    running: number;
    queued: number;
    ranThisWeek: number;
    failedThisWeek: number;
} {
    const weekAgo = now.getTime() - 7 * DAY_MS;
    const count = (predicate: (run: RunListEntry) => boolean) => snapshot.runs.filter(predicate).length;
    const thisWeek = (run: RunListEntry) => endedAt(run) >= weekAgo;
    return {
        automations: snapshot.automations.length,
        onEvents: snapshot.automations.filter((automation) => automation.onEvent).length,
        waiting: count((run) => run.status === 'needs-approval'),
        running: count((run) => run.status === 'running'),
        queued: count((run) => run.status === 'queued'),
        ranThisWeek: count((run) => (run.status === 'completed' || run.status === 'failed') && thisWeek(run)),
        failedThisWeek: count((run) => run.status === 'failed' && thisWeek(run)),
    };
}

/**
 * What a workspace's Automations row says in the sidebar, strongest first:
 * something waiting on the person, then a failure they have not seen yet
 * (`lastSeen` is when they last looked at Activity), then agents running.
 */
export function sidebarRowState(
    snapshot: AutomationsSnapshot | undefined,
    lastSeen: string,
): { kind: 'waiting' | 'failed' | 'running'; count: number } | { kind: 'idle' } {
    if (!snapshot) return { kind: 'idle' };
    const seen = Date.parse(lastSeen);
    const waiting = snapshot.runs.filter((run) => run.status === 'needs-approval').length;
    if (waiting > 0) return { kind: 'waiting', count: waiting };
    const failed = snapshot.runs.filter((run) => run.status === 'failed' && endedAt(run) > seen).length;
    if (failed > 0) return { kind: 'failed', count: failed };
    const running = snapshot.runs.filter((run) => run.status === 'running' && run.kind === 'agent').length;
    if (running > 0) return { kind: 'running', count: running };
    return { kind: 'idle' };
}

export type CollapsedStep = ConversationEntry | { kind: 'more'; count: number; hidden: ConversationEntry[] };

/** Splits a conversation into the prompt, the work in between, and the closing answer. */
function partition(entries: ConversationEntry[]): {
    prompts: ConversationEntry[];
    work: ConversationEntry[];
    answer: ConversationEntry[];
} {
    let promptEnd = 0;
    while (promptEnd < entries.length && entries[promptEnd].kind === 'prompt') promptEnd++;
    let lastStep = -1;
    entries.forEach((entry, index) => {
        if (entry.kind === 'step') lastStep = index;
    });
    const workEnd = Math.max(lastStep + 1, promptEnd);
    return {
        prompts: entries.slice(0, promptEnd),
        work: entries.slice(promptEnd, workEnd),
        answer: entries.slice(workEnd),
    };
}

/**
 * Folds the middle of a long run into "N more steps", keeping its first and
 * last few. Only worth hiding when the fold would hide more than one step.
 */
export function collapseSteps(entries: ConversationEntry[], head = 4, tail = 4): CollapsedStep[] {
    const { prompts, work, answer } = partition(entries);
    if (work.length <= head + tail + 1) return entries;
    const hidden = work.slice(head, work.length - tail);
    return [
        ...prompts,
        ...work.slice(0, head),
        { kind: 'more', count: hidden.length, hidden },
        ...work.slice(work.length - tail),
        ...answer,
    ];
}

/**
 * The run's closing answer: the text after its last step. Text between steps
 * is the agent narrating, so it stays with the steps (the prompt is not one).
 */
export function finalAnswer(entries: ConversationEntry[]): { steps: ConversationEntry[]; answer: string | null } {
    const { work, answer } = partition(entries);
    const texts = answer.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : []));
    return { steps: work, answer: texts.length > 0 ? texts.join('\n\n') : null };
}

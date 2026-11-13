import {
    isAgentRunPreview,
    type AutomationMode,
    type AutomationView,
    type AutomationsSnapshot,
    type RunListEntry,
    type RunRecord,
} from '../../../shared/automations';
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

const STATUS_WORDS: Record<RunFacts['status'], string> = {
    queued: 'queued',
    running: 'running',
    'needs-approval': 'waiting',
    completed: 'completed',
    failed: 'failed',
    rejected: 'dismissed',
};

/** Where a run stands, in one word: "waiting" for a person, "dismissed" when they turned it down. */
export function statusWord(status: RunFacts['status']): string {
    return STATUS_WORDS[status];
}

/** What an automation does when it fires, in words. */
export function modeInWords(mode: AutomationMode, asksFirst = false): string {
    if (mode === 'confirm') return 'Asks you before each run';
    if (mode === 'notify') return 'Tells you what it would do, and starts nothing';
    return asksFirst ? 'Runs on its own once you approve its next run' : 'Runs on its own';
}

/** What a run ran: an agent run's "Review action" or "Prompt", else its tool. */
export function ranInWords(run: RunRecord): string {
    if (isAgentRunPreview(run.result)) return run.result.runs;
    return `Tool: ${run.actionName.split('#').pop()}`;
}

/**
 * What the side panel shows of a run below its facts. An agent run has a
 * conversation only once a session ran it; one dismissed, only reported
 * (notify), or that could not start never had one.
 */
export type RunStage =
    | 'agent-waiting'
    | 'agent-queued'
    | 'agent-running'
    | 'agent-finished'
    | 'agent-unstarted'
    | 'tool';

export function runStage(run: RunRecord): RunStage {
    if (!isAgentRunPreview(run.result)) return 'tool';
    if (run.status === 'needs-approval') return 'agent-waiting';
    if (run.status === 'queued') return 'agent-queued';
    if (run.status === 'running') return 'agent-running';
    return run.conversation || run.sessionId ? 'agent-finished' : 'agent-unstarted';
}

export function triggerLabel(run: RunFacts): string {
    if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'catch-up' : 'scheduled';
    if (run.trigger.kind === 'event') return 'event';
    return run.trigger.by === 'agent' ? 'asked by an agent' : 'run now';
}

/**
 * What fired a run, as a run list's second line says it, the way GitHub
 * Actions writes "Scheduled" or "Manually run": a sentence fragment, where
 * `triggerLabel` is a column's word.
 */
export function triggerInWords(run: RunFacts): string {
    if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'Scheduled, run late' : 'Scheduled';
    if (run.trigger.kind === 'event') return 'Inbox event';
    return run.trigger.by === 'agent' ? 'Asked for by an agent' : 'Run by you';
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
    return formatElapsed(end - start);
}

/**
 * A length of time as a run's duration says it: "<1s", "42s", "3m 5s",
 * "1h 04m". A tool run is often over within the second, and "0s" would
 * read as though it never ran.
 */
export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds === 0) return '<1s';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * What a run was about: the item an event run looked at; for a failure, the
 * first line of why it failed; else its summary, else where it stands.
 */
export function runAbout(run: RunFacts): string {
    if (run.trigger.kind === 'event' && run.trigger.item?.title) return run.trigger.item.title;
    if (run.status === 'failed') {
        const why = run.error?.split('\n').find((line) => line.trim())?.trim();
        if (why) return why;
    }
    return run.summary || run.status;
}

export type RunFilter = 'all' | 'agent' | 'tool' | 'failed';

/** What narrows the run list: free text, a kind, and one automation. */
export interface RunListFilter {
    query: string;
    kind: RunFilter;
    /** A run's `automationId`: an entry's name, or an agent request's tool reference. Null for every one. */
    automation: string | null;
}

export const NO_RUN_FILTER: RunListFilter = { query: '', kind: 'all', automation: null };

export function isRunFilterNarrowed(filter: RunListFilter): boolean {
    return filter.query.trim() !== '' || filter.kind !== 'all' || filter.automation !== null;
}

/**
 * How many runs each kind would list with the rest of the filter as it is,
 * so the kind buttons can say so ("Failed 2") before they are pressed.
 */
export function runKindCounts(runs: RunListEntry[], filter: RunListFilter, now: Date): Record<RunFilter, number> {
    const count = (kind: RunFilter) => filterRuns(runs, { ...filter, kind }, now).length;
    return { all: count('all'), agent: count('agent'), tool: count('tool'), failed: count('failed') };
}

/** A local calendar day of a run list, as its heading says it, with its runs in the list's order. */
export interface RunDayGroup<T extends RunFacts = RunFacts> {
    key: string;
    label: string;
    runs: T[];
}

/**
 * A run list (newest first) split by the local day each run started:
 * "Today", "Yesterday", the weekday and date within the week, else the
 * date. Each row then needs only its time of day.
 */
export function groupRunsByDay<T extends RunFacts>(runs: T[], now: Date): Array<RunDayGroup<T>> {
    const groups: Array<RunDayGroup<T>> = [];
    for (const run of runs) {
        const at = new Date(run.createdAt);
        const key = Number.isNaN(at.getTime()) ? 'unknown' : `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
        const last = groups[groups.length - 1];
        if (last?.key === key) last.runs.push(run);
        else groups.push({ key, label: dayLabel(at, now), runs: [run] });
    }
    return groups;
}

function dayLabel(at: Date, now: Date): string {
    if (Number.isNaN(at.getTime())) return 'Unknown day';
    const days = calendarDaysBefore(at, now);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const date = at.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
    if (days > 1 && days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'long' })}, ${date}`;
    return date;
}

/** Waiting for a person or a slot, or working: history never drops these, so neither does the list. */
const LIVE_STATUSES: ReadonlySet<RunFacts['status']> = new Set(['needs-approval', 'queued', 'running']);

/**
 * The runs history keeps, newest first, narrowed by a filter. The same rule
 * as retention (`RunStore`): a run that ended in the last 30 days, by when
 * it ended, and every live run however old.
 */
export function filterRuns(runs: RunListEntry[], filter: RunListFilter, now: Date): RunListEntry[] {
    const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
    const needle = filter.query.trim().toLowerCase();
    return runs
        .filter((run) => {
            if (LIVE_STATUSES.has(run.status)) return true;
            const ended = endedAt(run);
            return Number.isNaN(ended) || ended >= cutoff;
        })
        .filter((run) => filter.automation === null || run.automationId === filter.automation)
        .filter((run) => {
            if (filter.kind === 'agent') return run.kind === 'agent';
            if (filter.kind === 'tool') return run.kind === 'tool' || run.kind === 'request';
            if (filter.kind === 'failed') return run.status === 'failed';
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

/** One automation the run list can narrow to, as its rows name it, with how many runs it has there. */
export interface RunAutomationOption {
    id: string;
    label: string;
    count: number;
    /** An entry in factory.yml now; else an entry since removed, or an agent's request. */
    inFile: boolean;
}

/**
 * What the run list can be narrowed to: factory.yml's entries in the file's
 * order, then anything else with runs in `history` — an entry since removed,
 * or an agent's request ("Delete session"). The one already chosen stays
 * listed even with neither, so the menu still shows what is ticked.
 */
export function runAutomationOptions(
    snapshot: AutomationsSnapshot,
    history: RunListEntry[],
    chosen: string | null,
): RunAutomationOption[] {
    const counts = new Map<string, number>();
    for (const run of history) counts.set(run.automationId, (counts.get(run.automationId) ?? 0) + 1);
    const options: RunAutomationOption[] = snapshot.automations.map((automation) => ({
        id: automation.name,
        label: automation.name,
        count: counts.get(automation.name) ?? 0,
        inFile: true,
    }));
    const listed = new Set(options.map((option) => option.id));
    for (const run of history) {
        if (listed.has(run.automationId)) continue;
        listed.add(run.automationId);
        options.push({ id: run.automationId, label: runTitle(run), count: counts.get(run.automationId) ?? 0, inFile: false });
    }
    if (chosen !== null && !listed.has(chosen)) options.push({ id: chosen, label: chosen, count: 0, inFile: false });
    return options;
}

/** Midnight-to-midnight days from `at` to `now`, in local time; DST days still count as one. */
function calendarDaysBefore(at: Date, now: Date): number {
    const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.round((midnight(now) - midnight(at)) / DAY_MS);
}

/**
 * When a run started, as short as a list row can say it: the time alone
 * today, "Yesterday" or the weekday within the week, else the date. The
 * full `formatTime` goes in the row's tooltip.
 */
export function formatRunWhen(iso: string, now: Date): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const days = calendarDaysBefore(at, now);
    if (days === 0) return time;
    if (days === 1) return `Yesterday, ${time}`;
    if (days > 1 && days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
    const date = at.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
    return `${date}, ${time}`;
}

/**
 * How long ago, as a row's second line says it: "just now", "14m ago",
 * "3h ago", "2d ago", and the date from a week back.
 */
export function formatAgo(iso: string, now: Date): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return '';
    const minutes = Math.floor((now.getTime() - at) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return formatRunWhen(iso, now).split(',')[0];
}

/**
 * How long until an automation is due, counted down: "in 14m", "in 3h 12m",
 * "in 2d 4h"; "due now" once it is. Minutes round up, so it never says
 * "in 0m" while there is still time.
 */
export function formatCountdown(iso: string, now: Date): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return '';
    const totalMinutes = Math.ceil((at - now.getTime()) / 60_000);
    if (totalMinutes <= 0) return 'due now';
    if (totalMinutes < 60) return `in ${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    if (hours < 24) return totalMinutes % 60 === 0 ? `in ${hours}h` : `in ${hours}h ${totalMinutes % 60}m`;
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `in ${days}d` : `in ${days}d ${hours % 24}h`;
}

/**
 * When an automation is next due, by the calendar: the time alone today,
 * "Tomorrow" or the weekday within the week, else the date. The countdown
 * says how soon; this says when.
 */
export function formatDueAt(iso: string, now: Date): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const days = -calendarDaysBefore(at, now);
    if (days <= 0) return time;
    if (days === 1) return `Tomorrow, ${time}`;
    if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
    const date = at.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
    return `${date}, ${time}`;
}

/** How many of its runs an automation's row draws. */
export const RECENT_RUNS = 12;

/**
 * An automation's latest runs, oldest first, as its row draws them left to
 * right. The same runs Activity lists for it, so the strip and "Open in
 * Activity" never disagree.
 */
export function recentRuns(runs: RunListEntry[], automation: string, now: Date, limit = RECENT_RUNS): RunListEntry[] {
    return filterRuns(runs, { ...NO_RUN_FILTER, automation }, now).slice(0, limit).reverse();
}

/**
 * The strip's slots: `recentRuns` padded on the left with empty ones, so
 * every row's newest run sits at the same x, at the strip's right edge.
 */
export function historySlots<T>(runs: T[], size = RECENT_RUNS): Array<T | null> {
    const shown = runs.slice(-size);
    return [...Array<null>(size - shown.length).fill(null), ...shown];
}

const STRIP_ORDER: ReadonlyArray<RunFacts['status']> = [
    'completed',
    'failed',
    'running',
    'needs-approval',
    'queued',
    'rejected',
];

/** The strip in words, for whoever cannot see its colours: "Last 12 runs: 11 completed, 1 failed". */
export function recentRunsInWords(runs: RunFacts[]): string {
    if (runs.length === 0) return 'No runs in the last 30 days';
    const lead = runs.length === 1 ? 'Last run' : `Last ${runs.length} runs`;
    const present = STRIP_ORDER.filter((status) => runs.some((run) => run.status === status));
    if (present.length === 1) return `${lead}: ${runs.length === 1 ? '' : 'all '}${statusWord(present[0])}`;
    return `${lead}: ${statusCountsInWords(runs)}`;
}

/** How runs ended, counted in the strip's order: "3 completed, 1 failed". */
export function statusCountsInWords(runs: RunFacts[]): string {
    return statusCounts(runs)
        .map(({ status, count }) => `${count} ${statusWord(status)}`)
        .join(', ');
}

/** Runs counted by status, in the strip's order, leaving out the ones none have. */
export function statusCounts(runs: RunFacts[]): Array<{ status: RunFacts['status']; count: number }> {
    return STRIP_ORDER.map((status) => ({ status, count: runs.filter((run) => run.status === status).length })).filter(
        ({ count }) => count > 0,
    );
}

/**
 * What an automation's runs add up to, as a CI dashboard sums up a
 * pipeline. `runs` are what history keeps for it (`filterRuns`), newest first.
 */
export interface RunInsights {
    total: number;
    /** Completed out of those that worked to an end (completed or failed), 0–1; null when none did. */
    successRate: number | null;
    /** The middle duration of those that worked to an end, in ms; null when none did. */
    medianMs: number | null;
    /** When the newest failure ended; null when none failed. */
    lastFailureAt: string | null;
    /** The newest runs that worked to an end, counted while they ended the same way. */
    streak: { status: 'completed' | 'failed'; count: number } | null;
}

export function runInsights(runs: RunFacts[]): RunInsights {
    const ended = runs.filter(
        (run): run is RunFacts & { status: 'completed' | 'failed' } =>
            run.status === 'completed' || run.status === 'failed',
    );
    const completed = ended.filter((run) => run.status === 'completed').length;
    const durations = ended
        .map((run) => Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? run.createdAt))
        .filter((ms) => Number.isFinite(ms) && ms >= 0)
        .sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const medianMs =
        durations.length === 0
            ? null
            : durations.length % 2 === 1
              ? durations[middle]
              : (durations[middle - 1] + durations[middle]) / 2;
    const lastFailure = ended.find((run) => run.status === 'failed');
    let streak: RunInsights['streak'] = null;
    if (ended.length > 0) {
        const status = ended[0].status;
        const broken = ended.findIndex((run) => run.status !== status);
        streak = { status, count: broken === -1 ? ended.length : broken };
    }
    return {
        total: runs.length,
        successRate: ended.length === 0 ? null : completed / ended.length,
        medianMs,
        lastFailureAt: lastFailure ? (lastFailure.finishedAt ?? lastFailure.updatedAt ?? lastFailure.createdAt) : null,
        streak,
    };
}

/** One local calendar day of an automation's runs, newest run first. */
export interface RunDay<T extends RunFacts = RunFacts> {
    /** Local midnight that starts it. */
    day: Date;
    runs: T[];
}

/**
 * The last `days` local calendar days, oldest first and today last, each
 * with the runs created on it. A day with no runs is still there, so a gap
 * in a schedule shows as one.
 */
export function runsByDay<T extends RunFacts>(runs: T[], now: Date, days = HISTORY_DAYS): Array<RunDay<T>> {
    const result: Array<RunDay<T>> = [];
    for (let back = days - 1; back >= 0; back--) {
        result.push({ day: new Date(now.getFullYear(), now.getMonth(), now.getDate() - back), runs: [] });
    }
    for (const run of runs) {
        const at = new Date(run.createdAt);
        if (Number.isNaN(at.getTime())) continue;
        const index = days - 1 - calendarDaysBefore(at, now);
        if (index >= 0 && index < days) result[index].runs.push(run);
    }
    for (const entry of result) entry.runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return result;
}

/**
 * The step a person stands in between an automation firing and it acting,
 * when there is one: approving each run (`confirm`), approving the next one
 * (`auto`, new or changed since approved), or only being told (`notify`),
 * which follows a preview rather than gating a run.
 */
export interface ApprovalStep {
    kind: 'approve' | 'notify';
    title: string;
    detail: string;
}

/** How a template's entry will treat the person once added: a card's line, where `approvalStep` is a pipeline's node. */
export function templateModeWords(mode: AutomationMode): string {
    if (mode === 'confirm') return 'You approve each run';
    if (mode === 'notify') return 'Only tells you what it would do';
    return 'Asks once, then runs on its own';
}

export function approvalStep(
    automation: Pick<AutomationView, 'mode' | 'asksFirst' | 'kind'>,
    /** Not in the file yet (a template): an `auto` entry's first run is the one it asks about. */
    draft = false,
): ApprovalStep | null {
    if (automation.mode === 'notify') {
        return { kind: 'notify', title: 'Tells you what it would do', detail: 'Starts nothing' };
    }
    if (automation.mode === 'confirm') {
        return {
            kind: 'approve',
            title: 'You approve each run',
            detail:
                automation.kind === 'agent'
                    ? 'Its session starts when you press Start'
                    : 'It previews first; nothing changes until you approve',
        };
    }
    if (draft && automation.mode === 'auto') {
        return { kind: 'approve', title: 'You approve its first run', detail: 'Then it runs on its own' };
    }
    if (automation.asksFirst) {
        return {
            kind: 'approve',
            title: 'You approve its next run',
            detail: 'New or changed since you last did; then it runs on its own',
        };
    }
    return null;
}

/** A piece of one line of YAML, by what it is, so an entry shows as written but easier to read. */
export interface YamlToken {
    kind: 'space' | 'dash' | 'key' | 'colon' | 'punct' | 'string' | 'number' | 'literal' | 'plain' | 'comment';
    text: string;
}

/** An inline map or list's pieces: a quoted string, a key, a number, punctuation, space, or a bare word. */
const YAML_FLOW = /("[^"]*"|'[^']*')|([^\s{}[\],:"']+)(?=\s*:)|(-?\d+(?:\.\d+)?)(?=[\s,}\]]|$)|([{}[\],])|(:)|(\s+)|([^\s{}[\],:"']+|.)/g;

/** `{ cron: "0 9 * * *" }` and `[merged, closed]`, shaded inside as a block mapping is. */
function yamlFlowTokens(value: string): YamlToken[] {
    const tokens: YamlToken[] = [];
    for (const [text, string, key, number, punct, colon, space] of value.matchAll(YAML_FLOW)) {
        const kind: YamlToken['kind'] = string
            ? 'string'
            : key
              ? 'key'
              : number
                ? 'number'
                : punct
                  ? 'punct'
                  : colon
                    ? 'colon'
                    : space
                      ? 'space'
                      : /^(true|false|null|~)$/i.test(text)
                        ? 'literal'
                        : 'plain';
        tokens.push({ kind, text });
    }
    return tokens;
}

const YAML_KEY = /^((?:"[^"]*"|'[^']*'|[^\s#'"][^:#]*?))(:)(?=\s|$)/;

/**
 * An entry's lines as tokens. Shading only: nothing here decides what the
 * file means. A block scalar's body (`prompt: |`) is text however it looks,
 * so it is never read as keys.
 */
export function yamlTokens(text: string): YamlToken[][] {
    let blockIndent: number | null = null;
    return text.split('\n').map((line) => {
        const indent = line.length - line.trimStart().length;
        const body = line.slice(indent);
        const tokens: YamlToken[] = indent > 0 ? [{ kind: 'space', text: line.slice(0, indent) }] : [];
        if (blockIndent !== null) {
            if (body === '' || indent > blockIndent) {
                if (body) tokens.push({ kind: 'string', text: body });
                return tokens;
            }
            blockIndent = null;
        }
        let rest = body;
        let column = indent;
        while (rest.startsWith('- ') || rest === '-') {
            tokens.push({ kind: 'dash', text: '-' });
            if (rest.length > 1) tokens.push({ kind: 'space', text: ' ' });
            rest = rest.slice(2);
            column += 2;
        }
        if (rest.startsWith('#')) return [...tokens, { kind: 'comment', text: rest }];
        const key = YAML_KEY.exec(rest);
        if (key) {
            tokens.push({ kind: 'key', text: key[1] }, { kind: 'colon', text: ':' });
            rest = rest.slice(key[0].length);
            if (/^\s*[|>][-+0-9]*\s*(#.*)?$/.test(rest)) blockIndent = column;
        }
        if (rest) tokens.push(...yamlValueTokens(rest));
        return tokens;
    });
}

function yamlValueTokens(rest: string): YamlToken[] {
    const lead = rest.length - rest.trimStart().length;
    const tokens: YamlToken[] = lead > 0 ? [{ kind: 'space', text: rest.slice(0, lead) }] : [];
    let value = rest.slice(lead);
    let comment = '';
    if (!/^["']/.test(value)) {
        const hash = value.search(/\s#/);
        if (hash !== -1) {
            comment = value.slice(hash);
            value = value.slice(0, hash);
        }
    }
    if (/^[{[]/.test(value)) tokens.push(...yamlFlowTokens(value));
    else if (value) {
        const kind: YamlToken['kind'] = /^(["']).*\1$/.test(value)
            ? 'string'
            : /^-?\d+(\.\d+)?$/.test(value)
              ? 'number'
              : /^(true|false|null|~|[|>][-+0-9]*)$/i.test(value)
                ? 'literal'
                : 'plain';
        tokens.push({ kind, text: value });
    }
    if (comment) {
        const space = comment.length - comment.trimStart().length;
        tokens.push({ kind: 'space', text: comment.slice(0, space) }, { kind: 'comment', text: comment.slice(space) });
    }
    return tokens;
}

/** What an automation's row says about its latest run: the word, its tone, and when or how long. */
export interface LatestRun {
    run: RunFacts;
    tone: RunFacts['status'];
    label: string;
    detail: string;
}

const LATEST_LABELS: Record<RunFacts['status'], string> = {
    queued: 'Queued',
    running: 'Running',
    'needs-approval': 'Waiting for you',
    completed: 'Completed',
    failed: 'Failed',
    rejected: 'Dismissed',
};

/** Where a run stands, as a label rather than a word in a sentence: "Waiting for you", "Completed". */
export function statusLabel(status: RunFacts['status']): string {
    return LATEST_LABELS[status];
}

/**
 * The run an automation's row speaks for, strongest first: one waiting for
 * the person however old, then one running, then one queued, else the
 * newest. `runs` oldest first, as `recentRuns` gives them; `place` is a
 * queued run's place in line.
 */
export function latestRun(runs: RunFacts[], now: Date, place?: (runId: string) => number | undefined): LatestRun | null {
    const newestFirst = [...runs].reverse();
    const run =
        newestFirst.find((candidate) => candidate.status === 'needs-approval') ??
        newestFirst.find((candidate) => candidate.status === 'running') ??
        newestFirst.find((candidate) => candidate.status === 'queued') ??
        newestFirst[0];
    if (!run) return null;
    const label = statusLabel(run.status);
    if (run.status === 'running') return { run, tone: run.status, label, detail: `for ${formatDuration(run, now) ?? '0s'}` };
    if (run.status === 'queued') {
        const line = place?.(run.id);
        return { run, tone: run.status, label, detail: line !== undefined ? `${line} in line` : formatAgo(run.createdAt, now) };
    }
    if (run.status === 'needs-approval') return { run, tone: run.status, label, detail: formatAgo(run.createdAt, now) };
    return { run, tone: run.status, label, detail: formatAgo(run.finishedAt ?? run.updatedAt ?? run.createdAt, now) };
}

/** When a run reached its outcome: its finish, else the last time it changed. */
function endedAt(run: RunFacts): number {
    return Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt);
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

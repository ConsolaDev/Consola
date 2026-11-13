import { isAgentRunPreview, type RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import { formatElapsed, type RunFacts } from './presentation';

/**
 * What a run's own page shows, as a CI service shows one run of a pipeline:
 * the stages it went through and the one it stopped in, how long each took,
 * how it compares with the automation's other runs, and its steps on a
 * timeline. Everything here is read from the run record and its transcript.
 */

/** A run in one of these is over. The renderer's copy: factory-spec's own pulls in Node's crypto. */
const ENDED: ReadonlySet<RunFacts['status']> = new Set(['completed', 'failed', 'rejected']);

export type RunStageKey = 'trigger' | 'preview' | 'approval' | 'queue' | 'run' | 'notify';

/**
 * How a run went through one stage, as a CI graph colours its jobs: through
 * it, broke there, turned down there, standing in it now, or never reached
 * it — `skipped` once the run is over, `pending` while it may still come.
 */
export type RunStageState = 'passed' | 'failed' | 'stopped' | 'waiting' | 'queued' | 'running' | 'skipped' | 'pending';

export interface RunStage {
    key: RunStageKey;
    state: RunStageState;
    /** How long the run spent in it, when the record says; still counting while the run is in it. */
    ms: number | null;
}

/**
 * The stages a run has, in order, and how it went through each.
 *
 * Which stages: every run has its trigger. A tool run that does not just
 * run (`confirm`, `notify`) previews first. `confirm` waits for a person;
 * an agent run then waits for a slot; then it runs. `notify` only tells.
 *
 * Where it stopped is read from what the record has: `startedAt` is set
 * only once it worked, `approvedAt` once a person approved it, and a tool
 * run's `approval` once it asked. A run from before `approvedAt` was
 * recorded that was turned down or failed before starting is placed at its
 * approval when it asked for one.
 */
export function runStages(run: RunRecord, now: Date): RunStage[] {
    const agent = isAgentRunPreview(run.result);
    const keys: RunStageKey[] = ['trigger'];
    if (!agent && run.mode !== 'auto') keys.push('preview');
    if (run.mode === 'notify') {
        keys.push('notify');
    } else {
        if (run.mode === 'confirm') keys.push('approval');
        if (agent) keys.push('queue');
        keys.push('run');
    }

    const here = stopPoint(run, keys, agent);
    const at = keys.indexOf(here.key);
    const open = !ENDED.has(run.status);
    const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
    const created = time(run.createdAt);
    const approved = time(run.approvedAt);
    const started = time(run.startedAt);
    const finished = time(run.finishedAt);
    const nowMs = now.getTime();

    return keys.map((key, index) => {
        const state: RunStageState = index < at ? 'passed' : index === at ? here.state : open ? 'pending' : 'skipped';
        if (state === 'skipped' || state === 'pending') return { key, state, ms: null };
        const isHere = index === at;
        // Where the run is now, the stage runs to now; where it ended, to its end.
        const until = (otherwise: number) => (isHere ? (open ? nowMs : finished) : otherwise);
        let ms: number | null = null;
        if (key === 'preview') ms = isHere ? span(created, until(NaN)) : null;
        // A tool run starts the moment it is approved, so its start ends the wait for an older record too.
        if (key === 'approval') ms = span(created, until(firstOf(approved, agent ? NaN : started)));
        if (key === 'queue') ms = span(firstOf(approved, run.mode === 'confirm' ? NaN : created), until(started));
        if (key === 'run') ms = span(started, until(finished));
        return { key, state, ms };
    });
}

/** The stage the run is in now, or ended in, and how. */
function stopPoint(run: RunRecord, keys: RunStageKey[], agent: boolean): { key: RunStageKey; state: RunStageState } {
    const last = keys[keys.length - 1];
    const has = (key: RunStageKey) => keys.includes(key);
    switch (run.status) {
        case 'needs-approval':
            return { key: 'approval', state: 'waiting' };
        case 'queued':
            return { key: has('queue') ? 'queue' : last, state: 'queued' };
        case 'running':
            return run.startedAt || !has('preview') ? { key: 'run', state: 'running' } : { key: 'preview', state: 'running' };
        case 'completed':
            // A preview with nothing to do finishes there; approval and the run are not needed.
            if (has('approval') && !agent && !run.startedAt) return { key: 'preview', state: 'passed' };
            return { key: last, state: 'passed' };
        case 'failed':
            if (run.startedAt || (!has('approval') && !has('preview') && !has('queue'))) return { key: last, state: 'failed' };
            if (agent) {
                return run.approvedAt || !has('approval') ? { key: 'queue', state: 'failed' } : { key: 'approval', state: 'failed' };
            }
            // Asked, then refused when approved (the file changed meanwhile); else its preview failed.
            if (run.approval && has('approval')) return { key: 'approval', state: 'failed' };
            return { key: has('preview') ? 'preview' : last, state: 'failed' };
        case 'rejected':
            if (agent && (run.approvedAt || !has('approval'))) return { key: 'queue', state: 'stopped' };
            return { key: has('approval') ? 'approval' : last, state: 'stopped' };
    }
}

/** Whether a completed run stopped at its preview: there was nothing to approve or run. */
export function foundNothingToDo(run: RunRecord): boolean {
    return run.status === 'completed' && run.mode === 'confirm' && !isAgentRunPreview(run.result) && !run.startedAt;
}

function firstOf(...values: number[]): number {
    return values.find((value) => Number.isFinite(value)) ?? NaN;
}

function span(from: number, to: number): number | null {
    return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}

/** How long a run worked: from its start to its end, or to now while it works. Null before it started. */
export function workedMs(run: RunFacts, now: Date): number | null {
    if (!run.startedAt) return null;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : run.status === 'running' ? now.getTime() : NaN;
    return span(Date.parse(run.startedAt), end);
}

/**
 * Something worth knowing about this run against the automation's others,
 * said only when true: a recovery, a streak of failures, a first failure
 * after a good run of passes, a personal best.
 */
export interface RunNote {
    tone: 'good' | 'bad' | 'neutral';
    text: string;
}

/** Below this many runs to compare with, "fastest" says nothing. */
const FASTEST_AFTER = 5;

/**
 * Notes for one run. `history` is the automation's runs, newest first, the
 * run itself among them; only those that worked to an end count.
 */
export function runNotes(run: RunFacts, history: RunFacts[]): RunNote[] {
    if (run.status !== 'completed' && run.status !== 'failed') return [];
    const ended = history.filter((candidate) => candidate.status === 'completed' || candidate.status === 'failed');
    const index = ended.findIndex((candidate) => candidate.id === run.id);
    if (index === -1) return [];
    const before = ended.slice(index + 1);
    const leading = (status: RunFacts['status']) => {
        const broken = before.findIndex((candidate) => candidate.status !== status);
        return broken === -1 ? before.length : broken;
    };
    const notes: RunNote[] = [];

    if (run.status === 'completed') {
        const failures = leading('failed');
        if (failures > 0) {
            notes.push({
                tone: 'good',
                text: failures === 1 ? 'Passing again after a failure' : `Passing again after ${failures} failures`,
            });
        }
        // Ended runs only, so "now" never counts.
        const took = (candidate: RunFacts) => workedMs(candidate, new Date(0));
        const timed = ended.filter((candidate) => candidate.status === 'completed' && took(candidate) !== null);
        const mine = took(run);
        if (mine !== null && timed.length >= FASTEST_AFTER) {
            const fastest = timed.every((candidate) => candidate.id === run.id || mine < (took(candidate) ?? Infinity));
            if (fastest) notes.push({ tone: 'good', text: `Fastest of ${timed.length} runs` });
        }
    } else {
        const failures = leading('failed') + 1;
        if (failures >= 2) {
            notes.push({ tone: 'bad', text: `${failures} failures in a row` });
        } else {
            const passes = leading('completed');
            if (passes >= 3) notes.push({ tone: 'neutral', text: `First failure after ${passes} passing runs` });
        }
    }
    return notes;
}

/** Below this many other runs, there is no "usual" to compare with. */
const USUAL_AFTER = 3;

/**
 * This run's duration against the middle of the automation's others that
 * worked to an end: "2.4× its usual 1m 20s", "faster than its usual 1m 20s",
 * or just "usual 1m 20s". A running run compares as it goes.
 */
export function durationAgainstUsual(
    run: RunFacts,
    history: RunFacts[],
    now: Date,
): { text: string; tone: 'slow' | 'fast' | 'usual' } | null {
    const mine = workedMs(run, now);
    if (mine === null) return null;
    const others = history
        .filter((candidate) => candidate.id !== run.id && (candidate.status === 'completed' || candidate.status === 'failed'))
        .map((candidate) => workedMs(candidate, now))
        .filter((ms): ms is number => ms !== null)
        .sort((a, b) => a - b);
    if (others.length < USUAL_AFTER) return null;
    const middle = Math.floor(others.length / 2);
    const median = others.length % 2 === 1 ? others[middle] : (others[middle - 1] + others[middle]) / 2;
    const usual = formatElapsed(median);
    // Under two seconds either way is the same run to a person.
    if (Math.abs(mine - median) < 2000 || median === 0) return { text: `usual ${usual}`, tone: 'usual' };
    const ratio = mine / median;
    if (ratio >= 1.5) return { text: `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× its usual ${usual}`, tone: 'slow' };
    if (ratio <= 0.67) return { text: `faster than its usual ${usual}`, tone: 'fast' };
    return { text: `usual ${usual}`, tone: 'usual' };
}

/** The runs either side of this one in its automation's history (newest first), to step through them. */
export function adjacentRuns(runId: string, history: RunFacts[]): { newer: string | null; older: string | null } {
    const index = history.findIndex((candidate) => candidate.id === runId);
    if (index === -1) return { newer: null, older: null };
    return { newer: history[index - 1]?.id ?? null, older: history[index + 1]?.id ?? null };
}

/** The tools a run's steps called, most-called first, as "Read 12 · Bash 6". */
export function toolCounts(entries: ConversationEntry[]): Array<{ tool: string; count: number }> {
    const counts = new Map<string, number>();
    for (const entry of entries) if (entry.kind === 'step') counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    return [...counts]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/**
 * How one step went, as a CI job's step list marks it: its result came back
 * (`passed`) or came back an error (`failed`); with no result, the last step
 * is still `running` in a running run and was `cut` off in a failed one.
 * Any other step without a result is `unknown`.
 */
export type StepState = 'passed' | 'failed' | 'running' | 'cut' | 'unknown';

export function stepState(
    entry: Extract<ConversationEntry, { kind: 'step' }>,
    isLastStep: boolean,
    runStatus: RunFacts['status'],
): StepState {
    if (entry.failed) return 'failed';
    if (entry.endedAt) return 'passed';
    if (isLastStep && runStatus === 'running') return 'running';
    if (isLastStep && runStatus === 'failed') return 'cut';
    return 'unknown';
}

/** The run's working time a step list draws its bars against, in epoch ms. */
export interface Timeline {
    start: number;
    end: number;
}

/**
 * From the run's start to its end — or to now while it runs — falling back
 * on the transcript's first and last timestamps. Null when there is nothing
 * to measure against.
 */
export function stepTimeline(run: RunFacts, entries: ConversationEntry[], now: Date): Timeline | null {
    const stamps = entries.flatMap((entry) => {
        const times = [entry.at, entry.kind === 'step' ? entry.endedAt : undefined];
        return times.flatMap((iso) => (iso && Number.isFinite(Date.parse(iso)) ? [Date.parse(iso)] : []));
    });
    const start = firstOf(Date.parse(run.startedAt ?? ''), stamps.length > 0 ? Math.min(...stamps) : NaN);
    const end = firstOf(
        Date.parse(run.finishedAt ?? ''),
        run.status === 'running' ? now.getTime() : NaN,
        stamps.length > 0 ? Math.max(...stamps) : NaN,
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
}

/**
 * Where a step sits on the timeline, as fractions of it, and how long it
 * took. A running step reaches to now; a step without an end shows as a
 * tick where it began.
 */
export function stepBar(
    entry: Extract<ConversationEntry, { kind: 'step' }>,
    state: StepState,
    timeline: Timeline,
    now: Date,
): { left: number; width: number; ms: number | null } | null {
    const at = Date.parse(entry.at ?? '');
    if (!Number.isFinite(at)) return null;
    const ended = entry.endedAt ? Date.parse(entry.endedAt) : state === 'running' ? now.getTime() : NaN;
    const ms = span(at, ended);
    const length = timeline.end - timeline.start;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const left = clamp((at - timeline.start) / length);
    const width = ms === null ? 0 : Math.min(1 - left, ms / length);
    return { left, width, ms };
}

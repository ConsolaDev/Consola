import { TERMINAL_RUN_STATUSES, type RunRecord } from '@consola/factory-spec';
import type { JsonStateFile } from '../state/JsonStateFile';
import type { SeenRecord } from './seenRecord';

export interface AddedBy {
    /** The session that wrote the entry into the file. */
    sessionId: string;
    sessionName: string;
    at: string;
    /** A person has looked at it: the "New" mark is gone. */
    seen: boolean;
}

export interface AutomationStateFile {
    /** 1 kept every run in this file; 2 keeps them in per-workspace logs (`RunHistory`). */
    version: 1 | 2;
    /** Last time each schedule fired (ISO), by `scheduleKey`. The scheduler's only memory. */
    lastFired: Record<string, string>;
    /** The `automationVersion` a person approved for each `auto` automation, by workspace id and name. */
    accepted?: Record<string, string>;
    /** What each event automation last saw, by workspace id and name. An event's only memory. */
    seen?: Record<string, SeenRecord>;
    /** Entries an agent added, by workspace id and name, until a person has seen them. */
    added?: Record<string, AddedBy>;
    /** Version 1 only: newest first, capped; every workspace's together. Version 2 moves them to `RunHistory`. */
    runs?: RunRecord[];
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

export const RETENTION_DAYS = 30;
/** A ceiling so a busy workspace cannot grow without bound inside the retention window. */
export const MAX_RUNS_PER_WORKSPACE = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

type StoredState = Required<Omit<AutomationStateFile, 'runs' | 'version'>>;

/**
 * Fire times, accepted versions and run history.
 *
 * Not on the workspace record for the same reason view memory is not: every
 * WorkspaceService write fsyncs the whole list and pushes it to every window.
 * Runs have their own per-workspace logs (`RunHistory`), so a state change
 * rewrites a small file and a run change appends one line. Not fatal when
 * unreadable either — a lost history costs a quiet restart of every schedule
 * and one approval per `auto` automation, never the app.
 */
export class RunStore {
    private state: StoredState = { lastFired: {}, accepted: {}, seen: {}, added: {} };
    /** Every workspace's runs, newest first. */
    private all: RunRecord[] = [];

    constructor(
        private readonly file: Pick<JsonStateFile<AutomationStateFile>, 'read' | 'write'>,
        private readonly history: RunHistory
    ) {}

    public load(nowIso: string): void {
        let migrating: RunRecord[] | null = null;
        try {
            const stored = this.file.read();
            if (stored && (stored.version === 1 || stored.version === 2)) {
                this.state = {
                    lastFired: isRecord(stored.lastFired) ? stored.lastFired : {},
                    accepted: isRecord(stored.accepted) ? stored.accepted : {},
                    seen: isRecord(stored.seen) ? (stored.seen as Record<string, SeenRecord>) : {},
                    added: isRecord(stored.added) ? (stored.added as unknown as Record<string, AddedBy>) : {},
                };
                if (stored.version === 1) migrating = Array.isArray(stored.runs) ? stored.runs : [];
            }
        } catch (error) {
            console.error('Automation history unreadable; starting empty.', error);
        }

        let groups = new Map<string | undefined, RunRecord[]>();
        try {
            // A log is oldest first, so reversing puts runs created in the same
            // instant newest first, as `byNewest` leaves ties alone.
            groups = new Map([...this.history.load()].map(([workspaceId, runs]) => [workspaceId, [...runs].reverse()]));
            // On a run both name, the log is the newer word: its lines are as new as the version-1 record, or newer.
            if (migrating) groups = mergeMigrated(groups, migrating);
        } catch (error) {
            console.error('Automation run history unreadable; starting empty.', error);
        }

        const now = Date.parse(nowIso);
        const merged: RunRecord[] = [];
        for (const [workspaceId, runs] of groups) {
            const newestFirst = [...runs].sort(byNewest);
            const kept = retained(newestFirst, now);
            // A migration writes every log; a later load rewrites only what retention shortened.
            if (workspaceId !== undefined && (migrating || kept.length < newestFirst.length)) {
                this.guarded(() => this.history.rewrite(workspaceId, [...kept].reverse()));
            }
            merged.push(...kept);
        }
        this.all = merged.sort(byNewest);
        if (migrating) this.persist();

        // A run still `running` was cut off by a quit or a crash. Saying so is
        // the honest answer; re-running a write action unasked is not. An
        // agent run's turn is read-only and was approved: it goes back to
        // the line, to resume in its session.
        for (const run of this.all) {
            if (run.status === 'running' && (run.result as { kind?: unknown } | undefined)?.kind === 'agent-run') {
                Object.assign(run, { status: 'queued', updatedAt: nowIso });
                this.record(run);
            } else if (run.status === 'running') {
                Object.assign(run, {
                    status: 'failed',
                    error: 'Interrupted: Consola quit while this was running.',
                    updatedAt: nowIso,
                    finishedAt: nowIso,
                });
                delete run.approval;
                this.record(run);
            }
        }
    }

    public lastFired(key: string): string | undefined {
        return this.state.lastFired[key];
    }

    public setLastFired(key: string, iso: string): void {
        this.state.lastFired[key] = iso;
        this.persist();
    }

    /** Forget schedules no longer in the file, so one coming back starts fresh instead of catching up. */
    public keepSchedules(keys: ReadonlySet<string>): void {
        const stale = Object.keys(this.state.lastFired).filter((key) => !keys.has(key));
        if (stale.length === 0) return;
        for (const key of stale) delete this.state.lastFired[key];
        this.persist();
    }

    public seen(automationKey: string): SeenRecord | undefined {
        const record = this.state.seen[automationKey];
        return record && Array.isArray(record.items) ? record : undefined;
    }

    public setSeen(automationKey: string, record: SeenRecord): void {
        this.state.seen[automationKey] = record;
        this.persist();
    }

    public seenKeys(): string[] {
        return Object.keys(this.state.seen);
    }

    /** Forget event automations no file names any more, so one coming back baselines afresh. */
    public keepSeen(automationKeys: ReadonlySet<string>): void {
        const stale = Object.keys(this.state.seen).filter((key) => !automationKeys.has(key));
        if (stale.length === 0) return;
        for (const key of stale) delete this.state.seen[key];
        this.persist();
    }

    public acceptedVersion(automationKey: string): string | undefined {
        return this.state.accepted[automationKey];
    }

    public accept(automationKey: string, version: string): void {
        this.state.accepted[automationKey] = version;
        this.persist();
    }

    /** Take back an approval, so the entry asks again before it next runs unasked. */
    public revokeAcceptance(automationKey: string): void {
        if (!(automationKey in this.state.accepted)) return;
        delete this.state.accepted[automationKey];
        this.persist();
    }

    /** Remember that a session wrote this entry into the file, until a person has seen it. */
    public markAdded(automationKey: string, by: Omit<AddedBy, 'seen'>): void {
        this.state.added[automationKey] = { ...by, seen: false };
        this.persist();
    }

    public addedBy(automationKey: string): AddedBy | undefined {
        return this.state.added[automationKey];
    }

    public acknowledgeAdded(automationKey: string): void {
        const added = this.state.added[automationKey];
        if (!added || added.seen) return;
        added.seen = true;
        this.persist();
    }

    public addedKeys(): string[] {
        return Object.keys(this.state.added);
    }

    /** Forget entries no file names any more. */
    public keepAdded(automationKeys: ReadonlySet<string>): void {
        const stale = Object.keys(this.state.added).filter((key) => !automationKeys.has(key));
        if (stale.length === 0) return;
        for (const key of stale) delete this.state.added[key];
        this.persist();
    }

    /** Every workspace's runs, newest first. */
    public runs(): RunRecord[] {
        return this.all;
    }

    public get(id: string): RunRecord | undefined {
        return this.all.find((run) => run.id === id);
    }

    public add(run: RunRecord): void {
        const workspaceId = run.attribution?.workspaceId;
        // The new run's own clock is "now": a run is only ever added as it happens.
        const now = Date.parse(run.createdAt);
        const kept = retained([run, ...this.runsOf(workspaceId)], now);
        const keep = new Set(kept);
        this.all = [run, ...this.all].filter((candidate) => keep.has(candidate) || candidate.attribution?.workspaceId !== workspaceId);
        // Expired runs leave memory only. Rewriting the log on every new run
        // once history is 30 days old would make each one a whole-file write;
        // their dead lines count toward compaction, and the next load drops them.
        this.record(run);
    }

    public update(id: string, changes: Partial<RunRecord>): RunRecord {
        const run = this.get(id);
        if (!run) throw new Error(`No run ${id}.`);
        Object.assign(run, changes);
        // What an approval would execute means nothing once the run has ended.
        if (TERMINAL_RUN_STATUSES.includes(run.status)) delete run.approval;
        this.record(run);
        return run;
    }

    /** A workspace was deleted: its runs and their log go with it. */
    public forgetWorkspace(workspaceId: string): void {
        this.all = this.all.filter((run) => run.attribution?.workspaceId !== workspaceId);
        this.guarded(() => this.history.remove(workspaceId));
    }

    private runsOf(workspaceId: string | undefined): RunRecord[] {
        return this.all.filter((run) => run.attribution?.workspaceId === workspaceId);
    }

    /** Persist one run's current state to its workspace's log. */
    private record(run: RunRecord): void {
        const workspaceId = run.attribution?.workspaceId;
        if (!workspaceId) return;
        // A log is oldest first, so the order a reload sees is the order runs were appended.
        this.guarded(() => this.history.append(workspaceId, run, () => this.runsOf(workspaceId).reverse()));
    }

    private persist(): void {
        this.guarded(() => this.file.write({ version: 2, ...this.state }));
    }

    private guarded(write: () => void): void {
        try {
            write();
        } catch (error) {
            // History is a convenience; a full disk must not fail the run itself.
            console.error('Could not save automation history.', error);
        }
    }
}

/**
 * Version-1 runs added to what the logs already hold, with approvals of ended
 * runs stripped. A run the logs already name keeps its log record: a log line
 * is written as the run changes, so it is never older than the version-1 copy.
 */
function mergeMigrated(
    logged: Map<string | undefined, RunRecord[]>,
    migrated: RunRecord[]
): Map<string | undefined, RunRecord[]> {
    const byId = new Map<string | undefined, Map<string, RunRecord>>();
    const into = (workspaceId: string | undefined) => {
        const existing = byId.get(workspaceId) ?? new Map<string, RunRecord>();
        byId.set(workspaceId, existing);
        return existing;
    };
    const logIds = new Set<string>();
    for (const [workspaceId, runs] of logged) {
        for (const run of runs) {
            into(workspaceId).set(run.id, run);
            logIds.add(run.id);
        }
    }
    for (const run of migrated) {
        if (logIds.has(run.id)) continue;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) delete run.approval;
        into(run.attribution?.workspaceId).set(run.id, run);
    }
    return new Map([...byId].map(([workspaceId, runs]) => [workspaceId, [...runs.values()]]));
}

/** Newest first; runs without a usable `createdAt` keep their relative order. */
function byNewest(a: RunRecord, b: RunRecord): number {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return right - left;
}

/**
 * One workspace's runs, newest first, as retention leaves them: a finished run
 * older than RETENTION_DAYS goes, then the oldest beyond MAX_RUNS_PER_WORKSPACE.
 * A run waiting for a person or a slot, or running, is never the one dropped.
 */
function retained(runs: RunRecord[], now: number): RunRecord[] {
    const isLive = (run: RunRecord) => !TERMINAL_RUN_STATUSES.includes(run.status);
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const recent = runs.filter((run) => {
        if (isLive(run)) return true;
        const ended = Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt);
        return Number.isNaN(ended) || Number.isNaN(cutoff) || ended >= cutoff;
    });
    if (recent.length <= MAX_RUNS_PER_WORKSPACE) return recent;
    const live = recent.filter(isLive);
    const room = Math.max(0, MAX_RUNS_PER_WORKSPACE - live.length);
    const finished = new Set(recent.filter((run) => !isLive(run)).slice(0, room));
    return recent.filter((run) => isLive(run) || finished.has(run));
}

function isRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

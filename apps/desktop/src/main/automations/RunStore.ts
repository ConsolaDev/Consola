import type { RunRecord } from '@consola/factory-spec';
import type { JsonStateFile } from '../state/JsonStateFile';

export interface AutomationStateFile {
    version: 1;
    /** Last time each schedule fired (ISO), by `scheduleKey`. The scheduler's only memory. */
    lastFired: Record<string, string>;
    /** The `automationVersion` a person approved for each `auto` automation, by name. */
    accepted?: Record<string, string>;
    /** Newest first, capped. */
    runs: RunRecord[];
}

/** Enough to see the last few weeks; small enough to rewrite on every change. */
export const MAX_RUNS = 100;

/**
 * Run history, fire times and accepted versions, in their own small file.
 *
 * Not on the workspace record for the same reason view memory is not: every
 * WorkspaceService write fsyncs the whole list and pushes it to every window.
 * Not fatal when unreadable either — a lost history costs a quiet restart of
 * every schedule and one approval per `auto` automation, never the app.
 */
export class RunStore {
    private state: Required<AutomationStateFile> = { version: 1, lastFired: {}, accepted: {}, runs: [] };

    constructor(private readonly file: Pick<JsonStateFile<AutomationStateFile>, 'read' | 'write'>) {}

    public load(nowIso: string): void {
        try {
            const stored = this.file.read();
            if (stored && stored.version === 1 && Array.isArray(stored.runs)) {
                this.state = {
                    version: 1,
                    lastFired: isRecord(stored.lastFired) ? stored.lastFired : {},
                    accepted: isRecord(stored.accepted) ? stored.accepted : {},
                    runs: stored.runs,
                };
            }
        } catch (error) {
            console.error('Automation history unreadable; starting empty.', error);
        }
        // A run still `running` was cut off by a quit or a crash. Saying so is
        // the honest answer; re-running a write action unasked is not.
        let interrupted = false;
        for (const run of this.state.runs) {
            if (run.status === 'running') {
                Object.assign(run, {
                    status: 'failed',
                    error: 'Interrupted: Consola quit while this was running.',
                    updatedAt: nowIso,
                    finishedAt: nowIso,
                });
                interrupted = true;
            }
        }
        if (interrupted) this.persist();
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

    public acceptedVersion(name: string): string | undefined {
        return this.state.accepted[name];
    }

    public accept(name: string, version: string): void {
        this.state.accepted[name] = version;
        this.persist();
    }

    public runs(): RunRecord[] {
        return this.state.runs;
    }

    public get(id: string): RunRecord | undefined {
        return this.state.runs.find((run) => run.id === id);
    }

    public add(run: RunRecord): void {
        this.state.runs = capped([run, ...this.state.runs]);
        this.persist();
    }

    public update(id: string, changes: Partial<RunRecord>): RunRecord {
        const run = this.get(id);
        if (!run) throw new Error(`No run ${id}.`);
        Object.assign(run, changes);
        this.persist();
        return run;
    }

    private persist(): void {
        try {
            this.file.write(this.state);
        } catch (error) {
            // History is a convenience; a full disk must not fail the run itself.
            console.error('Could not save automation history.', error);
        }
    }
}

/** Newest first, at most MAX_RUNS — but a run waiting for approval is never the one dropped. */
function capped(runs: RunRecord[]): RunRecord[] {
    if (runs.length <= MAX_RUNS) return runs;
    const waiting = runs.filter((run) => run.status === 'needs-approval');
    const rest = runs.filter((run) => run.status !== 'needs-approval').slice(0, Math.max(0, MAX_RUNS - waiting.length));
    const keep = new Set([...waiting, ...rest]);
    return runs.filter((run) => keep.has(run));
}

function isRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import * as fs from 'fs';
import * as path from 'path';
import type { RunRecord } from '@consola/factory-spec';
import type { RunHistory } from './RunStore';

/** Workspace ids are generated tokens; anything else never reaches the filesystem as a path. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/** A log is rewritten once it holds more than this many lines beyond twice its live runs. */
const COMPACTION_SLACK = 50;

/**
 * One append-only JSONL log per workspace: `<dir>/<workspaceId>.jsonl`. Every
 * change to a run appends its whole record, and the last line per run id wins,
 * so recording a change costs one small write rather than a rewrite of every
 * run. The log is rewritten (compacted) when it has grown past twice its live
 * runs plus a little, and by `rewrite` when retention drops runs.
 *
 * A crash can leave the last line half-written; a line that does not parse is
 * skipped, and the next compaction drops it.
 */
export class RunHistoryFiles implements RunHistory {
    /** Lines each log holds, so an append can tell when to compact without rereading. */
    private readonly lines = new Map<string, number>();

    constructor(private readonly dir: string) {}

    public load(): Map<string, RunRecord[]> {
        const result = new Map<string, RunRecord[]>();
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch (error) {
            if (isMissing(error)) return result;
            throw error;
        }
        for (const name of names) {
            if (!name.endsWith('.jsonl')) continue;
            const workspaceId = name.slice(0, -'.jsonl'.length);
            if (!WORKSPACE_ID.test(workspaceId)) continue;
            const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
            const lines = text.split('\n').filter((line) => line !== '');
            const latest = new Map<string, RunRecord>();
            let damaged = text !== '' && !text.endsWith('\n');
            for (const line of lines) {
                const run = parseRun(line);
                if (!run) {
                    damaged = true;
                    continue;
                }
                // Setting an existing id keeps its first position: creation order.
                latest.set(run.id, run);
            }
            const runs = [...latest.values()];
            if (runs.length > 0) result.set(workspaceId, runs);
            if (damaged || lines.length > compactionThreshold(runs.length)) this.rewrite(workspaceId, runs);
            else this.lines.set(workspaceId, lines.length);
        }
        return result;
    }

    public append(workspaceId: string, run: RunRecord, live: () => RunRecord[]): void {
        const file = this.fileFor(workspaceId);
        if (!run.attribution?.workspaceId) return;
        fs.mkdirSync(this.dir, { recursive: true });
        const count = this.lines.get(workspaceId) ?? this.adopt(file, workspaceId);
        fs.appendFileSync(file, `${JSON.stringify(run)}\n`);
        this.lines.set(workspaceId, count + 1);
        const runs = live();
        if (count + 1 > compactionThreshold(runs.length)) this.rewrite(workspaceId, runs);
    }

    public rewrite(workspaceId: string, runs: RunRecord[]): void {
        const file = this.fileFor(workspaceId);
        const persisted = runs.filter((run) => run.attribution?.workspaceId);
        if (persisted.length === 0) {
            this.remove(workspaceId);
            return;
        }
        fs.mkdirSync(this.dir, { recursive: true });
        // Whole, through a temporary file, so a crash leaves the old log or the new one.
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, persisted.map((run) => `${JSON.stringify(run)}\n`).join(''));
        fs.renameSync(temporary, file);
        this.lines.set(workspaceId, persisted.length);
    }

    public remove(workspaceId: string): void {
        const file = this.fileFor(workspaceId);
        this.lines.delete(workspaceId);
        try {
            fs.unlinkSync(file);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }

    private fileFor(workspaceId: string): string {
        if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`Not a workspace id: ${JSON.stringify(workspaceId)}.`);
        return path.join(this.dir, `${workspaceId}.jsonl`);
    }

    /** First touch of a log this process did not load: count its lines, and end a torn last one. */
    private adopt(file: string, workspaceId: string): number {
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            if (isMissing(error)) return 0;
            throw error;
        }
        if (text !== '' && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
        const count = text.split('\n').filter((line) => line !== '').length;
        this.lines.set(workspaceId, count);
        return count;
    }
}

function compactionThreshold(liveRuns: number): number {
    return 2 * liveRuns + COMPACTION_SLACK;
}

function parseRun(line: string): RunRecord | null {
    try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
            return value as RunRecord;
        }
    } catch {
        // A torn line.
    }
    return null;
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

import * as fs from 'fs';
import * as path from 'path';
import { ARTIFACT_NAME_PATTERN, STEP_ID_PATTERN } from '@consola/factory-spec';
import type { RunFolderPort } from '../ports';
import { MAX_ARTIFACT_BYTES, type RunDefinition } from '../steps/definition';
import { workspaceDataDir } from './factoryFile';

const TOKEN = /^[A-Za-z0-9_-]+$/;
const LEGACY_STEP = /^step-\d+$/;
const DEFAULT_TAIL_BYTES = 64 * 1024;

function token(what: string, value: string, pattern: RegExp): string {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Not a ${what}: ${JSON.stringify(value)}.`);
    return value;
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function writeAtomically(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
}

/**
 * `<workspace>/runs/<run>/`: the definition a run executes and, per step
 * attempt, its artifacts, outputs and logs. Each execution of a step has its own
 * numbered folder, so a retry never overwrites what the first left. Every path
 * component is a validated token, so nothing climbs out of the folder.
 */
export class RunFolder implements RunFolderPort {
    constructor(private readonly root: (workspaceId: string) => string = workspaceDataDir) {}

    private runsDir(workspaceId: string): string {
        return path.join(this.root(token('workspace id', workspaceId, TOKEN)), 'runs');
    }

    public runDir(workspaceId: string, runId: string): string {
        return path.join(this.runsDir(workspaceId), token('run id', runId, TOKEN));
    }

    public attemptDir(workspaceId: string, runId: string, stepId: string, attempt: number): string {
        if (!STEP_ID_PATTERN.test(stepId) && !LEGACY_STEP.test(stepId)) throw new Error(`Not a step id: ${JSON.stringify(stepId)}.`);
        if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Not an attempt number: ${JSON.stringify(attempt)}.`);
        return path.join(this.runDir(workspaceId, runId), stepId, String(attempt));
    }

    public writeDefinition(workspaceId: string, runId: string, definition: RunDefinition): void {
        writeAtomically(path.join(this.runDir(workspaceId, runId), 'definition.json'), JSON.stringify(definition));
    }

    public readDefinition(workspaceId: string, runId: string): RunDefinition | null {
        const text = this.readText(path.join(this.runDir(workspaceId, runId), 'definition.json'), 16 * 1024 * 1024);
        return text === null ? null : (JSON.parse(text) as RunDefinition);
    }

    public artifactPath(
        workspaceId: string,
        runId: string,
        stepId: string,
        attempt: number,
        name: string,
        format?: 'json' | 'text',
    ): string {
        const dir = this.attemptDir(workspaceId, runId, stepId, attempt);
        if (name === 'output') {
            if (format !== 'json' && format !== 'text') throw new Error('The output artifact needs a format: json or text.');
            return path.join(dir, format === 'json' ? 'output.json' : 'output.txt');
        }
        return path.join(dir, `${token('artifact name', name, ARTIFACT_NAME_PATTERN)}.md`);
    }

    public writeArtifact(
        workspaceId: string,
        runId: string,
        stepId: string,
        attempt: number,
        name: string,
        content: string,
        format?: 'json' | 'text',
    ): { bytes: number } {
        const file = this.artifactPath(workspaceId, runId, stepId, attempt, name, format);
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_ARTIFACT_BYTES) {
            throw new Error(`Artifact "${name}" is ${bytes} bytes; the cap is ${MAX_ARTIFACT_BYTES / 1024} KB.`);
        }
        writeAtomically(file, content);
        return { bytes };
    }

    public readArtifact(workspaceId: string, runId: string, stepId: string, attempt: number, name: string): string | null {
        if (name === 'output') {
            for (const format of ['json', 'text'] as const) {
                const text = this.readText(this.artifactPath(workspaceId, runId, stepId, attempt, name, format), MAX_ARTIFACT_BYTES);
                if (text !== null) return text;
            }
            return null;
        }
        return this.readText(this.artifactPath(workspaceId, runId, stepId, attempt, name), MAX_ARTIFACT_BYTES);
    }

    public writeJson(dir: string, file: 'command.json' | 'outputs.json', value: unknown): void {
        if (file !== 'command.json' && file !== 'outputs.json') throw new Error(`Not a run file: ${JSON.stringify(file)}.`);
        writeAtomically(path.join(dir, file), JSON.stringify(value));
    }

    public tail(file: string, bytes: number = DEFAULT_TAIL_BYTES): { text: string; bytes: number; truncated: boolean } | null {
        let fd: number;
        try {
            fd = fs.openSync(file, 'r');
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
        try {
            const size = fs.fstatSync(fd).size;
            const length = Math.min(size, bytes);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, size - length);
            return { text: buffer.toString('utf8'), bytes: size, truncated: size > bytes };
        } finally {
            fs.closeSync(fd);
        }
    }

    public readText(file: string, maxBytes: number): string | null {
        let size: number;
        try {
            size = fs.statSync(file).size;
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
        if (size > maxBytes) throw new Error(`${path.basename(file)} is ${size} bytes; the most read is ${maxBytes}.`);
        return fs.readFileSync(file, 'utf8');
    }

    public ensureEmptyFile(file: string): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
    }

    public exists(file: string): boolean {
        return fs.existsSync(file);
    }

    public sweep(workspaceId: string, keep: ReadonlySet<string>): void {
        const dir = this.runsDir(workspaceId);
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
        for (const name of names) {
            if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
    }

    public removeAll(workspaceId: string): void {
        fs.rmSync(this.runsDir(workspaceId), { recursive: true, force: true });
    }
}

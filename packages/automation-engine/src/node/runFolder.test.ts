import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDefinition } from '../steps/definition';
import { RunFolder } from './runFolder';

describe('RunFolder', () => {
    let tmp: string;
    let folder: RunFolder;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-folder-'));
        folder = new RunFolder((workspaceId) => path.join(tmp, workspaceId));
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('writes and reads a definition', () => {
        expect(folder.readDefinition('ws', 'r1')).toBeNull();
        const definition = { automation: { name: 'a', steps: [] }, version: 'v1', actions: { review: { name: 'x', body: 'b' } } } as unknown as RunDefinition;
        folder.writeDefinition('ws', 'r1', definition);
        expect(folder.readDefinition('ws', 'r1')).toEqual(definition);
    });

    it("keeps each attempt's artifacts apart", () => {
        folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'first');
        folder.writeArtifact('ws', 'r1', 'review', 2, 'handover', 'second');
        expect(folder.readArtifact('ws', 'r1', 'review', 1, 'handover')).toBe('first');
        expect(folder.readArtifact('ws', 'r1', 'review', 2, 'handover')).toBe('second');
        expect(folder.artifactPath('ws', 'r1', 'review', 2, 'handover')).toMatch(/review[\\/]2[\\/]handover\.md$/);
    });

    it('maps the output artifact to its format', () => {
        folder.writeArtifact('ws', 'r1', 'review', 1, 'output', '{"a":1}', 'json');
        expect(folder.artifactPath('ws', 'r1', 'review', 1, 'output', 'json')).toMatch(/output\.json$/);
        expect(folder.readArtifact('ws', 'r1', 'review', 1, 'output')).toBe('{"a":1}');
        folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'hi', 'text');
        expect(folder.readArtifact('ws', 'r1', 'other', 1, 'output')).toBe('hi');
        expect(() => folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'hi')).toThrow(/format/);
        expect(() => folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'x'.repeat(256 * 1024 + 1), 'text')).toThrow(/256 KB/);
    });

    it('refuses a path component that is not a token', () => {
        expect(() => folder.writeDefinition('ws', '../x', {} as RunDefinition)).toThrow();
        expect(() => folder.writeArtifact('ws', 'r1', '../x', 1, 'handover', 'a')).toThrow();
        expect(() => folder.writeArtifact('ws', 'r1', 'review', 1, '../x', 'a')).toThrow();
        expect(() => folder.runDir('../ws', 'r1')).toThrow();
        expect(() => folder.attemptDir('ws', 'r1', 'review', 0)).toThrow();
        expect(() => folder.attemptDir('ws', 'r1', 'review', 1.5)).toThrow();
        expect(() => folder.writeJson(folder.attemptDir('ws', 'r1', 'review', 1), '../x' as 'command.json', {})).toThrow();
        expect(folder.attemptDir('ws', 'r1', 'step-3', 1)).toMatch(/step-3[\\/]1$/);
        expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it('refuses an artifact over 256 KB, leaving the old one', () => {
        folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', '0123456789');
        expect(() => folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x'.repeat(256 * 1024 + 1))).toThrow(/256 KB/);
        expect(folder.readArtifact('ws', 'r1', 'review', 1, 'handover')).toBe('0123456789');
    });

    it('writes command.json and outputs.json', () => {
        const dir = folder.attemptDir('ws', 'r1', 'review', 1);
        folder.writeJson(dir, 'outputs.json', { a: 1 });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'outputs.json'), 'utf8'))).toEqual({ a: 1 });
    });

    it('tails a log', () => {
        const file = path.join(folder.attemptDir('ws', 'r1', 'review', 1), 'stdout.log');
        folder.ensureEmptyFile(file);
        fs.writeFileSync(file, `${'a'.repeat(36 * 1024)}${'b'.repeat(64 * 1024)}`);
        const tail = folder.tail(file)!;
        expect(tail.truncated).toBe(true);
        expect(tail.text).toBe('b'.repeat(64 * 1024));
        expect(tail.bytes).toBe(100 * 1024);
        expect(folder.tail(file, 1024 * 1024)!.truncated).toBe(false);
        expect(folder.tail(path.join(tmp, 'missing'))).toBeNull();
    });

    it('readText returns null for a missing file and throws past maxBytes', () => {
        const file = path.join(tmp, 'f.txt');
        expect(folder.readText(file, 10)).toBeNull();
        fs.writeFileSync(file, '12345678901');
        expect(() => folder.readText(file, 10)).toThrow(/most read is 10/);
        expect(folder.readText(file, 11)).toBe('12345678901');
    });

    it('ensureEmptyFile creates a missing file with its folder and empties an existing one', () => {
        const file = path.join(tmp, 'deep', 'er', 'f.log');
        folder.ensureEmptyFile(file);
        expect(fs.readFileSync(file, 'utf8')).toBe('');
        fs.writeFileSync(file, 'data');
        folder.ensureEmptyFile(file);
        expect(fs.readFileSync(file, 'utf8')).toBe('');
    });

    it('exists', () => {
        const file = path.join(tmp, 'f');
        expect(folder.exists(file)).toBe(false);
        fs.writeFileSync(file, '');
        expect(folder.exists(file)).toBe(true);
    });

    it("sweeps runs history no longer names, never another workspace's", () => {
        for (const run of ['keep', 'drop']) folder.writeArtifact('ws', run, 'review', 1, 'handover', 'x');
        folder.writeArtifact('other', 'drop', 'review', 1, 'handover', 'x');
        folder.sweep('ws', new Set(['keep']));
        expect(fs.readdirSync(path.join(tmp, 'ws', 'runs'))).toEqual(['keep']);
        expect(fs.existsSync(path.join(tmp, 'other', 'runs', 'drop'))).toBe(true);
        expect(() => folder.sweep('never', new Set())).not.toThrow();
    });

    it('removeAll leaves factory.yml beside runs/', () => {
        fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'ws', 'factory.yml'), 'automations: []');
        folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x');
        folder.removeAll('ws');
        expect(fs.readdirSync(path.join(tmp, 'ws'))).toEqual(['factory.yml']);
    });
});

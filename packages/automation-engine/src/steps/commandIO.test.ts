import { describe, expect, it } from 'vitest';
import type { OutputType } from '@consola/factory-spec';
import type { CommandResult } from '../ports';
import { OUTPUT_FILE_CAP_BYTES, describeFailure, layerCommandEnv, parseOutputFile } from './commandIO';

const VERDICT: OutputType = { type: 'enum', values: ['approve', 'comment', 'request-changes'] };
const COUNT: OutputType = { type: 'integer' };
const NOTE: OutputType = { type: 'string', maxLength: 100 };

function failed(text: string, declared: Record<string, OutputType>): string {
    const parsed = parseOutputFile(text, declared);
    if (parsed.ok) throw new Error(`expected a problem, got ${JSON.stringify(parsed.outputs)}`);
    return parsed.problem;
}

describe('parseOutputFile', () => {
    it('reads key=value lines, ignoring blank ones', () => {
        expect(parseOutputFile('\nverdict=approve\n\n   \ncount=3\n', { verdict: VERDICT, count: COUNT })).toEqual({
            ok: true,
            outputs: { verdict: 'approve', count: 3 },
        });
    });

    it('splits at the first =, so a value may hold more', () => {
        expect(parseOutputFile('note=a=b=c\n', { note: NOTE })).toEqual({ ok: true, outputs: { note: 'a=b=c' } });
    });

    it('strips a trailing CR', () => {
        expect(parseOutputFile('verdict=comment\r\nnote=x\r\n', { verdict: VERDICT, note: NOTE })).toEqual({
            ok: true,
            outputs: { verdict: 'comment', note: 'x' },
        });
    });

    it('lets the last write win', () => {
        expect(parseOutputFile('verdict=comment\nverdict=approve\n', { verdict: VERDICT })).toEqual({
            ok: true,
            outputs: { verdict: 'approve' },
        });
    });

    it('takes an empty file when nothing is declared', () => {
        expect(parseOutputFile('', {})).toEqual({ ok: true, outputs: {} });
    });

    it('has no key<<EOF form', () => {
        expect(failed('verdict<<EOF\napprove\nEOF\n', { verdict: VERDICT })).toMatch(/line 1: expected key=value/);
    });

    it('refuses a line with no key', () => {
        expect(failed('verdict=approve\n=approve\n', { verdict: VERDICT })).toMatch(/line 2: expected key=value/);
    });

    it('refuses an undeclared key, naming the line', () => {
        const problem = failed('verdict=approve\nscore=3\n', { verdict: VERDICT });
        expect(problem).toMatch(/line 2: score is not an output of this step \(it has: verdict\)/);
        expect(failed('score=3\n', {})).toMatch(/line 1: score is not an output of this step \(it declares none\)/);
    });

    it('refuses a bad value, naming the line', () => {
        expect(failed('count=3\nverdict=maybe\n', { verdict: VERDICT, count: COUNT })).toMatch(
            /line 2: verdict: expected one of: approve, comment, request-changes \(got 'maybe'\)/,
        );
        expect(failed('count=three\n', { count: COUNT })).toMatch(/line 1: count: expected an integer/);
    });

    it('fails on a bad line even when a later one would fix it', () => {
        expect(failed('verdict=maybe\nverdict=approve\n', { verdict: VERDICT })).toMatch(/line 1: verdict/);
    });

    it('refuses a missing output, naming it', () => {
        expect(failed('verdict=approve\n', { verdict: VERDICT, count: COUNT })).toMatch(/without setting count/);
        expect(failed('', { verdict: VERDICT, count: COUNT, note: NOTE })).toMatch(/without setting verdict, count and note/);
    });

    it('holds at most 64 KB', () => {
        const declared = { note: { type: 'string', maxLength: 2 * OUTPUT_FILE_CAP_BYTES } as OutputType };
        const exactly = 'note=' + 'x'.repeat(OUTPUT_FILE_CAP_BYTES - 'note='.length);
        expect(parseOutputFile(exactly, declared).ok).toBe(true);
        expect(failed(exactly + 'x', declared)).toMatch(/over 64 KB/);
        // Bytes, not characters: 'é' is two.
        expect(failed('note=' + 'é'.repeat(OUTPUT_FILE_CAP_BYTES / 2), declared)).toMatch(/over 64 KB/);
    });
});

describe('layerCommandEnv', () => {
    it("layers the base, the rendered env:, Consola's variables, then git hooks off", () => {
        const env = layerCommandEnv(
            { PATH: '/bin', A: 'base', GH_TOKEN: 'gho_abc', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 't' },
            { A: 'rendered', CONSOLA_STEP: 'forged' },
            { CONSOLA_STEP: 'review', CONSOLA_RUN_ID: 'run-1' },
        );
        expect(env).toEqual({
            PATH: '/bin',
            A: 'rendered',
            GH_TOKEN: 'gho_abc',
            CONSOLA_STEP: 'review',
            CONSOLA_RUN_ID: 'run-1',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'user.name',
            GIT_CONFIG_VALUE_0: 't',
            GIT_CONFIG_KEY_1: 'core.hooksPath',
            GIT_CONFIG_VALUE_1: '/dev/null',
        });
    });

    it('keeps git hooks off whatever env: says', () => {
        const env = layerCommandEnv({}, { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.husky' }, {});
        expect(env.GIT_CONFIG_COUNT).toBe('1');
        expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
        expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
    });
});

describe('describeFailure', () => {
    const result = (fields: Partial<CommandResult>): CommandResult => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stopped: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        ...fields,
    });

    it('names the exit code and the last line of stderr', () => {
        expect(describeFailure(result({ exitCode: 3, lastStderrLine: 'two' }), 600_000)).toBe('exit 3: two');
        expect(describeFailure(result({ exitCode: 1 }), 600_000)).toBe('exit 1');
    });

    it('names a signal the command was killed by', () => {
        expect(describeFailure(result({ exitCode: null, signal: 'SIGKILL', lastStderrLine: 'oom' }), 600_000)).toBe('killed by SIGKILL: oom');
    });

    it('says how long a timed-out command had, as the file writes it', () => {
        const timedOut = result({ exitCode: null, signal: 'SIGTERM', timedOut: true });
        expect(describeFailure(timedOut, 600_000)).toBe('timed out after 10m');
        expect(describeFailure(timedOut, 30_000)).toBe('timed out after 30s');
        expect(describeFailure(timedOut, 90_000)).toBe('timed out after 90s');
        expect(describeFailure(timedOut, 3_600_000)).toBe('timed out after 1h');
        expect(describeFailure(timedOut, 300)).toBe('timed out after 300ms');
    });

    it('says a stopped command may have done its work', () => {
        expect(describeFailure(result({ exitCode: null, signal: 'SIGTERM', stopped: true }), 600_000)).toBe(
            'Stopped while running: it may have done its work',
        );
    });
});

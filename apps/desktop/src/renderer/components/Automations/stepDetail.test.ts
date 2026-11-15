import { describe, expect, it } from 'vitest';
import type { StepRun } from '../../../shared/automations';
import { attemptsLine, durationOf, stepHeading, variableRows } from './stepDetail';

const NOW = new Date('2026-11-12T12:00:00.000Z');

function step(overrides: Partial<StepRun> = {}): StepRun {
    return { id: 'publish', kind: 'run', status: 'completed', attempt: 1, ...overrides };
}

describe('variableRows', () => {
    it('keeps each name, its template and its rendered value, in the file order', () => {
        const rows = variableRows({
            cwd: '/work',
            command: 'gh pr review "$PR"',
            env: [
                { name: 'PR', template: '{{ item.number }}', value: '51' },
                { name: 'REPO', template: 'sprocket/catalog-portal', value: 'sprocket/catalog-portal' },
            ],
        });
        expect(rows).toEqual([
            { name: 'PR', template: '{{ item.number }}', value: '51', long: false },
            { name: 'REPO', template: 'sprocket/catalog-portal', value: 'sprocket/catalog-portal', long: false },
        ]);
    });

    it('calls a value long past 120 characters, or with a newline', () => {
        const env = (value: string) => ({ cwd: '/', command: 'x', env: [{ name: 'V', template: '{{ x }}', value }] });
        expect(variableRows(env('a'.repeat(120)))[0].long).toBe(false);
        expect(variableRows(env('a'.repeat(121)))[0].long).toBe(true);
        expect(variableRows(env('one\ntwo'))[0].long).toBe(true);
    });
});

describe('stepHeading', () => {
    it('says Would have run for a reported step', () => {
        expect(stepHeading(step({ status: 'reported' }), true)).toBe('Would have run');
    });
    it('is the step id otherwise', () => {
        expect(stepHeading(step(), false)).toBe('publish');
        expect(stepHeading(step({ status: 'failed' }), true)).toBe('publish');
    });
});

describe('attemptsLine', () => {
    it('is null for a first attempt that was not reminded', () => {
        expect(attemptsLine(step())).toBeNull();
    });
    it('counts earlier failures', () => {
        expect(attemptsLine(step({ attempt: 2, previous: [{ attempt: 1, status: 'failed' }] }))).toBe('Attempt 2 · earlier: 1 failed');
    });
    it('words an attempt that did not run as did not run, never failed', () => {
        expect(attemptsLine(step({ attempt: 2, previous: [{ attempt: 1, status: 'not-run' }] }))).toBe(
            'Attempt 2 · earlier: 1 did not run',
        );
    });
    it('lists several earlier attempts in attempt order', () => {
        expect(
            attemptsLine(
                step({
                    attempt: 4,
                    previous: [
                        { attempt: 1, status: 'failed' },
                        { attempt: 2, status: 'not-run' },
                        { attempt: 3, status: 'not-run' },
                    ],
                }),
            ),
        ).toBe('Attempt 4 · earlier: 1 failed, 2 did not run');
    });
    it('adds reminded once', () => {
        expect(attemptsLine(step({ attempt: 2, reminded: true, previous: [{ attempt: 1, status: 'failed' }] }))).toBe(
            'Attempt 2 · earlier: 1 failed · reminded once',
        );
        expect(attemptsLine(step({ reminded: true }))).toBe('Reminded once');
    });
});

describe('durationOf', () => {
    it('is the span between start and finish', () => {
        expect(durationOf(step({ startedAt: '2026-11-12T11:00:00.000Z', finishedAt: '2026-11-12T11:00:05.000Z' }), NOW)).toBe(5000);
    });
    it('runs to now while the step runs', () => {
        expect(durationOf(step({ status: 'running', startedAt: '2026-11-12T11:59:00.000Z' }), NOW)).toBe(60000);
    });
    it('is null for a step that never started, or has no end', () => {
        expect(durationOf(step({ status: 'queued' }), NOW)).toBeNull();
        expect(durationOf(step({ status: 'failed', startedAt: '2026-11-12T11:59:00.000Z' }), NOW)).toBeNull();
    });
});

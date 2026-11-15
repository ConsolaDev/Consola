import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunItem, RunRecord } from '@consola/factory-spec';
import { RunFolder } from '../node/runFolder';
import { NO_EARLIER_RUN, previousDocument, resolvePrevious } from './previous';

const PR_51: RunItem = {
    key: 'github:sprocket/catalog-portal:pr:51',
    url: 'https://github.com/sprocket/catalog-portal/pull/51',
    title: 'Add retries',
    repo: 'sprocket/catalog-portal',
    number: 51,
    type: 'pr',
};
const PR_52: RunItem = { ...PR_51, key: 'github:sprocket/catalog-portal:pr:52', url: 'https://github.com/sprocket/catalog-portal/pull/52', number: 52 };

/** A run of review-assigned-prs in ws-1: completed on #51 at 09:00 unless `changes` says otherwise. */
function runOf(id: string, changes: Partial<RunRecord> = {}, item: RunItem | null = PR_51): RunRecord {
    const at = changes.createdAt ?? '2026-11-15T09:00:00.000Z';
    return {
        id,
        runner: 'local',
        source: 'personal',
        automationId: 'review-assigned-prs',
        actionName: 'steps',
        actionVersion: 'v1',
        mode: 'auto',
        trigger: item ? { kind: 'event', at, connection: 'github', item } : { kind: 'cron', at },
        status: 'completed',
        steps: [{ id: 'review', kind: 'agent', status: 'completed', attempt: 1 }],
        attribution: { automationId: 'review-assigned-prs', actionName: 'steps', triggerKind: item ? 'event' : 'cron', workspaceId: 'ws-1' },
        createdAt: at,
        updatedAt: at,
        ...changes,
    };
}

/** This run: on #51, created at 10:00, starting its first step. */
const THIS_RUN = runOf('run-now', { status: 'running', createdAt: '2026-11-15T10:00:00.000Z' });
/** A schedule's run: no item, created at 10:00. */
const THIS_SCHEDULE = runOf('run-now', { status: 'running', createdAt: '2026-11-15T10:00:00.000Z' }, null);

const at = (hour: string) => `2026-11-15T${hour}:00:00.000Z`;

describe('resolvePrevious', () => {
    it.each<[string, RunRecord[], RunRecord, string | undefined]>([
        ['none', [], THIS_RUN, undefined],
        ['a completed run', [runOf('run-a', { createdAt: at('08') }), runOf('run-b', { createdAt: at('09') })], THIS_RUN, 'run-b'],
        ['a failed one is passed over', [runOf('run-a', { createdAt: at('08') }), runOf('run-b', { status: 'failed' })], THIS_RUN, 'run-a'],
        ['a dry run is passed over', [runOf('run-a', { createdAt: at('08') }), runOf('run-b', { dryRun: true })], THIS_RUN, 'run-a'],
        ["another item's run is not taken", [runOf('run-b', {}, PR_52)], THIS_RUN, undefined],
        ['a legacy run (no steps) is passed over', [runOf('run-a', { createdAt: at('08') }), runOf('run-b', { steps: undefined })], THIS_RUN, 'run-a'],
        ['a run created after this one is not taken', [runOf('run-a', { createdAt: at('08') }), runOf('run-b', { createdAt: at('11') })], THIS_RUN, 'run-a'],
        [
            "a schedule's last run",
            [runOf('run-a', { createdAt: at('08') }, null), runOf('run-b', {}, null), runOf('run-c', { createdAt: at('09') })],
            THIS_SCHEDULE,
            'run-b',
        ],
        [
            "another workspace's run of the same name is not taken",
            [runOf('run-b', { attribution: { ...THIS_RUN.attribution, workspaceId: 'ws-2' } })],
            THIS_RUN,
            undefined,
        ],
        ['another automation’s run is not taken', [runOf('run-b', { automationId: 'triage' })], THIS_RUN, undefined],
        [
            'created at the same moment, the lower id is the earlier',
            [runOf('run-a', { createdAt: at('10') }), runOf('run-z', { createdAt: at('10') })],
            THIS_RUN,
            'run-a',
        ],
    ])('%s', (_name, runs, run, expected) => {
        expect(resolvePrevious([...runs, run], run)?.id).toBe(expected);
    });
});

describe('previousDocument', () => {
    let tmp: string;
    let folder: RunFolder;
    const earlier = runOf('run-a');
    const read = (input: Partial<Parameters<typeof previousDocument>[0]> = {}) =>
        previousDocument({ folder, workspaceId: 'ws-1', previous: { runId: 'run-a' }, record: earlier, step: 'review', name: 'handover', file: false, ...input });

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-'));
        folder = new RunFolder((workspaceId) => path.join(tmp, workspaceId));
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it("present: the content of the step's latest attempt, or with .file its absolute file", () => {
        folder.writeArtifact('ws-1', 'run-a', 'review', 1, 'handover', 'First look.');
        folder.writeArtifact('ws-1', 'run-a', 'review', 2, 'handover', 'Line 40 retries forever.');
        expect(read()).toEqual({ value: 'Line 40 retries forever.' });
        const file = folder.artifactPath('ws-1', 'run-a', 'review', 2, 'handover');
        expect(path.isAbsolute(file)).toBe(true);
        expect(read({ file: true })).toEqual({ value: file });
    });

    it("a command's output, in whichever format it was kept", () => {
        folder.writeArtifact('ws-1', 'run-a', 'fetch', 1, 'output', '{"head":"abc"}', 'json');
        expect(read({ step: 'fetch', name: 'output', record: undefined })).toEqual({ value: '{"head":"abc"}' });
        expect(read({ step: 'fetch', name: 'output', record: undefined, file: true })).toEqual({
            value: folder.artifactPath('ws-1', 'run-a', 'fetch', 1, 'output', 'json'),
        });
    });

    it('the record says the step was skipped: it did not complete', () => {
        const skipped = runOf('run-a', { steps: [{ id: 'review', kind: 'agent', status: 'skipped', attempt: 1, skipped: 'if: false' }] });
        folder.writeArtifact('ws-1', 'run-a', 'review', 1, 'handover', 'Stale.');
        expect(read({ record: skipped })).toEqual({ absent: '`review` did not complete in the earlier run' });
        expect(read({ record: skipped, file: true })).toEqual({ absent: '`review` did not complete in the earlier run' });
    });

    it('the folder swept: it was not written', () => {
        expect(read()).toEqual({ absent: '`previous.review.handover` was not written in the earlier run' });
        expect(read({ file: true })).toEqual({ absent: '`previous.review.handover` was not written in the earlier run' });
        // The step's folder is there, the document is not.
        folder.writeArtifact('ws-1', 'run-a', 'review', 1, 'notes', 'Only notes.');
        expect(read()).toEqual({ absent: '`previous.review.handover` was not written in the earlier run' });
    });

    it('no run: there is no earlier run', () => {
        expect(NO_EARLIER_RUN).toBe('There is no earlier run of this automation on this item.');
        expect(read({ previous: undefined, record: undefined })).toEqual({ absent: NO_EARLIER_RUN });
        expect(read({ previous: undefined, record: undefined, file: true })).toEqual({ absent: NO_EARLIER_RUN });
    });

    it('a record dropped by history, its folder kept: the content (Call 31)', () => {
        folder.writeArtifact('ws-1', 'run-a', 'review', 1, 'handover', 'Kept by the sweep.');
        expect(read({ record: undefined })).toEqual({ value: 'Kept by the sweep.' });
    });
});

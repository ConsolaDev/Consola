import type { StepRun, StepRunStatus } from '@consola/factory-spec';
import type { Lane, StepUpdate } from './sequence';

/*
 * Changes to a steps run's step records, as pure functions: each returns the
 * new list, and `AutomationService` writes it.
 */

/** The lane a step's record waits in: an agent turn's, or a command's. */
export function laneOfRecord(record: Pick<StepRun, 'kind'>): Lane {
    return record.kind === 'agent' ? 'agent' : 'command';
}

/** `records` with one step's record changed. */
export function withStep(records: StepRun[], stepId: string, changes: Partial<StepRun>): StepRun[] {
    return records.map((record) => (record.id === stepId ? { ...record, ...changes } : record));
}

/** `records` with one of the sequencer's updates applied; a failure ends the step at `nowIso`. */
export function withUpdate(records: StepRun[], update: StepUpdate, nowIso: string): StepRun[] {
    const { id, ...changes } = update;
    return withStep(records, id, update.status === 'failed' ? { ...changes, finishedAt: nowIso } : changes);
}

/** What a run had not reached when it ended: not started, or waiting for a slot. */
const NOT_REACHED: readonly StepRunStatus[] = ['pending', 'queued'];

/**
 * A run's steps as it ends: `updates` applied, then every step it had not
 * reached marked `not-run` ("the run ended first"). Every path that ends a
 * steps run records its steps through this.
 */
export function closeSteps(records: StepRun[], nowIso: string, updates: StepUpdate[] = []): StepRun[] {
    const updated = updates.reduce((current, update) => withUpdate(current, update, nowIso), records);
    return updated.map((record) => (NOT_REACHED.includes(record.status) ? { ...record, status: 'not-run' } : record));
}

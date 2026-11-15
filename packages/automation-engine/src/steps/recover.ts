import type { RunRecord, StepRun } from '@consola/factory-spec';

/** What a `run:` step says when Consola quit between its intent and its result. */
export const INTERRUPTED_COMMAND =
    'Interrupted: Consola quit while this command was running. It may or may not have finished; check, then retry.';

/** What a `run:` step says when Consola quit after its command finished but before the step was settled. */
export function settleInterrupted(command: { exitCode?: number; signal?: string }): string {
    const how = command.exitCode !== undefined ? `exit ${command.exitCode}` : command.signal;
    return `Consola quit while recording this command's result (${how}). It ran; check what it did, then retry.`;
}

/** A run the engine drives: an agent run, or a `steps:` run. */
export function isEngineRun(run: RunRecord): boolean {
    const kind = (run.result as { kind?: unknown } | undefined)?.kind;
    return kind === 'agent-run' || kind === 'steps-run';
}

/** A run of a `steps:` entry: the only kind with a run folder. */
export function isStepsRun(run: RunRecord): boolean {
    return (run.result as { kind?: unknown } | undefined)?.kind === 'steps-run';
}

/**
 * What a run that was `running` at quit becomes after a restart: the recovered
 * copy, or null when nothing changes. Pure; the caller records it.
 *
 * Read-only agent work goes back to the line, to resume in its session. A
 * command that declared intent and left no result is never re-run: it may have
 * posted, pushed or moved a ticket, so the run fails and says so.
 */
export function recoverAfterRestart(run: RunRecord, nowIso: string): RunRecord | null {
    if (run.status !== 'running') return null;
    if (!isEngineRun(run)) {
        const { approval: _approval, ...rest } = run;
        return {
            ...rest,
            status: 'failed',
            error: 'Interrupted: Consola quit while this was running.',
            updatedAt: nowIso,
            finishedAt: nowIso,
        };
    }
    if (!run.steps) return { ...run, status: 'queued', updatedAt: nowIso };

    // A command is never re-queued: with intent and no result it may have run;
    // with a result it did, and only the status write was lost.
    const cut = run.steps.findIndex(commandCutOff);
    if (cut >= 0) {
        const error = commandResulted(run.steps[cut]) ? settleInterrupted(run.steps[cut].command!) : INTERRUPTED_COMMAND;
        const steps = run.steps.map((step, index): StepRun => {
            if (index === cut) return { ...step, status: 'failed', error, finishedAt: nowIso };
            if (index > cut && step.status === 'pending') return { ...step, status: 'not-run' };
            return step;
        });
        const { approval: _approval, ...rest } = run;
        return { ...rest, steps, status: 'failed', error, updatedAt: nowIso, finishedAt: nowIso };
    }

    // Anything else that was running (an agent step, or a command that never
    // declared intent) goes back to the line; the run itself stays running.
    if (!run.steps.some((step) => step.status === 'running')) return null;
    const steps = run.steps.map((step): StepRun => (step.status === 'running' ? { ...step, status: 'queued' } : step));
    return { ...run, steps };
}

function commandResulted(step: StepRun): boolean {
    return step.command?.exitCode !== undefined || step.command?.signal !== undefined;
}

/** A `run:` step that was running with intent declared, whether or not its result was recorded. */
function commandCutOff(step: StepRun): boolean {
    return step.status === 'running' && step.kind === 'run' && (!!step.command?.intentAt || commandResulted(step));
}

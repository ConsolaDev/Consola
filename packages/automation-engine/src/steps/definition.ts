import type { Step, StepRun, StepsAutomation } from '@consola/factory-spec';

/** What a steps run executes: the entry as it was approved, with every action a step names. */
export interface RunDefinition {
    automation: StepsAutomation;
    version: string;
    /**
     * By step id. `appliesTo` is kept only when the run's items may be of a
     * type the action does not apply to (a poll's with `item:`, whose check
     * says which only when it runs): a step on one of those fails.
     */
    actions: Record<string, { name: string; body: string; groupId?: string; appliesTo?: Array<'pr' | 'issue'> }>;
}

/**
 * What a `steps:` run will do, kept on its run as `result`: which steps, and
 * the item or scope it is about. Light, so history's cap never blanks an
 * approval; what each step says is in the run folder's definition.
 */
export interface StepsRunPreview {
    kind: 'steps-run';
    steps: Array<{ id: string; kind: 'agent' | 'run' }>;
    /** The item an event run is about. Title and author are the author's own text. */
    item?: { url: string; title: string; author: string; label: string };
    /** A scheduled run's scope. */
    scope?: string;
}

/** The most one artifact (and a step's `output`) may hold. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;

/** The end of a log, as stored: masked and stripped of escapes when written, so it is passed on untouched. */
export interface LogTail {
    text: string;
    /** The whole file's size. */
    bytes: number;
    /** The tail is shorter than the file. The file's own 1 MB cap is `record.command.truncated` (and `stdoutBytes`/`stderrBytes`). */
    truncated: boolean;
}

/** `command.json`: where a command ran, what it ran, and each `env:` value as its file wrote it and as it rendered. */
export interface CommandFile {
    cwd: string;
    command: string;
    env: Array<{ name: string; template: string; value: string }>;
}

/** One step's latest attempt, as the run folder holds it. Tails are the last 64 KB. */
export interface StepDetail {
    runId: string;
    step: Step;
    /** `previous` lists the earlier attempts. */
    record: StepRun;
    command?: CommandFile;
    stdout?: LogTail;
    stderr?: LogTail;
}

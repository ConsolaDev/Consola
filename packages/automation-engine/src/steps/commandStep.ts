import { parseTemplate, renderTemplate, type CommandStep, type RunRecord, type StepRun, type TemplatePath } from '@consola/factory-spec';
import type { CommandResult, CommandSpec, RunFolderPort } from '../ports';
import type { ItemSource } from '../sources/itemSource';
import { previousDocument } from '../sources/previous';
import { describeError } from '../support';
import { clipText, describeFailure, layerCommandEnv, LOG_CAP_BYTES, maskSecrets, OUTPUT_FILE_CAP_BYTES, parseOutputFile } from './commandIO';
import { MAX_ARTIFACT_BYTES, type RunDefinition } from './definition';
import { withAttemptStarted, withStep } from './stepRecords';

/*
 * A `run:` step's command: what it is given before it starts, and what its
 * result makes of its record. `AutomationService` keeps the order (render,
 * environment, command.json, intent, spawn), the record and the slots; this
 * reads and writes the run folder only through `RunFolderPort`.
 */

/** The most a step's rendered `env:` values may hold together; past it, a file is passed instead. */
export const ENV_VALUES_CAP_BYTES = 64 * 1024;
export const ENV_OVER_CAP = "env: this step's values are over 64 KB; pass a file with {{steps.<step>.<artifact>.file}} instead.";

/** Why a rendered value has none: the artifact's record says it was written, its file says otherwise. */
const GONE = 'its file is gone from the run folder';

/** The most of a parser's complaint a step's error repeats. */
const REASON_MAX_CHARS = 200;
/** Runs of control characters (newlines and escapes included), which a step's one-line error never carries. */
const CONTROLS = /[\x00-\x1f\x7f]+/g;

/** One `env:` value as `command.json` keeps it: its name, what the file says, what it rendered to. */
export interface RenderedValue {
    name: string;
    template: string;
    value: string;
}

/** A command step's attempt, decided before anything is spawned. */
export interface PreparedCommand {
    workspaceId: string;
    runId: string;
    step: CommandStep;
    attempt: number;
    cwd: string;
    /** The attempt's folder, and the files in it: `$CONSOLA_OUTPUT` and the two logs. */
    dir: string;
    files: { output: string; stdout: string; stderr: string };
    values: RenderedValue[];
    /** `CONSOLA_OUTPUT`, `CONSOLA_RUN_ID`, `CONSOLA_STEP`, an item run's `CONSOLA_CHECKOUT_HEAD`, and a poll run's `CONSOLA_ITEM_FILE`. */
    variables: Record<string, string>;
}

/** What a command's end makes of its step: how it ends, and what is recorded with it, in the same write. */
export interface CommandOutcome {
    end: { status: 'completed' } | { status: 'failed'; error: string };
    changes: Partial<StepRun>;
}

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function utf8Bytes(text: string): number {
    return new TextEncoder().encode(text).length;
}

/** An error as the middle of a sentence: its message, without the full stop. */
export function describeReason(error: unknown): string {
    return describeError(error).trim().replace(/\.$/, '');
}

/** A command runs on a POSIX host only (`run:` steps are refused on Windows), so its files join with /. */
const inFolder = (dir: string, file: string) => `${dir}/${file}`;

type Found = { value: string } | { missing: string };

interface RenderContext {
    run: RunRecord;
    definition: RunDefinition;
    /** The run's own item source (`runItemSource`): what reads its item's fields. */
    source: ItemSource | undefined;
    /** A poll run's `item.json`: the object its fields are read from. */
    polled: Record<string, unknown> | undefined;
    /** The earlier run on the item (`run.previous`), whose documents `previous.*` reads. */
    previous: { runId: string } | undefined;
    workspaceId: string;
    folder: RunFolderPort;
}

/**
 * One path's value, from the run's item, its steps' records, and their
 * documents in the run folder; a `previous` one from the earlier run's
 * folder, and the empty string when it has none (the one value whose
 * absence never fails a step).
 */
function valueOf(path: TemplatePath, { run, definition, source, polled, previous, workspaceId, folder }: RenderContext): Found {
    if (path.root === 'item') {
        const item = run.trigger.item;
        const value = item && source ? source.itemValue(item, path.field, polled) : undefined;
        return value === undefined ? { missing: 'this run has no such item field' } : { value: String(value) };
    }
    if (path.root === 'previous') {
        const document = previousDocument({ folder, workspaceId, previous, step: path.step, name: path.name, file: path.file });
        return 'value' in document ? document : { value: '' };
    }
    const record = run.steps?.find((candidate) => candidate.id === path.step);
    if (record?.status !== 'completed') return { missing: `${path.step} has not completed` };
    const written = (record.artifacts ?? []).some((artifact) => artifact.name === path.name);
    if (path.file) {
        if (!written) return { missing: `${path.step} completed without it` };
        const producer = definition.automation.steps.find((step) => step.id === path.step);
        const format = path.name === 'output' && producer?.kind === 'run' ? producer.stdout : undefined;
        const file = folder.artifactPath(workspaceId, run.id, path.step, record.attempt, path.name, format);
        return folder.exists(file) ? { value: file } : { missing: GONE };
    }
    if (record.outputs && own(record.outputs, path.name)) return { value: String(record.outputs[path.name]) };
    if (!written) return { missing: `${path.step} completed without it` };
    const content = folder.readArtifact(workspaceId, run.id, path.step, record.attempt, path.name);
    return content === null ? { missing: GONE } : { value: content };
}

/**
 * The step's `env:` filled in, each value as it rendered: an output as its
 * text, an artifact as its content (or, with `.file`, its absolute path), an
 * item field as the run has it, a `previous` document as the earlier run
 * wrote it (or empty). A value is inserted as it is, never read for
 * templates of its own. Over `ENV_VALUES_CAP_BYTES` in total is refused.
 */
function renderValues(step: CommandStep, context: RenderContext): { ok: true; values: RenderedValue[] } | { ok: false; error: string } {
    const values: RenderedValue[] = [];
    let bytes = 0;
    for (const [name, template] of Object.entries(step.env)) {
        const parsed = parseTemplate(template);
        if (!parsed.ok) return { ok: false, error: `env: ${name}: ${parsed.problem}` };
        let why: string | undefined;
        const rendered = renderTemplate(parsed.parts, (path) => {
            const found = valueOf(path, context);
            if ('missing' in found) {
                why = found.missing;
                return undefined;
            }
            return found.value;
        });
        if (!rendered.ok) return { ok: false, error: `${rendered.missing.text} has no value${why ? `: ${why}` : ''}` };
        bytes += utf8Bytes(rendered.text);
        if (bytes > ENV_VALUES_CAP_BYTES) return { ok: false, error: ENV_OVER_CAP };
        values.push({ name, template, value: rendered.text });
    }
    return { ok: true, values };
}

/**
 * A command step's current attempt, from its run's record and definition and
 * the folder it runs in (`cwd`, checked by the caller): its `env:` rendered,
 * where its files go, and Consola's variables. Reads the run folder; writes
 * nothing. `source` is the run's own (`runItemSource`), and `polled` a poll
 * run's `item.json`: what its item fields are read from. `previous` is the
 * earlier run on its item (`run.previous`): what `previous.*` reads.
 */
export function prepareCommand(input: {
    run: RunRecord;
    definition: RunDefinition;
    stepId: string;
    cwd: string;
    workspaceId: string;
    folder: RunFolderPort;
    source: ItemSource | undefined;
    polled: Record<string, unknown> | undefined;
    previous: { runId: string } | undefined;
}): { ok: true; command: PreparedCommand } | { ok: false; error: string } {
    const { run, definition, stepId, cwd, workspaceId, folder, source, polled, previous } = input;
    const step = definition.automation.steps.find((candidate) => candidate.id === stepId);
    const record = run.steps?.find((candidate) => candidate.id === stepId);
    if (step?.kind !== 'run' || !record) return { ok: false, error: `Its definition has no command step ${stepId}.` };
    try {
        const rendered = renderValues(step, { run, definition, source, polled, previous, workspaceId, folder });
        if (!rendered.ok) return rendered;
        const dir = folder.attemptDir(workspaceId, run.id, stepId, record.attempt);
        const files = { output: inFolder(dir, 'outputs.env'), stdout: inFolder(dir, 'stdout.log'), stderr: inFolder(dir, 'stderr.log') };
        const head = run.trigger.item ? run.checkout?.head : undefined;
        // A poll entry's run on an item keeps the whole object its check printed beside its definition.
        const polledFile = definition.automation.trigger.kind === 'poll' && run.trigger.item ? folder.itemPath(workspaceId, run.id) : undefined;
        const variables = {
            CONSOLA_OUTPUT: files.output,
            CONSOLA_RUN_ID: run.id,
            CONSOLA_STEP: stepId,
            ...(head ? { CONSOLA_CHECKOUT_HEAD: head } : {}),
            ...(polledFile ? { CONSOLA_ITEM_FILE: polledFile } : {}),
        };
        const { attempt } = record;
        return { ok: true, command: { workspaceId, runId: run.id, step, attempt, cwd, dir, files, values: rendered.values, variables } };
    } catch (error) {
        return { ok: false, error: `Its env: could not be read from the run folder (${describeReason(error)}).` };
    }
}

/**
 * Writes `command.json`: where it runs, what it runs, and its rendered `env:`
 * (masked by `secrets`), never the environment it starts from. Null, or why
 * it could not.
 */
export function writeCommandFile(folder: RunFolderPort, command: PreparedCommand, secrets: readonly string[]): string | null {
    const env = command.values.map((value) => ({ ...value, value: maskSecrets(value.value, secrets) }));
    try {
        folder.writeJson(command.dir, 'command.json', { cwd: command.cwd, command: command.step.run, env });
        return null;
    } catch (error) {
        return `Could not write its command.json (${describeReason(error)}); nothing ran.`;
    }
}

/** Creates its `$CONSOLA_OUTPUT` empty, so a command appending to it starts from nothing. Null, or why it could not. */
export function createOutputFile(folder: RunFolderPort, command: PreparedCommand): string | null {
    try {
        folder.ensureEmptyFile(command.files.output);
        return null;
    } catch (error) {
        return `Could not create its $CONSOLA_OUTPUT (${describeReason(error)}); nothing ran.`;
    }
}

/** What the executor is handed: the base environment, then the rendered `env:`, then Consola's variables, hooks off. */
export function commandSpec(command: PreparedCommand, base: { env: NodeJS.ProcessEnv; secrets: string[] }): CommandSpec {
    const rendered = Object.fromEntries(command.values.map(({ name, value }) => [name, value]));
    return {
        command: command.step.run,
        cwd: command.cwd,
        env: layerCommandEnv(base.env, rendered, command.variables),
        timeoutMs: command.step.timeoutMs,
        stdoutPath: command.files.stdout,
        stderrPath: command.files.stderr,
        secrets: [...base.secrets],
    };
}

/** `records` with the step's attempt running and its intent declared at `nowIso`: what is on disk before it spawns. */
export function withCommandIntent(records: StepRun[], stepId: string, nowIso: string, envNames: string[]): StepRun[] {
    return withStep(withAttemptStarted(records, stepId, nowIso), stepId, { command: { envNames, intentAt: nowIso } });
}

/** The step's command record with how it ended: its exit code or signal, and what it wrote. */
function withResult(command: StepRun['command'], result: CommandResult): NonNullable<StepRun['command']> {
    return {
        ...(command ?? { envNames: [] }),
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : result.signal !== null ? { signal: result.signal } : {}),
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        truncated: result.truncated,
    };
}

/**
 * Its stdout, from the masked log, kept as its artifact `output` in its
 * format. It must be whole and within the artifact cap, and JSON must parse.
 */
function keepStdout(
    folder: RunFolderPort,
    command: PreparedCommand,
    result: CommandResult,
    format: 'json' | 'text',
    secrets: readonly string[]
): { ok: true; bytes: number } | { ok: false; error: string } {
    let text: string | null;
    try {
        text = folder.readText(command.files.stdout, LOG_CAP_BYTES);
    } catch (error) {
        return { ok: false, error: `Could not read its stdout (${describeReason(error)}).` };
    }
    if (text === null) return { ok: false, error: 'Its stdout log is gone, so it has no output.' };
    if (utf8Bytes(text) > MAX_ARTIFACT_BYTES) {
        return { ok: false, error: `Its stdout is over ${MAX_ARTIFACT_BYTES / 1024} KB, the most an output may hold.` };
    }
    // The record says only that a log stopped short; stdout's may be the one.
    if (result.truncated) return { ok: false, error: 'Its logs were cut short, so its stdout may not be whole.' };
    if (format === 'json') {
        try {
            JSON.parse(text);
        } catch (error) {
            // The parser quotes what it read: kept on one line, masked, then clipped, so a cut never leaves part of a secret.
            const reason = describeReason(error).replace(CONTROLS, ' ');
            return { ok: false, error: `Its stdout is not JSON (${clipText(maskSecrets(reason, secrets), REASON_MAX_CHARS)}).` };
        }
    }
    try {
        const { bytes } = folder.writeArtifact(command.workspaceId, command.runId, command.step.id, command.attempt, 'output', text, format);
        return { ok: true, bytes };
    } catch (error) {
        return { ok: false, error: `Could not keep its stdout as its output (${describeReason(error)}).` };
    }
}

/**
 * What a command's result makes of its step. Success is exit 0, not timed
 * out or stopped, with valid `$CONSOLA_OUTPUT` outputs and, for `from:
 * stdout`, a stdout kept as `output`; its outputs are then written to
 * `outputs.json`. Anything else fails it. Its result is recorded either way,
 * and every error is masked, since it may repeat what the command printed.
 */
export function commandOutcome(input: {
    folder: RunFolderPort;
    command: PreparedCommand;
    record: StepRun;
    result: CommandResult;
    secrets: readonly string[];
}): CommandOutcome {
    const { folder, command, record, result, secrets } = input;
    const recorded: Partial<StepRun> = { command: withResult(record.command, result) };
    const fail = (error: string): CommandOutcome => ({ end: { status: 'failed', error: maskSecrets(error, secrets) }, changes: recorded });

    // A timeout or a stop ends it, whatever the shell's exit says.
    if (result.exitCode !== 0 || result.timedOut || result.stopped) return fail(describeFailure(result, command.step.timeoutMs));
    let written: string | null;
    try {
        written = folder.readText(command.files.output, OUTPUT_FILE_CAP_BYTES + 1);
    } catch (error) {
        return fail(`Could not read its $CONSOLA_OUTPUT (${describeReason(error)}).`);
    }
    // Masked before it is read, so no output it keeps (nor any line a problem repeats) can carry the token.
    const parsed = parseOutputFile(maskSecrets(written ?? '', secrets), command.step.outputs, secrets);
    if (!parsed.ok) return fail(parsed.problem);
    const changes: Partial<StepRun> = { ...recorded, ...(Object.keys(parsed.outputs).length > 0 ? { outputs: parsed.outputs } : {}) };
    if (command.step.stdout) {
        const kept = keepStdout(folder, command, result, command.step.stdout, secrets);
        if (!kept.ok) return fail(kept.error);
        changes.artifacts = [{ name: 'output', bytes: kept.bytes }];
    }
    try {
        folder.writeJson(command.dir, 'outputs.json', parsed.outputs);
    } catch (error) {
        return fail(`Could not write its outputs: ${describeReason(error)}.`);
    }
    return { end: { status: 'completed' }, changes };
}

/** The step's command record for a command that never started: no intent left on it, since nothing ran. */
export function neverStarted(command: StepRun['command']): NonNullable<StepRun['command']> {
    const { intentAt: _intentAt, ...rest } = command ?? { envNames: [] };
    return rest;
}

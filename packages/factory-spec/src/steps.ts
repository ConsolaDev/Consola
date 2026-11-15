/**
 * `steps:` — the per-step schema. Each step is checked on its own here: its
 * keys, its shapes, its patterns. What only a whole entry can answer (does an
 * `if:` name a step that has run, is a handover read that nobody writes) is
 * the next layer's business.
 *
 * Written in the style of `runSchema`: explicit key checks, each issue
 * pointing at the key it is about, so a refusal can say why.
 */
import { z } from 'zod';
import { MAX_IF_LENGTH, parseExpression } from './expression';
import type { OutputType } from './outputs';
import { hasTemplateBraces, parseTemplate } from './template';

export const STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const ARTIFACT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_STEPS = 20;
export const MAX_OUTPUTS = 10;
export const DEFAULT_STRING_MAX = 1000;
export const STRING_MAX_CEILING = 4000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;

interface StepCommon {
    id: string;
    /** The id was written in the file (only these can be referenced). */
    named: boolean;
    if?: string;
}

export interface AgentStep extends StepCommon {
    kind: 'agent';
    prompt?: string;
    action?: string;
    outputs: Record<string, OutputType>;
    artifacts: string[];
    reads: string[];
    handover: 'required' | 'optional';
}

export interface CommandStep extends StepCommon {
    kind: 'run';
    run: string;
    env: Record<string, string>;
    outputs: Record<string, OutputType>;
    stdout?: 'json' | 'text';
    timeoutMs: number;
    dryRun: 'report' | 'run';
}

export type Step = AgentStep | CommandStep;

/**
 * Keys a later slice owns, with what each arrives with. One table for steps
 * and entries: a refusal, not an ignore, since an ignored `gate:` would run
 * the step it guards.
 */
export const LATER_KEYS: Record<string, string> = {
    agent: 'agents as files',
    skills: 'agents as files',
    mcpServers: 'agents as files',
    max_turns: 'agents as files',
    gate: 'write steps',
    repeat: 'write steps',
    on_exhausted: 'write steps',
    then: 'write steps',
    on_failure: 'write steps',
    checkout: 'write steps',
    environment: 'write steps',
    budget: 'write steps',
    wait: 'waiting runs',
    concurrency: 'waiting runs',
    uses: 'connections as data',
    with: 'connections as data',
    secrets: 'connections as data',
    callable: 'callable automations',
    inputs: 'callable automations',
};

export function laterKeyMessage(key: string): string {
    return `\`${key}\` arrives with ${LATER_KEYS[key]}; it is not supported yet.`;
}

const COMMON_KEYS = ['id', 'if'];
const AGENT_KEYS = ['prompt', 'action', 'outputs', 'artifacts', 'reads'];
const COMMAND_KEYS = ['run', 'env', 'outputs', 'timeout', 'dry_run'];
const ALL_KEYS = new Set([...COMMON_KEYS, ...AGENT_KEYS, ...COMMAND_KEYS]);
const ONE_OF = ['prompt', 'action', 'run'] as const;

/** Outputs and artifacts share a namespace; these two names are taken before either is declared. */
const RESERVED_OUTPUT_NAMES = ['handover', 'output'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Fail = (message: string, path?: Array<string | number>) => void;

// --- outputs ---------------------------------------------------------------------

const NO_COMPLEX_OUTPUTS = 'An output is an enum, integer, number, boolean or string: no objects, arrays or nulls.';

function parseOutputType(name: string, value: unknown, fail: Fail): OutputType | undefined {
    const at = ['outputs', name];
    if (typeof value === 'string') {
        if (value === 'integer' || value === 'number' || value === 'boolean') return { type: value };
        if (value === 'string') return { type: 'string', maxLength: DEFAULT_STRING_MAX };
        fail(
            value === 'object' || value === 'array' || value === 'null'
                ? NO_COMPLEX_OUTPUTS
                : `\`${value}\` is not an output type. Use integer, number, boolean, string, or \`{ enum: [...] }\`.`,
            at
        );
        return undefined;
    }
    if (!isRecord(value)) {
        fail(`Expected a type for \`${name}\`: integer, number, boolean, string, or \`{ enum: [...] }\`. ${NO_COMPLEX_OUTPUTS}`, at);
        return undefined;
    }
    const keys = Object.keys(value);
    if ('enum' in value) {
        const extra = keys.filter((key) => key !== 'enum');
        if (extra.length > 0) {
            fail(`An enum takes no \`${extra[0]}\`; write \`{ enum: [a, b] }\`.`, [...at, extra[0]]);
            return undefined;
        }
        const values = value.enum;
        if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
            fail('An enum lists 1 to 20 values.', [...at, 'enum']);
            return undefined;
        }
        const seen = new Set<string>();
        for (const entry of values) {
            if (typeof entry !== 'string' || entry.length < 1 || entry.length > 64 || /[\r\n]/.test(entry)) {
                fail('An enum value is 1 to 64 characters of text, with no line breaks.', [...at, 'enum']);
                return undefined;
            }
            if (seen.has(entry)) {
                fail(`\`${entry}\` is listed twice in the enum.`, [...at, 'enum']);
                return undefined;
            }
            seen.add(entry);
        }
        return { type: 'enum', values: [...values] as string[] };
    }
    const type = value.type;
    if (type === 'integer' || type === 'number') {
        const extra = keys.filter((key) => !['type', 'minimum', 'maximum'].includes(key));
        if (extra.length > 0) {
            fail(`\`${extra[0]}\` is not a key of ${type}; it takes \`minimum\` and \`maximum\`.`, [...at, extra[0]]);
            return undefined;
        }
        const bound = (key: 'minimum' | 'maximum'): number | undefined | null => {
            if (!(key in value)) return undefined;
            const given = value[key];
            if (typeof given === 'number' && Number.isFinite(given)) return given;
            fail(`Expected \`${key}\` to be a number.`, [...at, key]);
            return null;
        };
        const minimum = bound('minimum');
        const maximum = bound('maximum');
        if (minimum === null || maximum === null) return undefined;
        if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
            fail('`minimum` is above `maximum`.', [...at, 'minimum']);
            return undefined;
        }
        return {
            type,
            ...(minimum !== undefined ? { minimum } : {}),
            ...(maximum !== undefined ? { maximum } : {}),
        };
    }
    if (type === 'boolean') {
        const extra = keys.filter((key) => key !== 'type');
        if (extra.length > 0) {
            fail(`A boolean takes no \`${extra[0]}\`.`, [...at, extra[0]]);
            return undefined;
        }
        return { type: 'boolean' };
    }
    if (type === 'string') {
        const extra = keys.filter((key) => !['type', 'maxLength'].includes(key));
        if (extra.length > 0) {
            fail(`\`${extra[0]}\` is not a key of string; it takes \`maxLength\`.`, [...at, extra[0]]);
            return undefined;
        }
        if (!('maxLength' in value)) return { type: 'string', maxLength: DEFAULT_STRING_MAX };
        const max = value.maxLength;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > STRING_MAX_CEILING) {
            fail(`\`maxLength\` is a whole number from 1 to ${STRING_MAX_CEILING}.`, [...at, 'maxLength']);
            return undefined;
        }
        return { type: 'string', maxLength: max };
    }
    fail(
        type === 'object' || type === 'array' || type === 'null' || type === undefined
            ? NO_COMPLEX_OUTPUTS
            : `\`${String(type)}\` is not an output type. Use integer, number, boolean, string, or \`{ enum: [...] }\`.`,
        type === undefined ? at : [...at, 'type']
    );
    return undefined;
}

/** The declared outputs; null when any was refused. */
function parseOutputs(raw: unknown, fail: Fail): Record<string, OutputType> | null {
    if (!isRecord(raw)) {
        fail('Expected `outputs` to be a mapping of name to type.', ['outputs']);
        return null;
    }
    const names = Object.keys(raw);
    if (names.length > MAX_OUTPUTS) {
        fail(`A step declares at most ${MAX_OUTPUTS} outputs.`, ['outputs']);
        return null;
    }
    const outputs: Record<string, OutputType> = {};
    let ok = true;
    for (const name of names) {
        if (RESERVED_OUTPUT_NAMES.includes(name)) {
            fail(`\`${name}\` is reserved: a step's handover and its \`output\` are artifacts, read as \`steps.<id>.${name}\`.`, ['outputs', name]);
            ok = false;
        } else if (!OUTPUT_NAME_PATTERN.test(name)) {
            fail('Use lowercase letters, digits and underscores, starting with a letter, e.g. verdict.', ['outputs', name]);
            ok = false;
        } else {
            const type = parseOutputType(name, raw[name], fail);
            if (type) outputs[name] = type;
            else ok = false;
        }
    }
    return ok ? outputs : null;
}

// --- one step --------------------------------------------------------------------

const TIMEOUT_FORMAT = 'Write the timeout as `<n>s`, `<n>m` or `<n>h`, e.g. `10m`.';

function parseTimeout(value: unknown, fail: Fail): number | null {
    const match = typeof value === 'string' ? /^(\d+)([smh])$/.exec(value.trim()) : null;
    if (!match) {
        fail(TIMEOUT_FORMAT, ['timeout']);
        return null;
    }
    const ms = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
    if (ms < 1000) {
        fail('A timeout is at least 1s.', ['timeout']);
        return null;
    }
    if (ms > MAX_COMMAND_TIMEOUT_MS) {
        fail('A timeout is at most 1h.', ['timeout']);
        return null;
    }
    return ms;
}

/** Text with `{{ path }}` in it must parse; which paths are allowed is checked with the whole entry. */
function checkTemplate(text: string, path: Array<string | number>, fail: Fail): boolean {
    const parsed = parseTemplate(text);
    if (parsed.ok) return true;
    fail(parsed.problem[0].toUpperCase() + parsed.problem.slice(1) + '.', path);
    return false;
}

function parseStep(raw: unknown, index: number, fail: Fail): Step | null {
    const failAt: Fail = (message, path = []) => fail(message, [index, ...path]);
    if (!isRecord(raw)) {
        failAt('Expected a step: a mapping with one of `prompt`, `action` or `run`.');
        return null;
    }
    let ok = true;
    const bad: Fail = (message, path) => {
        ok = false;
        failAt(message, path);
    };

    // Keys: later slices', then strangers.
    for (const key of Object.keys(raw)) {
        if (ALL_KEYS.has(key)) continue;
        if (key === 'inputs') bad('`inputs` is not a step key: use `reads` to name what an earlier step wrote.', [key]);
        else if (key in LATER_KEYS) bad(laterKeyMessage(key), [key]);
        else bad(`Unrecognized key in a step: ${key}.`, [key]);
    }

    const present = ONE_OF.filter((key) => key in raw);
    if (present.length !== 1) {
        bad(
            present.length === 0
                ? 'A step has one of `prompt`, `action` or `run`.'
                : `A step names one thing to do; got ${present.join(' and ')}.`
        );
        return null;
    }
    const [kind] = present;

    // Id.
    let id = `step-${index + 1}`;
    let named = false;
    if ('id' in raw) {
        const given = raw.id;
        if (typeof given !== 'string' || !STEP_ID_PATTERN.test(given)) {
            bad('Use lowercase letters, digits and dashes, starting with a letter, e.g. review.', ['id']);
        } else if (/^step-\d+$/.test(given)) {
            bad(`\`step-<n>\` is what an unnamed step is called; name this one for what it does, e.g. \`id: review\`.`, ['id']);
        } else if (given === 'previous') {
            bad('`previous` is reserved for the last run on the same item.', ['id']);
        } else {
            id = given;
            named = true;
        }
    }

    // if:
    let condition: string | undefined;
    if ('if' in raw) {
        const given = raw.if;
        if (typeof given !== 'string') {
            bad('Expected `if` to be an expression in quotes, e.g. `if: "steps.review.verdict != \'approve\'"`.', ['if']);
        } else if (given.length > MAX_IF_LENGTH) {
            bad(`An \`if\` is at most ${MAX_IF_LENGTH} characters.`, ['if']);
        } else {
            const parsed = parseExpression(given);
            if (!parsed.ok) bad(`Cannot read this \`if\`: ${parsed.problem}.`, ['if']);
            else condition = given;
        }
    }

    // outputs (a command may name its stdout instead).
    let outputs: Record<string, OutputType> = {};
    let stdout: 'json' | 'text' | undefined;
    if ('outputs' in raw) {
        const given = raw.outputs;
        if (kind === 'run' && isRecord(given) && given.from === 'stdout') {
            const extra = Object.keys(given).filter((key) => key !== 'from' && key !== 'format');
            if (extra.length > 0) bad(`\`${extra[0]}\` is not a key here; write \`{ from: stdout, format: json }\`.`, ['outputs', extra[0]]);
            const format = 'format' in given ? given.format : 'text';
            if (format !== 'json' && format !== 'text') bad('Expected `format` to be `json` or `text`.', ['outputs', 'format']);
            else stdout = format;
        } else {
            const declared = parseOutputs(given, (message, path) => bad(message, path));
            if (declared) outputs = declared;
        }
    }

    if (kind === 'run') {
        for (const key of AGENT_KEYS.filter((key) => key !== 'outputs' && key in raw)) {
            bad(
                key === 'artifacts'
                    ? 'Artifacts are an agent step\'s documents: a command writes no artifacts; it passes data on as outputs, or `outputs: { from: stdout, format: json }`.'
                    : `\`${key}\` is for an agent step; a command takes what it needs through \`env\`.`,
                [key]
            );
        }
        const run = raw.run;
        if (typeof run !== 'string' || !run.trim()) {
            bad('Expected the command to run, e.g. `run: gh pr view "$PR"`.', ['run']);
        } else if (hasTemplateBraces(run)) {
            const found = /\{\{[^}]*\}\}/.exec(run)?.[0] ?? '{{';
            bad(`Values reach a command only as environment variables: move \`${found}\` into \`env:\` and use \`"$PR"\`.`, ['run']);
        }
        const env: Record<string, string> = {};
        if ('env' in raw) {
            if (!isRecord(raw.env)) bad('Expected `env` to be a mapping of NAME to text.', ['env']);
            else {
                for (const [name, value] of Object.entries(raw.env)) {
                    if (name.startsWith('CONSOLA_')) {
                        bad('`CONSOLA_` is Consola\'s own namespace; pick another name.', ['env', name]);
                    } else if (!ENV_NAME_PATTERN.test(name)) {
                        bad('Use uppercase letters, digits and underscores, e.g. PR_NUMBER.', ['env', name]);
                    } else if (typeof value !== 'string') {
                        bad('Expected text, e.g. "{{item.number}}".', ['env', name]);
                    } else if (checkTemplate(value, ['env', name], (message, path) => bad(message, path))) {
                        env[name] = value;
                    }
                }
            }
        }
        const timeoutMs = 'timeout' in raw ? parseTimeout(raw.timeout, (message, path) => bad(message, path)) : DEFAULT_COMMAND_TIMEOUT_MS;
        let dryRun: 'report' | 'run' = 'report';
        if ('dry_run' in raw) {
            if (raw.dry_run === 'report' || raw.dry_run === 'run') dryRun = raw.dry_run;
            else bad('Expected `dry_run` to be `report` or `run`.', ['dry_run']);
        }
        if (!ok || typeof run !== 'string' || timeoutMs === null) return null;
        return {
            id,
            named,
            ...(condition !== undefined ? { if: condition } : {}),
            kind: 'run',
            run,
            env,
            outputs,
            ...(stdout ? { stdout } : {}),
            timeoutMs,
            dryRun,
        };
    }

    // An agent step.
    for (const key of ['env', 'timeout', 'dry_run'].filter((key) => key in raw)) {
        bad(`\`${key}\` is for a command (\`run:\`); an agent step does not take it.`, [key]);
    }
    const text = raw[kind];
    if (typeof text !== 'string' || !text.trim()) {
        bad(kind === 'action' ? 'Expected an action name, e.g. `action: Review`.' : 'Expected the prompt to send.', [kind]);
    } else if (kind === 'prompt') {
        checkTemplate(text, ['prompt'], (message, path) => bad(message, path));
    }

    let handover: 'required' | 'optional' = 'optional';
    const artifacts: string[] = [];
    if ('artifacts' in raw) {
        if (!Array.isArray(raw.artifacts)) bad('Expected `artifacts` to be a list of names.', ['artifacts']);
        else {
            for (const name of raw.artifacts) {
                if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) {
                    bad('Use lowercase letters, digits and dashes, starting with a letter, e.g. notes.', ['artifacts']);
                } else if (name === 'output') {
                    bad('`output` is reserved for a command\'s stdout; name this document something else.', ['artifacts']);
                } else if (name === 'handover') {
                    handover = 'required';
                } else if (artifacts.includes(name)) {
                    bad(`\`${name}\` is listed twice.`, ['artifacts']);
                } else if (name in outputs) {
                    bad(`\`${name}\` is both an output and an artifact: they share one namespace, read as \`steps.<id>.${name}\`.`, ['artifacts']);
                } else {
                    artifacts.push(name);
                }
            }
        }
    }

    const reads: string[] = [];
    if ('reads' in raw) {
        if (!Array.isArray(raw.reads)) bad('Expected `reads` to be a list of `<step>.<artifact>` names.', ['reads']);
        else {
            for (const entry of raw.reads) {
                const match = typeof entry === 'string' ? /^([^.\s]+)\.([^.\s]+)$/.exec(entry) : null;
                if (typeof entry === 'string' && entry.startsWith('previous.')) {
                    bad('`previous` (what the last run on this item wrote) is not supported yet.', ['reads']);
                } else if (!match) bad('Name what to read as `<step>.<artifact>`, e.g. `review.handover`.', ['reads']);
                else if (!STEP_ID_PATTERN.test(match[1]) || !ARTIFACT_NAME_PATTERN.test(match[2])) {
                    bad(`\`${entry as string}\` is not a step and one of its documents, e.g. \`review.handover\`.`, ['reads']);
                } else if (reads.includes(entry as string)) bad(`\`${entry as string}\` is listed twice.`, ['reads']);
                else reads.push(entry as string);
            }
        }
    }

    if (!ok || typeof text !== 'string') return null;
    return {
        id,
        named,
        ...(condition !== undefined ? { if: condition } : {}),
        kind: 'agent',
        ...(kind === 'prompt' ? { prompt: text } : { action: text.trim() }),
        outputs,
        artifacts,
        reads,
        handover,
    };
}

/** `steps:` — 1 to 20 steps, each checked on its own; ids are unique across them. */
export function stepsSchema(): z.ZodType<Step[], z.ZodTypeDef, unknown> {
    return z.unknown().transform((raw, ctx): Step[] => {
        const fail: Fail = (message, path = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) {
            fail(`An entry with \`steps:\` has 1 to ${MAX_STEPS} steps, written as a list.`);
            return z.NEVER;
        }
        let ok = true;
        const steps: Array<{ step: Step; index: number }> = [];
        raw.forEach((entry, index) => {
            const step = parseStep(entry, index, (message, path) => {
                ok = false;
                fail(message, path);
            });
            if (step) steps.push({ step, index });
            else ok = false;
        });
        const seen = new Set<string>();
        steps.forEach(({ step, index }) => {
            if (seen.has(step.id)) {
                ok = false;
                fail(`Step ids are unique; \`${step.id}\` is used twice.`, [index, 'id']);
            }
            seen.add(step.id);
        });
        return ok ? steps.map(({ step }) => step) : z.NEVER;
    });
}

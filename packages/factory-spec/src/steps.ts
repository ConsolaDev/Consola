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
import {
  checkExpression,
  expressionPaths,
  MAX_IF_LENGTH,
  parseExpression,
  type Expr,
  type ExprType,
  type ExpressionScope,
} from './expression';
import type { OutputType } from './outputs';
import { hasTemplateBraces, parseTemplate, templatePaths, type TemplatePath } from './template';

export const STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const ARTIFACT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `env:` names that make a program run a value: a shell sources a file or runs
 * a string, git or ssh starts a program, a loader or runtime loads code, or
 * the value picks which program runs. `BASH_ENV: "{{steps.review.handover.file}}"`
 * would have bash source a file an agent wrote from a pull request's text.
 * Refused outright, templated or not: a value must stay data, and a command
 * that needs one sets it inside `run:`, where it reads as the code it is.
 *
 * A denylist cannot name every such variable, so it says only what it
 * refuses: these exact names, every name with one of `REFUSED_ENV_PREFIXES`
 * but `ENV_PREFIX_EXCEPTIONS`. Names a prefix covers are not repeated here.
 */
export const REFUSED_ENV_NAMES = [
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS4',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'HOME',
  'ZDOTDIR',
  'SSH_ASKPASS',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'BROWSER',
  'LESSOPEN',
  'LESSCLOSE',
  'GCONV_PATH',
  '_JAVA_OPTIONS',
  'PATH',
] as const;

/**
 * Prefixes `env:` refuses every name with: loaders (`LD_`, `DYLD_`), runtimes
 * (`PYTHON`, `PERL`, `RUBY`, `NODE_`, `JAVA_`, `NPM_CONFIG_`), where programs
 * find their configuration (`XDG_`), and git's and gh's own (`GIT_`, `GH_`).
 * `NPM_CONFIG_` matches in any case, as npm reads `npm_config_*` too; the
 * rest match as written. (Git's `GIT_CONFIG_COUNT` from the login
 * environment still reaches a command; the engine appends its hooks-off
 * entry after it.)
 */
export const REFUSED_ENV_PREFIXES = [
  'LD_',
  'DYLD_',
  'PYTHON',
  'PERL',
  'RUBY',
  'NODE_',
  'JAVA_',
  'NPM_CONFIG_',
  'XDG_',
  'GIT_',
  'GH_',
] as const;

/** Names a refused prefix lets through: gh's token and host are data. */
export const ENV_PREFIX_EXCEPTIONS = ['GH_TOKEN', 'GH_HOST'] as const;

/** Prefixes matched in any case. */
const CASELESS_ENV_PREFIXES: ReadonlySet<string> = new Set(['NPM_CONFIG_']);

/** Whether `env:` refuses a name: one of `REFUSED_ENV_NAMES`, or a refused prefix's that is not an exception. */
export function isRefusedEnvName(name: string): boolean {
  if ((REFUSED_ENV_NAMES as readonly string[]).includes(name)) return true;
  if ((ENV_PREFIX_EXCEPTIONS as readonly string[]).includes(name)) return false;
  return REFUSED_ENV_PREFIXES.some((prefix) =>
    CASELESS_ENV_PREFIXES.has(prefix)
      ? name.toUpperCase().startsWith(prefix)
      : name.startsWith(prefix),
  );
}

/** What `env:` refuses, as its refusal lists it. */
const REFUSED_ENV_LIST =
  `${REFUSED_ENV_NAMES.join(', ')}, and every name matching ${REFUSED_ENV_PREFIXES.map((prefix) => `${prefix}*`).join(', ')} ` +
  `(${ENV_PREFIX_EXCEPTIONS.join(' and ')} are allowed)`;

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
export const LATER_KEYS: Readonly<Record<string, string>> = {
  agent: 'agents as files',
  skills: 'agents as files',
  mcpServers: 'agents as files',
  max_turns: 'agents as files',
  gate: 'write steps',
  repeat: 'write steps',
  on_exhausted: 'write steps',
  // biome-ignore lint/suspicious/noThenProperty: `then:` is a factory.yml key; this table is never awaited.
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

const NO_COMPLEX_OUTPUTS =
  'An output is an enum, integer, number, boolean or string: no objects, arrays or nulls.';

function parseOutputType(name: string, value: unknown, fail: Fail): OutputType | undefined {
  const at = ['outputs', name];
  if (typeof value === 'string') {
    if (value === 'integer' || value === 'number' || value === 'boolean') return { type: value };
    if (value === 'string') return { type: 'string', maxLength: DEFAULT_STRING_MAX };
    fail(
      value === 'object' || value === 'array' || value === 'null'
        ? NO_COMPLEX_OUTPUTS
        : `\`${value}\` is not an output type. Use integer, number, boolean, string, or \`{ enum: [...] }\`.`,
      at,
    );
    return undefined;
  }
  if (!isRecord(value)) {
    fail(
      `Expected a type for \`${name}\`: integer, number, boolean, string, or \`{ enum: [...] }\`. ${NO_COMPLEX_OUTPUTS}`,
      at,
    );
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
      if (
        typeof entry !== 'string' ||
        entry.length < 1 ||
        entry.length > 64 ||
        /[\r\n]/.test(entry)
      ) {
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
      fail(`\`${extra[0]}\` is not a key of ${type}; it takes \`minimum\` and \`maximum\`.`, [
        ...at,
        extra[0],
      ]);
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
      fail(`\`maxLength\` is a whole number from 1 to ${STRING_MAX_CEILING}.`, [
        ...at,
        'maxLength',
      ]);
      return undefined;
    }
    return { type: 'string', maxLength: max };
  }
  fail(
    type === 'object' || type === 'array' || type === 'null' || type === undefined
      ? NO_COMPLEX_OUTPUTS
      : `\`${String(type)}\` is not an output type. Use integer, number, boolean, string, or \`{ enum: [...] }\`.`,
    type === undefined ? at : [...at, 'type'],
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
      fail(
        `\`${name}\` is reserved: a step's handover and its \`output\` are artifacts, read as \`steps.<id>.${name}\`.`,
        ['outputs', name],
      );
      ok = false;
    } else if (!OUTPUT_NAME_PATTERN.test(name)) {
      fail('Use lowercase letters, digits and underscores, starting with a letter, e.g. verdict.', [
        'outputs',
        name,
      ]);
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
    if (key === 'inputs')
      bad('`inputs` is not a step key: use `reads` to name what an earlier step wrote.', [key]);
    else if (Object.prototype.hasOwnProperty.call(LATER_KEYS, key))
      bad(laterKeyMessage(key), [key]);
    else bad(`Unrecognized key in a step: ${key}.`, [key]);
  }

  const present = ONE_OF.filter((key) => key in raw);
  if (present.length !== 1) {
    bad(
      present.length === 0
        ? 'A step has one of `prompt`, `action` or `run`.'
        : `A step names one thing to do; got ${present.join(' and ')}.`,
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
      bad(
        `\`step-<n>\` is what an unnamed step is called; name this one for what it does, e.g. \`id: review\`.`,
        ['id'],
      );
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
      bad(
        'Expected `if` to be an expression in quotes, e.g. `if: "steps.review.verdict != \'approve\'"`.',
        ['if'],
      );
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
      if (extra.length > 0)
        bad(`\`${extra[0]}\` is not a key here; write \`{ from: stdout, format: json }\`.`, [
          'outputs',
          extra[0],
        ]);
      const format = given.format;
      if (format !== 'json' && format !== 'text') {
        bad('Say how to read stdout: `format: json` or `format: text`.', ['outputs', 'format']);
      } else stdout = format;
    } else {
      const declared = parseOutputs(given, (message, path) => bad(message, path));
      if (declared) outputs = declared;
    }
  }

  if (kind === 'run') {
    for (const key of AGENT_KEYS.filter((key) => key !== 'outputs' && key in raw)) {
      bad(
        key === 'artifacts'
          ? "Artifacts are an agent step's documents: a command writes no artifacts; it passes data on as outputs, or `outputs: { from: stdout, format: json }`."
          : `\`${key}\` is for an agent step; a command takes what it needs through \`env\`.`,
        [key],
      );
    }
    const run = raw.run;
    if (typeof run !== 'string' || !run.trim()) {
      bad('Expected the command to run, e.g. `run: gh pr view "$PR"`.', ['run']);
    } else if (hasTemplateBraces(run)) {
      const found = /\{\{[^}]*\}\}/.exec(run)?.[0] ?? '{{';
      bad(
        `Values reach a command only as environment variables: move \`${found}\` into \`env:\` and use \`"$PR"\`.`,
        ['run'],
      );
    }
    const env: Record<string, string> = {};
    if ('env' in raw) {
      if (!isRecord(raw.env)) bad('Expected `env` to be a mapping of NAME to text.', ['env']);
      else {
        for (const [name, value] of Object.entries(raw.env)) {
          if (name.startsWith('CONSOLA_')) {
            bad("`CONSOLA_` is Consola's own namespace; pick another name.", ['env', name]);
          } else if (!ENV_NAME_PATTERN.test(name)) {
            bad('Use uppercase letters, digits and underscores, e.g. PR_NUMBER.', ['env', name]);
          } else if (isRefusedEnvName(name)) {
            bad(
              `\`${name}\` is refused: these names and prefixes are refused because they make a program run a value: ${REFUSED_ENV_LIST}. ` +
                'Values must stay data; set it inside `run:` if the command needs it.',
              ['env', name],
            );
          } else if (typeof value !== 'string') {
            bad('Expected text, e.g. "{{item.number}}".', ['env', name]);
          } else if (checkTemplate(value, ['env', name], (message, path) => bad(message, path))) {
            env[name] = value;
          }
        }
      }
    }
    const timeoutMs =
      'timeout' in raw
        ? parseTimeout(raw.timeout, (message, path) => bad(message, path))
        : DEFAULT_COMMAND_TIMEOUT_MS;
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
    bad(
      kind === 'action'
        ? 'Expected an action name, e.g. `action: Review`.'
        : 'Expected the prompt to send.',
      [kind],
    );
  } else if (kind === 'prompt') {
    checkTemplate(text, ['prompt'], (message, path) => bad(message, path));
  }

  let handover: 'required' | 'optional' = 'optional';
  const artifacts: string[] = [];
  if ('artifacts' in raw) {
    if (!Array.isArray(raw.artifacts))
      bad('Expected `artifacts` to be a list of names.', ['artifacts']);
    else {
      for (const name of raw.artifacts) {
        if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) {
          bad('Use lowercase letters, digits and dashes, starting with a letter, e.g. notes.', [
            'artifacts',
          ]);
        } else if (name === 'output') {
          bad("`output` is reserved for a command's stdout; name this document something else.", [
            'artifacts',
          ]);
        } else if (name === 'handover') {
          handover = 'required';
        } else if (artifacts.includes(name)) {
          bad(`\`${name}\` is listed twice.`, ['artifacts']);
        } else if (Object.prototype.hasOwnProperty.call(outputs, name)) {
          bad(
            `\`${name}\` is both an output and an artifact: they share one namespace, read as \`steps.<id>.${name}\`.`,
            ['artifacts'],
          );
        } else {
          artifacts.push(name);
        }
      }
    }
  }

  const reads: string[] = [];
  if ('reads' in raw) {
    if (!Array.isArray(raw.reads))
      bad('Expected `reads` to be a list of `<step>.<artifact>` names.', ['reads']);
    else {
      for (const entry of raw.reads) {
        const match = typeof entry === 'string' ? /^([^.\s]+)\.([^.\s]+)$/.exec(entry) : null;
        if (typeof entry === 'string' && entry.startsWith('previous.')) {
          bad('`previous` (what the last run on this item wrote) is not supported yet.', ['reads']);
        } else if (!match)
          bad('Name what to read as `<step>.<artifact>`, e.g. `review.handover`.', ['reads']);
        else if (!STEP_ID_PATTERN.test(match[1]) || !ARTIFACT_NAME_PATTERN.test(match[2])) {
          bad(
            `\`${entry as string}\` is not a step and one of its documents, e.g. \`review.handover\`.`,
            ['reads'],
          );
        } else if (reads.includes(entry as string))
          bad(`\`${entry as string}\` is listed twice.`, ['reads']);
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
export function stepsSchema(): z.ZodType<Step[], unknown> {
  return z.unknown().transform((raw, ctx): Step[] => {
    const fail: Fail = (message, path = []) => ctx.addIssue({ code: 'custom', message, path });
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

// --- across steps ------------------------------------------------------------------

/** What a connection says about one item field. */
export interface ItemField {
  type: ExprType;
  trusted: boolean;
}
export type ItemFieldTable = Record<string, ItemField>;

/** The item fields every connection gives, and so the ones a prompt may template without asking. */
const TRUSTED_ITEM_FIELDS = ['key', 'url', 'repo', 'number', 'type'];

const SCHEDULE_HAS_NO_ITEM = 'a schedule has no item, so there is no `item` to read';
const UNNAMED = (id: string) =>
  `\`${id}\` is an unnamed step; only steps with an \`id\` can be named`;
const UNTRUSTED = (path: string) =>
  `${path}: it is text someone else wrote; the step gets it below its prompt as data.`;

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function exprTypeOf(type: OutputType, step: string, name: string): ExprType {
  switch (type.type) {
    case 'enum':
      return { kind: 'string', enum: { values: type.values, owner: `${name} of ${step}` } };
    case 'string':
      return { kind: 'string' };
    case 'integer':
    case 'number':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
  }
}

/** The documents a step writes: its declared artifacts and handover, or a command's stdout. */
function artifactsOf(step: Step): string[] {
  return step.kind === 'agent' ? ['handover', ...step.artifacts] : step.stdout ? ['output'] : [];
}

type Lookup = { step: Step } | { problem: string };

/** The earlier step an id names, or why it cannot be named from step `index`. */
function earlierStep(steps: Step[], id: string, index: number): Lookup {
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) return { problem: `there is no step \`${id}\`` };
  if (!steps[at].named) return { problem: UNNAMED(id) };
  if (at >= index) {
    return {
      problem: `\`${id}\` is not before this step: it is ${at === index ? 'this step' : 'a later step'}, so it has not run when this one's turn comes`,
    };
  }
  return { step: steps[at] };
}

function listed(names: string[]): string {
  return names.length > 0 ? `it has: ${names.join(', ')}` : 'it has none';
}

/**
 * Everything that looks across steps: each `if:`, `reads:`, `env:` value and
 * prompt is resolved against the steps before it. Also sets a handover
 * `required` when a later step uses it. Issues are reported at `path`, the
 * `steps` key, so they land on the line of the node.
 */
export function checkSteps(
  steps: Step[],
  trigger: { kind: string },
  path: Array<string | number>,
  fail: Fail,
): void {
  const hasItem = trigger.kind !== 'cron';

  steps.forEach((step, index) => {
    const at = (...rest: Array<string | number>) => [...path, index, ...rest];

    if (step.kind === 'agent' && step.action !== undefined && !hasItem) {
      // Inside a step the job is the step's own `prompt:`; a step's `run:` is a command.
      fail(
        'An action is a verb on an item, and a schedule has no item: write the job as `prompt: …`.',
        at('action'),
      );
    }

    if (step.if !== undefined) {
      const parsed = parseExpression(step.if);
      if (parsed.ok) {
        const scope: ExpressionScope = {
          output(id, name) {
            const found = earlierStep(steps, id, index);
            if ('problem' in found) return found;
            const { step: earlier } = found;
            if (own(earlier.outputs, name)) return exprTypeOf(earlier.outputs[name], id, name);
            if (artifactsOf(earlier).includes(name)) {
              return {
                problem: `\`${name}\` is an artifact of \`${id}\`; artifacts are prose; branch on an output`,
              };
            }
            return {
              problem: `\`${id}\` has no output \`${name}\` (${listed(Object.keys(earlier.outputs))})`,
            };
          },
          item: () => (hasItem ? { kind: 'unknown' } : { problem: SCHEDULE_HAS_NO_ITEM }),
        };
        for (const message of checkExpression(parsed.expr, scope)) fail(message, at('if'));
      }
    }

    if (step.kind === 'agent') {
      step.reads.forEach((entry, readIndex) => {
        const [id, name] = entry.split('.');
        const found = earlierStep(steps, id, index);
        if ('problem' in found)
          return fail(`\`${entry}\`: ${found.problem}`, at('reads', readIndex));
        const earlier = found.step;
        if (artifactsOf(earlier).includes(name)) {
          if (earlier.kind === 'agent' && name === 'handover') earlier.handover = 'required';
          return;
        }
        fail(
          own(earlier.outputs, name)
            ? `\`${entry}\`: \`${name}\` is an output, not a document; use it in an \`if:\` or a template`
            : `\`${entry}\`: \`${id}\` has no artifact \`${name}\` (${listed(artifactsOf(earlier))})`,
          at('reads', readIndex),
        );
      });
    }

    const checkText = (text: string, where: 'prompt' | 'env', location: Array<string | number>) => {
      for (const ref of templatePaths(text)) {
        const problem = templateProblem(ref, where);
        if (problem) fail(problem, location);
      }
    };

    const templateProblem = (ref: TemplatePath, where: 'prompt' | 'env'): string | undefined => {
      const shown = `{{${ref.text}}}`;
      if (ref.root === 'item') {
        if (!hasItem) return `\`${shown}\`: ${SCHEDULE_HAS_NO_ITEM}`;
        if (where === 'prompt' && !TRUSTED_ITEM_FIELDS.includes(ref.field))
          return UNTRUSTED(ref.text);
        return undefined;
      }
      const found = earlierStep(steps, ref.step, index);
      if ('problem' in found) return `\`${shown}\`: ${found.problem}`;
      const earlier = found.step;
      if (own(earlier.outputs, ref.name)) {
        if (ref.file) {
          return `\`${shown}\`: \`.file\` names an artifact's file, and ${ref.name} is an output`;
        }
        const type = earlier.outputs[ref.name];
        if (where === 'prompt' && type.type === 'string') return UNTRUSTED(ref.text);
        return undefined;
      }
      if (artifactsOf(earlier).includes(ref.name)) {
        if (where === 'prompt') return UNTRUSTED(ref.text);
        if (earlier.kind === 'agent' && ref.name === 'handover') earlier.handover = 'required';
        return undefined;
      }
      const names = [...Object.keys(earlier.outputs), ...artifactsOf(earlier)];
      return `\`${shown}\`: \`${ref.step}\` has no output or artifact \`${ref.name}\` (${listed(names)})`;
    };

    if (step.kind === 'agent' && step.prompt !== undefined)
      checkText(step.prompt, 'prompt', at('prompt'));
    if (step.kind === 'run') {
      for (const [name, value] of Object.entries(step.env))
        checkText(value, 'env', at('env', name));
    }
  });
}

/** Every `item.<field>` the steps use, and where: for the runner's re-check against its connection. */
export function stepItemFields(
  steps: Step[],
): Array<{ step: string; field: string; where: 'prompt' | 'env' | 'if' }> {
  const found: Array<{ step: string; field: string; where: 'prompt' | 'env' | 'if' }> = [];
  for (const step of steps) {
    if (step.if !== undefined) {
      const parsed = parseExpression(step.if);
      if (parsed.ok) {
        for (const ref of expressionPaths(parsed.expr)) {
          if (ref.kind === 'item') found.push({ step: step.id, field: ref.field, where: 'if' });
        }
      }
    }
    const texts: Array<[string, 'prompt' | 'env']> =
      step.kind === 'run'
        ? Object.values(step.env).map((value): [string, 'env'] => [value, 'env'])
        : step.prompt !== undefined
          ? [[step.prompt, 'prompt']]
          : [];
    for (const [text, where] of texts) {
      for (const ref of templatePaths(text)) {
        if (ref.root === 'item') found.push({ step: step.id, field: ref.field, where });
      }
    }
  }
  return found;
}

function typeWord(type: ExprType): string {
  return type.kind === 'unknown' ? 'an item field' : `a ${type.kind}`;
}

/** An `if:`'s uses of item fields, checked against what the connection says each is. */
function ifItemProblems(
  expr: Expr,
  field: (name: string, text: string) => ExprType | undefined,
): string[] {
  const problems: string[] = [];
  const visit = (node: Expr, wantsBoolean: boolean): void => {
    switch (node.kind) {
      case 'item': {
        const type = field(node.field, node.text);
        if (type && wantsBoolean && type.kind !== 'boolean') {
          problems.push(`\`${node.text}\` is ${typeWord(type)}; here it needs true or false`);
        }
        return;
      }
      case 'output':
      case 'literal':
        return;
      case 'not':
        visit(node.operand, true);
        return;
      case 'and':
      case 'or':
        visit(node.left, true);
        visit(node.right, true);
        return;
      case 'compare': {
        const { left, right, op } = node;
        const itemSide = left.kind === 'item' ? left : right.kind === 'item' ? right : undefined;
        const other = itemSide === left ? right : left;
        const type = itemSide ? field(itemSide.field, itemSide.text) : undefined;
        if (left.kind === 'item' && itemSide !== left) visit(left, false);
        if (right.kind === 'item' && itemSide !== right) visit(right, false);
        if (!itemSide || !type || type.kind === 'unknown' || other.kind !== 'literal') return;
        const literal =
          typeof other.value === 'string'
            ? 'string'
            : typeof other.value === 'number'
              ? 'number'
              : 'boolean';
        if (op !== '==' && op !== '!=') {
          if (type.kind !== 'number' || literal !== 'number')
            problems.push(`\`${node.text}\`: \`${op}\` compares numbers`);
          return;
        }
        if (type.kind !== literal) {
          const [a, b] = itemSide === left ? [type.kind, literal] : [literal, type.kind];
          problems.push(`\`${node.text}\` compares a ${a} with a ${b}`);
        } else if (
          type.kind === 'string' &&
          type.enum &&
          typeof other.value === 'string' &&
          !type.enum.values.includes(other.value)
        ) {
          problems.push(
            `\`${other.value}\` is not a ${type.enum.owner} (${type.enum.values.join(', ')})`,
          );
        }
        return;
      }
    }
  };
  visit(expr, true);
  return problems;
}

/**
 * The runner's problems for one connection's field table: unknown fields,
 * untrusted fields in prompts, `if:` literals of the wrong type.
 */
export function stepItemFieldProblems(
  steps: Step[],
  table: ItemFieldTable,
  connection: string,
): string[] {
  const problems: string[] = [];
  const lookup = (name: string, text: string): ItemField | undefined => {
    if (own(table, name)) return table[name];
    problems.push(
      `\`${text}\`: ${connection} items have no field \`${name}\` (they have: ${Object.keys(table).join(', ')})`,
    );
    return undefined;
  };
  for (const step of steps) {
    if (step.if !== undefined) {
      const parsed = parseExpression(step.if);
      if (parsed.ok)
        problems.push(...ifItemProblems(parsed.expr, (name, text) => lookup(name, text)?.type));
    }
    const texts: Array<[string, 'prompt' | 'env']> =
      step.kind === 'run'
        ? Object.values(step.env).map((value): [string, 'env'] => [value, 'env'])
        : step.prompt !== undefined
          ? [[step.prompt, 'prompt']]
          : [];
    for (const [text, where] of texts) {
      for (const ref of templatePaths(text)) {
        if (ref.root !== 'item') continue;
        const field = lookup(ref.field, `item.${ref.field}`);
        if (field && where === 'prompt' && !field.trusted) problems.push(UNTRUSTED(ref.text));
      }
    }
  }
  return [...new Set(problems)];
}

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
import { branchPlaceholderNames } from './branchName';
import { parseDurationMs } from './duration';
import {
  ENV_NAME_PATTERN,
  ENV_PREFIX_EXCEPTIONS,
  isRefusedEnvName,
  REFUSED_ENV_LIST,
} from './envNames';
import {
  gateHasNo,
  MAX_LOOP_STEPS,
  ON_EXHAUSTED_OUTSIDE,
  type OnExhausted,
  parseGateBody,
  parseOnExhausted,
  parseRepeatHeader,
  parseRetry,
  parseThen,
} from './flow';
import { AUTOMATION_NAME_PATTERN } from './names';
import type { OutputType } from './outputs';
import {
  AGENT_PERMISSIONS_REASON,
  LOOP_PERMISSIONS_REASON,
  parsePermissions,
  type StepPermissions,
} from './permissions';
import type { Trigger } from './schema';
import { AGENT_SECRETS_REASON, parseSecretNames, secretTemplateReason } from './secrets';
import { hasTemplateBraces, parseTemplate, templatePaths, type TemplatePath } from './template';
import { checkUsesStep, parseUsesStep, usesTexts, type UsesStep } from './uses';

export const STEP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const ARTIFACT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export {
  ENV_NAME_PATTERN,
  ENV_PREFIX_EXCEPTIONS,
  isRefusedEnvName,
  REFUSED_ENV_NAMES,
  REFUSED_ENV_PREFIXES,
} from './envNames';

export const MAX_STEPS = 20;
export const MAX_OUTPUTS = 10;
export const DEFAULT_STRING_MAX = 1000;
export const STRING_MAX_CEILING = 4000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
/** The most turns `max_turns` may allow an agent step's turn. */
export const MAX_TURNS_LIMIT = 500;

interface StepCommon {
  id: string;
  /** The id was written in the file (only these can be referenced). */
  named: boolean;
  if?: string;
}

export interface AgentStep extends StepCommon {
  kind: 'agent';
  /** `then: stop`: once it completes, the run ends. Present only when the file writes it. */
  stop?: true;
  prompt?: string;
  action?: string;
  /** The agent it runs as (`agents/<name>.md`), present only when the file writes one. */
  agent?: string;
  outputs: Record<string, OutputType>;
  artifacts: string[];
  /**
   * The artifacts that are files the step leaves in its run's checkout
   * (slice 3-B), each name also in `artifacts`; present only when one is
   * written. Their paths take `{{item.key}}` and `{{item.number}}`.
   */
  pathArtifacts?: Array<{ name: string; path: string }>;
  reads: string[];
  handover: 'required' | 'optional';
  /** Its turn's cap (`max_turns`), present only when the file writes one. */
  maxTurns?: number;
  /** `on_failure: { retry: <n> }`: how many times it starts again by itself. Present only when written. */
  onFailure?: { retry: number };
}

export interface CommandStep extends StepCommon {
  kind: 'run';
  /** `then: stop`: once it completes, the run ends. Present only when the file writes it. */
  stop?: true;
  run: string;
  env: Record<string, string>;
  outputs: Record<string, OutputType>;
  stdout?: 'json' | 'text';
  timeoutMs: number;
  dryRun: 'report' | 'run';
  /** The secrets it needs, by name, each its own environment variable; present only when written and non-empty. */
  secrets?: string[];
  /**
   * The GitHub permissions its command needs (`permissions: { pull_requests: write }`), present
   * only when written. On a cloud runner the step gets a GitHub token narrowed to them, and a
   * step without them gets none; on the desktop a command runs as the workspace's bound account,
   * so they have no effect there. In the version either way.
   */
  permissions?: StepPermissions;
  /** `on_failure: { retry: <n> }`, present only when written; above 0 only with `dry_run: run` (`checkSteps`). */
  onFailure?: { retry: number };
}

/**
 * `gate:`: a person decides. It runs nothing; its one output is `decision`,
 * one of its choices (`gateChoices`), for an `if:` to branch on.
 */
export interface GateStep extends StepCommon {
  kind: 'gate';
  /** As written, 1 to 300 characters; its `{{ }}` paths are trusted ones only, as a prompt's. */
  ask: string;
  /** The documents its card shows, `<step>.<artifact>` as written; empty when it names none. */
  show: string[];
  /** 2 to 6 words, present only when written; without them the gate offers approve (and reject). */
  choices?: string[];
  /** `then: stop`, present only when written. */
  stop?: true;
}

export type { UsesStep } from './uses';

export type Step = AgentStep | CommandStep | GateStep | UsesStep;

export {
  GATE_CHOICE_PATTERN,
  MAX_GATE_ASK,
  MAX_GATE_SHOW,
  MAX_LOOP_STEPS,
  MAX_RETRIES,
  MAX_ROUNDS,
  type OnExhausted,
} from './flow';

/**
 * `repeat:`: a loop over 1 to 10 leaf steps, run in rounds until `until` is
 * met or `max` rounds have run, then `onExhausted` (absent: `fail`). A block
 * is a step of the entry's list but not a leaf: it runs nothing itself, and
 * no reference names it.
 */
export interface RepeatStep {
  kind: 'repeat';
  id: string;
  named: true;
  /** Whether the loop runs at all, read before its first round. */
  if?: string;
  /** 1 to 10 rounds at most. */
  max: number;
  /** An `if:` expression over the steps before the loop and the loop's own. */
  until: string;
  steps: Step[];
  /** Present only when written. */
  onExhausted?: OnExhausted;
}

/** An entry of `steps:`: a leaf step, or a loop of them. */
export type StepEntry = Step | RepeatStep;

/** One row of record order: the step, the loop it is inside, and where it is in the file's `steps:`. */
export interface FlatStep {
  step: StepEntry;
  block?: RepeatStep;
  path: Array<number | 'steps'>;
}

/** Record order: each entry, and right after a block its steps (`[fix, polish, review, address, pr]`). */
export function flatSteps(entries: readonly StepEntry[]): FlatStep[] {
  const flat: FlatStep[] = [];
  entries.forEach((step, index) => {
    flat.push({ step, path: [index] });
    if (step.kind === 'repeat')
      step.steps.forEach((inner, at) =>
        flat.push({ step: inner, block: step, path: [index, 'steps', at] }),
      );
  });
  return flat;
}

/** Every leaf step, inner ones included, in file order: what every "does any step…" question reads. */
export function leafSteps(entries: readonly StepEntry[]): Step[] {
  return entries.flatMap((step) => (step.kind === 'repeat' ? step.steps : [step]));
}

/** The decisions a gate offers besides Reject: its choices, or approve. */
export function gateChoices(gate: { choices?: readonly string[] }): string[] {
  return gate.choices ? [...gate.choices] : ['approve'];
}

/**
 * Keys a later slice owns, with what each arrives with. One table for steps
 * and entries: a refusal, not an ignore, since an ignored `gate:` would run
 * the step it guards.
 */
export const LATER_KEYS: Readonly<Record<string, string>> = {
  wait: 'waiting runs',
  concurrency: 'waiting runs',
  callable: 'callable automations',
  inputs: 'callable automations',
};

/**
 * Why `env:` refuses `GH_TOKEN` and `GH_HOST`: a command acts as the
 * workspace's bound GitHub account, whose token Consola sets (decision 37),
 * so a file never replaces it, templated or not.
 */
export function GH_IDENTITY_ENV_REASON(name: string): string {
  return `\`${name}\` is the workspace's bound GitHub account's to set (decision 37): commands act as that account. To act as another, bind it to the workspace.`;
}

/** `environment:` on an agent step, or on the automation (slice 3-B): an agent's environment is its file's. */
export const ENVIRONMENT_IN_AGENT_FILE = "An agent's environment is in its agent file.";
/** `environment:` on a command: 3-C's sandboxed commands. */
const ENVIRONMENT_ON_A_COMMAND =
  '`environment:` on a command arrives with sandboxed commands; it is not supported yet.';

/** What a step reads, or a gate shows, of a run's own checkout: its diff from where the run cut its branch (slice 3-B). */
export const CHECKOUT_CHANGES_REF = 'checkout.changes';
const CHECKOUT_CHANGES_NEEDS_A_RUN_CHECKOUT =
  "`checkout.changes` is a run's own checkout's diff; it needs `checkout: { repo, branch }`.";

/** The longest path a path artifact may name. */
export const MAX_ARTIFACT_PATH = 200;
/** What a path artifact's path may name of the item; `cleanBranchPart` cleans each, as a branch's. */
const PATH_PLACEHOLDERS = ['item.key', 'item.number'];
const PATH_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** Folders and files a path artifact never names, at any depth, compared case aside. */
const PATH_REFUSED_PARTS = ['.git', '.claude', '.mcp.json'];

/**
 * Why `path` is not a file a path artifact may name in a run's checkout, in
 * the format's words, or null: a relative path of at most 200 characters,
 * no empty, `.` or `..` part, no `.git`, `.claude` or `.mcp.json` part (any
 * case), no backslash or control character, and placeholders only
 * `{{item.key}}` and `{{item.number}}` with no stray braces.
 */
export function artifactPathProblem(path: string): string | null {
  const words = `\`${path}\` is not a path in the checkout: no leading \`/\`, no \`..\`, nothing under \`.git/\` or \`.claude/\`, not \`.mcp.json\`, at most ${MAX_ARTIFACT_PATH} characters.`;
  if (path.length > MAX_ARTIFACT_PATH || /[\\\u0000-\u001f\u007f]/.test(path)) return words;
  if (branchPlaceholderNames(path).some((name) => !PATH_PLACEHOLDERS.includes(name))) return words;
  if (/[{}]/.test(path.replace(PATH_PLACEHOLDER, 'x'))) return words;
  // An empty part is an empty path, a leading or trailing `/`, or `//`.
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') return words;
    if (PATH_REFUSED_PARTS.includes(part.toLowerCase())) return words;
  }
  return null;
}

export function laterKeyMessage(key: string): string {
  return `\`${key}\` arrives with ${LATER_KEYS[key]}; it is not supported yet.`;
}

const COMMON_KEYS = ['id', 'if', 'then', 'on_failure'];
const AGENT_KEYS = ['prompt', 'action', 'agent', 'outputs', 'artifacts', 'reads', 'max_turns'];
const COMMAND_KEYS = ['run', 'env', 'outputs', 'timeout', 'dry_run', 'secrets', 'permissions'];
const ALL_KEYS = new Set([...COMMON_KEYS, ...AGENT_KEYS, ...COMMAND_KEYS]);
/** Exclusive: a step names one thing to do. `agent:` goes with `prompt:` or `action:`, or alone. */
const ONE_OF = ['prompt', 'action', 'run'] as const;
/** A run has one checkout and one budget, so on a step (or a loop) they say where they go. */
const STEP_CHECKOUT = '`checkout:` belongs to the automation: one checkout per run.';
const STEP_BUDGET = '`budget:` belongs to the automation: one budget per run.';
/** The run's own keys, refused on a step or a loop in their words. */
const RUN_KEYS_ON_A_STEP: Readonly<Record<string, string>> = {
  checkout: STEP_CHECKOUT,
  budget: STEP_BUDGET,
};

/** Skills and servers are an agent's, named in its file; on a step they say where they go. */
const STEP_SKILLS_AND_SERVERS =
  'Name skills and servers in an agent file (`agents/<name>.md`), then set `agent:` on this step.';

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
  const ms = parseDurationMs(value);
  if (ms === null) {
    fail(TIMEOUT_FORMAT, ['timeout']);
    return null;
  }
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

/**
 * One `reads:` entry, split: `<step>.<artifact>`, or `previous.<step>.<artifact>`
 * for what the last run on the same item wrote. Null for any other shape. The
 * one splitter of `reads:`, so `previous` is never taken for a step id.
 */
export function parseReadRef(
  entry: string,
): { previous: boolean; step: string; name: string } | null {
  const segments = entry.split('.');
  if (segments.some((segment) => !/^\S+$/.test(segment))) return null;
  if (segments[0] === 'previous') {
    return segments.length === 3 ? { previous: true, step: segments[1], name: segments[2] } : null;
  }
  return segments.length === 2 ? { previous: false, step: segments[0], name: segments[1] } : null;
}

/** Text with `{{ path }}` in it must parse; which paths are allowed is checked with the whole entry. */
function checkTemplate(text: string, path: Array<string | number>, fail: Fail): boolean {
  const parsed = parseTemplate(text);
  if (parsed.ok) return true;
  fail(parsed.problem[0].toUpperCase() + parsed.problem.slice(1) + '.', path);
  return false;
}

/** A step's `id` (or `step-<n>`) and its `if:`, each refused at its key. Shared by every kind of step. */
function parseIdAndIf(
  raw: Record<string, unknown>,
  position: number,
  bad: Fail,
): { id: string; named: boolean; condition?: string } {
  let id = `step-${position + 1}`;
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
    } else if (given === 'checkout') {
      // `checkout.changes` names the run's own checkout (slice 3-B).
      bad('`checkout` is reserved; name this step something else.', ['id']);
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
      // A problem that is already a sentence keeps its one full stop.
      if (!parsed.ok) bad(`Cannot read this \`if\`: ${parsed.problem.replace(/\.$/, '')}.`, ['if']);
      else condition = given;
    }
  }
  return { id, named, ...(condition !== undefined ? { condition } : {}) };
}

/** A gate takes these keys and no other: it asks a person and runs nothing. */
const GATE_STEP_KEYS = ['id', 'if', 'then', 'gate'];

/**
 * One leaf step, its issues at `[index, …]`. `position` is its place in
 * record order, which names an unnamed step (`step-<position + 1>`): the
 * same as `index` in an entry with no loop.
 */
function parseStep(raw: unknown, index: number, fail: Fail, position = index): Step | null {
  const failAt: Fail = (message, path = []) => fail(message, [index, ...path]);
  if (!isRecord(raw)) {
    failAt(
      'Expected a step: a mapping with one of `prompt`, `action`, `agent`, `run`, `uses`, `gate` or `repeat`.',
    );
    return null;
  }
  if ('uses' in raw)
    return parseUsesStep(raw, failAt, {
      idAndIf: (given, bad) => parseIdAndIf(given, position, bad),
      outputs: parseOutputs,
      timeout: parseTimeout,
      thenStop: parseThen,
      retry: parseRetry,
      refusedKey: (key) =>
        Object.prototype.hasOwnProperty.call(RUN_KEYS_ON_A_STEP, key)
          ? RUN_KEYS_ON_A_STEP[key]
          : key === 'on_exhausted'
            ? ON_EXHAUSTED_OUTSIDE
            : Object.prototype.hasOwnProperty.call(LATER_KEYS, key)
              ? laterKeyMessage(key)
              : undefined,
    });
  let ok = true;
  const bad: Fail = (message, path) => {
    ok = false;
    failAt(message, path);
  };

  // A gate: every key it does not take is one it would run.
  if ('gate' in raw) {
    for (const key of Object.keys(raw))
      if (!GATE_STEP_KEYS.includes(key)) bad(gateHasNo(key), [key]);
    const { id, named, condition } = parseIdAndIf(raw, position, bad);
    const body = parseGateBody(raw.gate, bad);
    const stop = 'then' in raw ? parseThen(raw.then, bad) : undefined;
    if (!ok || !body) return null;
    return {
      id,
      named,
      ...(condition !== undefined ? { if: condition } : {}),
      kind: 'gate',
      ...body,
      ...(stop ? { stop } : {}),
    };
  }

  // Keys: later slices', then strangers.
  for (const key of Object.keys(raw)) {
    if (ALL_KEYS.has(key)) continue;
    if (key === 'inputs')
      bad('`inputs` is not a step key: use `reads` to name what an earlier step wrote.', [key]);
    else if (key === 'skills' || key === 'mcpServers') bad(STEP_SKILLS_AND_SERVERS, [key]);
    else if (key === 'on_exhausted') bad(ON_EXHAUSTED_OUTSIDE, [key]);
    else if (key === 'environment')
      bad('run' in raw ? ENVIRONMENT_ON_A_COMMAND : ENVIRONMENT_IN_AGENT_FILE, [key]);
    else if (Object.prototype.hasOwnProperty.call(RUN_KEYS_ON_A_STEP, key))
      bad(RUN_KEYS_ON_A_STEP[key], [key]);
    else if (Object.prototype.hasOwnProperty.call(LATER_KEYS, key))
      bad(laterKeyMessage(key), [key]);
    else bad(`Unrecognized key in a step: ${key}.`, [key]);
  }

  const present = ONE_OF.filter((key) => key in raw);
  if (present.length > 1 || (present.length === 0 && !('agent' in raw))) {
    bad(
      present.length === 0
        ? 'A step has one of `prompt`, `action`, `agent`, `run`, `uses`, `gate` or `repeat`.'
        : `A step names one thing to do; got ${present.join(' and ')}.`,
    );
    return null;
  }
  // An agent step's instruction: its prompt, its action, or none (the agent's body alone).
  const kind: 'prompt' | 'action' | 'run' | 'agent' = present.length > 0 ? present[0] : 'agent';

  const { id, named, condition } = parseIdAndIf(raw, position, bad);
  // `then: stop` and `on_failure`, only when written, so a step without them parses, and hashes, as before.
  const stop = 'then' in raw ? parseThen(raw.then, bad) : undefined;
  const onFailure = 'on_failure' in raw ? parseRetry(raw.on_failure, bad) : undefined;

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
          : key === 'max_turns' || key === 'agent'
            ? 'A command runs no agent; `agent:` and `max_turns` are for agent steps.'
            : `\`${key}\` is for an agent step; a command takes what it needs through \`env\`.`,
        [key],
      );
    }
    const run = raw.run;
    if (typeof run !== 'string' || !run.trim()) {
      bad('Expected the command to run, e.g. `run: gh pr view "$PR"`.', ['run']);
    } else if (hasTemplateBraces(run)) {
      const found = /\{\{[^}]*\}\}/.exec(run)?.[0] ?? '{{';
      // `{{ secrets.X }}` says how a secret reaches a command, rather than to move it into `env:`.
      const [root, name] = found.slice(2, -2).trim().split('.');
      bad(
        root === 'secrets'
          ? secretTemplateReason(name)
          : `Values reach a command only as environment variables: move \`${found}\` into \`env:\` and use \`"$PR"\`.`,
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
          } else if ((ENV_PREFIX_EXCEPTIONS as readonly string[]).includes(name)) {
            bad(GH_IDENTITY_ENV_REASON(name), ['env', name]);
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
    const secrets =
      'secrets' in raw
        ? parseSecretNames(
            raw.secrets,
            (message, path = []) => bad(message, ['secrets', ...path]),
            Object.keys(env),
          )
        : null;
    const permissions =
      'permissions' in raw
        ? parsePermissions(raw.permissions, (message, path = []) =>
            bad(message, ['permissions', ...path]),
          )
        : null;
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
      // Only when it names any, so a step without one parses, and hashes, as before the key existed.
      ...(secrets && secrets.length > 0 ? { secrets } : {}),
      // Only when written, so a step without it parses, and hashes, as before the key existed.
      ...(permissions ? { permissions } : {}),
      ...(stop ? { stop } : {}),
      ...(onFailure ? { onFailure } : {}),
    };
  }

  // An agent step.
  for (const key of ['env', 'timeout', 'dry_run'].filter((key) => key in raw)) {
    bad(`\`${key}\` is for a command (\`run:\`); an agent step does not take it.`, [key]);
  }
  if ('secrets' in raw) bad(AGENT_SECRETS_REASON, ['secrets']);
  if ('permissions' in raw) bad(AGENT_PERMISSIONS_REASON, ['permissions']);
  // A step with `agent:` and neither `prompt:` nor `action:` runs on the agent's body alone.
  const text = kind === 'agent' ? undefined : raw[kind];
  if (kind !== 'agent') {
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
  }

  // Only when written, so a step without one parses, and hashes, as it did before the key existed.
  let agent: string | undefined;
  if ('agent' in raw) {
    const given = raw.agent;
    if (typeof given === 'string' && AUTOMATION_NAME_PATTERN.test(given)) agent = given;
    else if (typeof given === 'string' && /[/@]/.test(given))
      bad('Pinned references arrive with shared factories.', ['agent']);
    else
      bad(
        "Expected `agent` to be an agent's name, its file agents/<name>.md without `.md`: e.g. `agent: investigator`.",
        ['agent'],
      );
  }

  let handover: 'required' | 'optional' = 'optional';
  const artifacts: string[] = [];
  const pathArtifacts: Array<{ name: string; path: string }> = [];
  if ('artifacts' in raw) {
    if (!Array.isArray(raw.artifacts))
      bad('Expected `artifacts` to be a list of names.', ['artifacts']);
    else {
      for (const entry of raw.artifacts) {
        // A name, or `{ name, path }`: a file the step leaves in its run's checkout (slice 3-B).
        let name: unknown = entry;
        let filePath: string | undefined;
        if (isRecord(entry)) {
          const keys = Object.keys(entry);
          if (
            keys.length !== 2 ||
            !keys.includes('name') ||
            !keys.includes('path') ||
            typeof entry.path !== 'string'
          ) {
            bad(
              'Expected an artifact as a name, or `{ name, path }` for a file in the checkout, e.g. `{ name: spec, path: docs/spec.md }`.',
              ['artifacts'],
            );
            continue;
          }
          name = entry.name;
          filePath = entry.path;
        }
        if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) {
          bad('Use lowercase letters, digits and dashes, starting with a letter, e.g. notes.', [
            'artifacts',
          ]);
        } else if (name === 'output') {
          bad("`output` is reserved for a command's stdout; name this document something else.", [
            'artifacts',
          ]);
        } else if (name === 'handover' && filePath !== undefined) {
          bad(
            "A handover is Consola's own document; a file in the checkout needs a name of its own.",
            ['artifacts'],
          );
        } else if (name === 'handover') {
          handover = 'required';
        } else if (artifacts.includes(name)) {
          bad(`\`${name}\` is listed twice.`, ['artifacts']);
        } else if (Object.prototype.hasOwnProperty.call(outputs, name)) {
          bad(
            `\`${name}\` is both an output and an artifact: they share one namespace, read as \`steps.<id>.${name}\`.`,
            ['artifacts'],
          );
        } else if (filePath !== undefined && artifactPathProblem(filePath) !== null) {
          bad(artifactPathProblem(filePath)!, ['artifacts']);
        } else {
          artifacts.push(name);
          if (filePath !== undefined) pathArtifacts.push({ name, path: filePath });
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
        const ref = typeof entry === 'string' ? parseReadRef(entry) : null;
        if (!ref) {
          bad(
            typeof entry === 'string' && entry.startsWith('previous.')
              ? 'Name what the last run wrote as `previous.<step>.<artifact>`, e.g. `previous.review.handover`.'
              : 'Name what to read as `<step>.<artifact>`, e.g. `review.handover`.',
            ['reads'],
          );
        } else if (!STEP_ID_PATTERN.test(ref.step) || !ARTIFACT_NAME_PATTERN.test(ref.name)) {
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

  // Only when written, so a step without one parses, and hashes, as it did before the key existed.
  let maxTurns: number | undefined;
  if ('max_turns' in raw) {
    const given = raw.max_turns;
    if (
      typeof given === 'number' &&
      Number.isInteger(given) &&
      given >= 1 &&
      given <= MAX_TURNS_LIMIT
    ) {
      maxTurns = given;
    } else {
      bad(`Expected \`max_turns\` to be a whole number from 1 to ${MAX_TURNS_LIMIT}.`, [
        'max_turns',
      ]);
    }
  }

  if (!ok || (kind !== 'agent' && typeof text !== 'string')) return null;
  return {
    id,
    named,
    ...(condition !== undefined ? { if: condition } : {}),
    kind: 'agent',
    ...(typeof text !== 'string'
      ? {}
      : kind === 'prompt'
        ? { prompt: text }
        : { action: text.trim() }),
    ...(agent !== undefined ? { agent } : {}),
    outputs,
    artifacts,
    // Only when written, so a step without one parses, and hashes, as before (contract 14).
    ...(pathArtifacts.length > 0 ? { pathArtifacts } : {}),
    reads,
    handover,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(stop ? { stop } : {}),
    ...(onFailure ? { onFailure } : {}),
  };
}

/** A loop takes these keys; `then` and `on_failure` are refused with why, anything else by name. */
const BLOCK_KEYS = ['id', 'if', 'repeat', 'steps', 'on_exhausted'];

/**
 * One `repeat:` block at `index`, its place in record order `position`: its
 * header, its `on_exhausted`, and its 1 to 10 leaf steps (each at
 * `[index, 'steps', j]`, named by its own place in record order).
 */
function parseBlock(
  raw: Record<string, unknown>,
  index: number,
  position: number,
  fail: Fail,
): RepeatStep | null {
  let ok = true;
  const bad: Fail = (message, path = []) => {
    ok = false;
    fail(message, [index, ...path]);
  };
  for (const key of Object.keys(raw)) {
    if (BLOCK_KEYS.includes(key)) continue;
    if (key === 'then')
      bad('`then:` goes on a step; a loop ends by its `until` or its `on_exhausted`.', [key]);
    else if (key === 'on_failure')
      bad(
        "`on_failure` goes on a step or on the automation; a loop's rounds are bounded by `max`.",
        [key],
      );
    else if (Object.prototype.hasOwnProperty.call(RUN_KEYS_ON_A_STEP, key))
      bad(RUN_KEYS_ON_A_STEP[key], [key]);
    else if (key === 'permissions') bad(LOOP_PERMISSIONS_REASON, [key]);
    else bad(`Unrecognized key in a loop: ${key}.`, [key]);
  }
  if (!('id' in raw)) bad('A loop needs an `id`, e.g. `id: polish`.');
  const { id, named, condition } = parseIdAndIf(raw, position, bad);
  const header = parseRepeatHeader(raw.repeat, bad);
  const onExhausted = 'on_exhausted' in raw ? parseOnExhausted(raw.on_exhausted, bad) : undefined;
  const steps: Step[] = [];
  const inner = raw.steps;
  if (!Array.isArray(inner) || inner.length < 1 || inner.length > MAX_LOOP_STEPS) {
    bad(`A loop has 1 to ${MAX_LOOP_STEPS} steps.`, 'steps' in raw ? ['steps'] : []);
  } else {
    inner.forEach((entry, at) => {
      if (isRecord(entry) && 'repeat' in entry) {
        bad('A loop inside a loop is not supported.', ['steps', at]);
        return;
      }
      const step = parseStep(
        entry,
        at,
        (message, path = []) => bad(message, ['steps', ...path]),
        position + 1 + at,
      );
      if (step) steps.push(step);
      else ok = false;
    });
  }
  if (!ok || !header || !named) return null;
  return {
    kind: 'repeat',
    id,
    named: true,
    ...(condition !== undefined ? { if: condition } : {}),
    max: header.max,
    until: header.until,
    steps,
    ...(onExhausted !== undefined ? { onExhausted } : {}),
  };
}

/** How many leaf steps a raw `steps:` list holds: a loop's own steps count, the loop itself does not. */
function leafCount(raw: unknown[]): number {
  return raw.reduce<number>(
    (count, entry) =>
      count +
      (isRecord(entry) && 'repeat' in entry && Array.isArray(entry.steps) ? entry.steps.length : 1),
    0,
  );
}

/**
 * `steps:` — 1 to 20 leaf steps, a loop's included, each checked on its own;
 * ids are unique across them, a loop's and its steps' included.
 */
export function stepsSchema(): z.ZodType<StepEntry[], unknown> {
  return z.unknown().transform((raw, ctx): StepEntry[] => {
    const fail: Fail = (message, path = []) => ctx.addIssue({ code: 'custom', message, path });
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > MAX_STEPS ||
      leafCount(raw) > MAX_STEPS
    ) {
      fail(`An entry with \`steps:\` has 1 to ${MAX_STEPS} steps, written as a list.`);
      return z.NEVER;
    }
    let ok = true;
    const onFail: Fail = (message, path) => {
      ok = false;
      fail(message, path);
    };
    const entries: Array<{ step: StepEntry; index: number }> = [];
    let position = 0;
    raw.forEach((entry, index) => {
      if (isRecord(entry) && 'repeat' in entry) {
        const block = parseBlock(entry, index, position, onFail);
        position += 1 + (Array.isArray(entry.steps) ? entry.steps.length : 0);
        if (block) entries.push({ step: block, index });
        else ok = false;
        return;
      }
      const step = parseStep(entry, index, onFail, position);
      position += 1;
      if (step) entries.push({ step, index });
      else ok = false;
    });
    // Record order, each id at its own line: a loop's, then its steps'.
    const seen = new Set<string>();
    const unique = (id: string, path: Array<string | number>) => {
      if (seen.has(id)) onFail(`Step ids are unique; \`${id}\` is used twice.`, [...path, 'id']);
      seen.add(id);
    };
    for (const { step, index } of entries) {
      unique(step.id, [index]);
      if (step.kind === 'repeat')
        step.steps.forEach((inner, at) => unique(inner.id, [index, 'steps', at]));
    }
    return ok ? entries.map(({ step }) => step) : z.NEVER;
  });
}

// --- across steps ------------------------------------------------------------------

/** What a connection says about one item field. */
export interface ItemField {
  type: ExprType;
  trusted: boolean;
}
export type ItemFieldTable = Record<string, ItemField>;

/**
 * A work item's identity, which every connection gives: the item fields a
 * prompt may template without asking, when the entry's items are work items.
 */
export const TRUSTED_ITEM_FIELDS: readonly string[] = ['key', 'url', 'repo', 'number', 'type'];

/**
 * What a run of an entry knows of its item, by trigger: `none` (a schedule, or
 * a run on demand that names no kind of item), `identity` (a work item, whose
 * identity fields are trusted: an event, `on: manual` with `applies_to`, a
 * poll with `item:`), or `untrusted` (a poll with `key:`, where every field,
 * the key too, came from the check command's output).
 */
export type ItemKind = 'none' | 'identity' | 'untrusted';

export function itemKindOf(trigger: Trigger, appliesTo: readonly string[] | undefined): ItemKind {
  switch (trigger.kind) {
    case 'cron':
      return 'none';
    case 'manual':
      return appliesTo && appliesTo.length > 0 ? 'identity' : 'none';
    case 'poll':
      return trigger.item ? 'identity' : 'untrusted';
    case 'event':
      return 'identity';
  }
}

/** An action on a poll whose items are not work items; the entry's `run: { action }` says the same. */
export const ACTION_ON_KEYED_POLL =
  'An action is a verb on a pull request or issue, and this poll’s items are neither: write it as a prompt.';

const SCHEDULE_HAS_NO_ITEM = 'a schedule has no item, so there is no `item` to read';
const AUTOMATION_HAS_NO_ITEM = 'this automation has no item, so there is no `item` to read';
const UNNAMED = (id: string) =>
  `\`${id}\` is an unnamed step; only steps with an \`id\` can be named`;
const UNTRUSTED = (path: string) =>
  `${path}: it is text someone else wrote; the step gets it below its prompt as data.`;
const PREVIOUS_IN_PROMPT = (path: string) =>
  `${path}: it is prose an agent wrote after reading outside text; read it with \`reads:\`.`;

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

/** The documents a step writes: its declared artifacts and handover, a command's stdout, or a call's result. A gate writes none. */
function artifactsOf(step: Step): string[] {
  if (step.kind === 'uses') return ['output'];
  if (step.kind === 'gate') return [];
  return step.kind === 'agent' ? ['handover', ...step.artifacts] : step.stdout ? ['output'] : [];
}

/** A step's outputs by name: a gate's one is `decision`, an enum of what it offers. */
function outputsOf(step: Step): Record<string, OutputType> {
  return step.kind === 'gate'
    ? { decision: { type: 'enum', values: gateChoices(step) } }
    : step.outputs;
}

/** The text a step's templates are in, and where each is used: a prompt or a gate's question, or a command's env. */
function templatedTexts(step: Step): Array<[string, 'prompt' | 'env']> {
  switch (step.kind) {
    case 'run':
      return Object.values(step.env).map((value): [string, 'env'] => [value, 'env']);
    case 'gate':
      return [[step.ask, 'prompt']];
    case 'agent':
      return step.prompt !== undefined ? [[step.prompt, 'prompt']] : [];
    case 'uses':
      return usesTexts(step).map(({ text }): [string, 'env'] => [text, 'env']);
  }
}

type Lookup = { step: Step } | { problem: string };

const A_LOOP = (id: string) => `\`${id}\` is a loop; name one of its steps`;

/**
 * The earlier step an id names, or why it cannot be named from record-order
 * position `index`. `self` says `index` is the asking step's own place; a
 * loop's `until` asks from just after its last step, where nothing is "this
 * step".
 */
function earlierStep(steps: readonly StepEntry[], id: string, index: number, self = true): Lookup {
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) return { problem: `there is no step \`${id}\`` };
  const found = steps[at];
  if (found.kind === 'repeat') return { problem: A_LOOP(id) };
  if (!found.named) return { problem: UNNAMED(id) };
  if (at >= index) {
    return {
      problem: `\`${id}\` is not before this step: it is ${at === index && self ? 'this step' : 'a later step'}, so it has not run when this one's turn comes`,
    };
  }
  return { step: found };
}

function listed(names: string[]): string {
  return names.length > 0 ? `it has: ${names.join(', ')}` : 'it has none';
}

/**
 * `previous.<step>.<name>`, or why it names nothing: any named step of the
 * entry (it ran in another run, so the reading step itself and later ones
 * count), and one of its documents. A handover it names becomes `required`,
 * so the next run finds one.
 */
function previousProblem(
  steps: readonly StepEntry[],
  id: string,
  name: string,
): string | undefined {
  const producer = steps.find((step) => step.id === id);
  if (!producer) return `there is no step \`${id}\``;
  if (producer.kind === 'repeat') return A_LOOP(id);
  if (!producer.named) return UNNAMED(id);
  if (artifactsOf(producer).includes(name)) {
    if (producer.kind === 'agent' && name === 'handover') producer.handover = 'required';
    return undefined;
  }
  if (own(outputsOf(producer), name)) return `\`previous\` reads documents; ${name} is an output`;
  return `\`${id}\` has no artifact \`${name}\` (${listed(artifactsOf(producer))})`;
}

/**
 * Everything that looks across steps: each `if:`, `reads:`, `env:` value,
 * call's `with:` string, prompt and gate is resolved against the steps before
 * it in record order (`flatSteps`), and a `previous` reference against every
 * named step (a call's `with:` by `env:`'s rules). So a step after a loop
 * reads its steps' latest round, a loop's step reads the steps before the
 * loop and the ones before it in its round, and a loop's `until` and its
 * exhaustion gate read every step before the loop and all of its own. What
 * `item.*` may be used where follows the entry's trigger (`itemKindOf`). Also
 * sets a handover `required` when a later step, a gate's card, or a later run
 * through `previous`, uses it. Issues are reported at
 * `path`, the `steps` key, so they land on the line of the node.
 */
export function checkSteps(
  entries: StepEntry[],
  /** `runOwned`: the entry's `checkout` is `{ repo, branch }` (slice 3-B); absent, it is not. */
  entry: { trigger: Trigger; appliesTo?: readonly string[]; runOwned?: boolean },
  path: Array<string | number>,
  fail: Fail,
): void {
  const { trigger } = entry;
  const itemKind = itemKindOf(trigger, entry.appliesTo);
  const noItem = trigger.kind === 'cron' ? SCHEDULE_HAS_NO_ITEM : AUTOMATION_HAS_NO_ITEM;
  // Inside a step the job is the step's own `prompt:`; a step's `run:` is a command.
  const actionProblem =
    itemKind === 'untrusted'
      ? ACTION_ON_KEYED_POLL
      : itemKind !== 'none'
        ? undefined
        : trigger.kind === 'cron'
          ? 'An action is a verb on an item, and a schedule has no item: write the job as `prompt: …`.'
          : 'An action is a verb on an item, and this automation has none: write the job as `prompt: …`.';
  const flat = flatSteps(entries);
  const steps = flat.map(({ step }) => step);

  /** The checks for what is read from record-order position `index` (`self`: a step's own place). */
  const checksAt = (index: number, self = true) => {
    const condition = (text: string, location: Array<string | number>) => {
      const parsed = parseExpression(text);
      if (!parsed.ok) return;
      const scope: ExpressionScope = {
        output(id, name) {
          const found = earlierStep(steps, id, index, self);
          if ('problem' in found) return found;
          const { step: earlier } = found;
          const outputs = outputsOf(earlier);
          if (own(outputs, name)) return exprTypeOf(outputs[name], id, name);
          if (artifactsOf(earlier).includes(name)) {
            return {
              problem: `\`${name}\` is an artifact of \`${id}\`; artifacts are prose; branch on an output`,
            };
          }
          return {
            problem: `\`${id}\` has no output \`${name}\` (${listed(Object.keys(outputs))})`,
          };
        },
        item: () => (itemKind === 'none' ? { problem: noItem } : { kind: 'unknown' }),
      };
      for (const message of checkExpression(parsed.expr, scope)) fail(message, location);
    };

    // A document an earlier step wrote, named by `reads:` or by a gate's `show:`; a handover named is required.
    const document = (read: string, location: Array<string | number>) => {
      // The run's own checkout's diff, which only a run that owns its checkout has (slice 3-B).
      if (read === CHECKOUT_CHANGES_REF) {
        if (!entry.runOwned) fail(CHECKOUT_CHANGES_NEEDS_A_RUN_CHECKOUT, location);
        return;
      }
      // `parseStep` kept only entries of one of the two shapes (a gate's `show`, never `previous`).
      const ref = parseReadRef(read);
      if (!ref) return;
      const { step: id, name } = ref;
      if (ref.previous) {
        const problem = previousProblem(steps, id, name);
        if (problem) fail(`\`${read}\`: ${problem}`, location);
        return;
      }
      const found = earlierStep(steps, id, index, self);
      if ('problem' in found) return fail(`\`${read}\`: ${found.problem}`, location);
      const earlier = found.step;
      if (artifactsOf(earlier).includes(name)) {
        if (earlier.kind === 'agent' && name === 'handover') earlier.handover = 'required';
        return;
      }
      fail(
        own(outputsOf(earlier), name)
          ? `\`${read}\`: \`${name}\` is an output, not a document; use it in an \`if:\` or a template`
          : `\`${read}\`: \`${id}\` has no artifact \`${name}\` (${listed(artifactsOf(earlier))})`,
        location,
      );
    };

    const templateProblem = (ref: TemplatePath, where: 'prompt' | 'env'): string | undefined => {
      const shown = `{{${ref.text}}}`;
      if (ref.root === 'item') {
        if (itemKind === 'none') return `\`${shown}\`: ${noItem}`;
        const trusted = itemKind === 'identity' && TRUSTED_ITEM_FIELDS.includes(ref.field);
        if (where === 'prompt' && !trusted) return UNTRUSTED(ref.text);
        return undefined;
      }
      if (ref.root === 'previous') {
        if (where === 'prompt') return PREVIOUS_IN_PROMPT(ref.text);
        const problem = previousProblem(steps, ref.step, ref.name);
        return problem ? `\`${shown}\`: ${problem}` : undefined;
      }
      const found = earlierStep(steps, ref.step, index, self);
      if ('problem' in found) return `\`${shown}\`: ${found.problem}`;
      const earlier = found.step;
      const outputs = outputsOf(earlier);
      if (own(outputs, ref.name)) {
        if (ref.file) {
          return `\`${shown}\`: \`.file\` names an artifact's file, and ${ref.name} is an output`;
        }
        const type = outputs[ref.name];
        if (where === 'prompt' && type.type === 'string') return UNTRUSTED(ref.text);
        return undefined;
      }
      if (artifactsOf(earlier).includes(ref.name)) {
        if (where === 'prompt') return UNTRUSTED(ref.text);
        if (earlier.kind === 'agent' && ref.name === 'handover') earlier.handover = 'required';
        return undefined;
      }
      const names = [...Object.keys(outputs), ...artifactsOf(earlier)];
      return `\`${shown}\`: \`${ref.step}\` has no output or artifact \`${ref.name}\` (${listed(names)})`;
    };

    const text = (body: string, where: 'prompt' | 'env', location: Array<string | number>) => {
      for (const ref of templatePaths(body)) {
        const problem = templateProblem(ref, where);
        if (problem) fail(problem, location);
      }
    };

    return { condition, document, text, templateProblem };
  };

  flat.forEach(({ step, path: where }, index) => {
    const at = (...rest: Array<string | number>) => [...path, ...where, ...rest];
    const here = checksAt(index);

    if (step.kind === 'repeat') {
      if (step.if !== undefined) here.condition(step.if, at('if'));
      // Read from just after the loop's last step: every step of the loop is earlier.
      const after = checksAt(index + step.steps.length + 1, false);
      after.condition(step.until, at('repeat', 'until'));
      if (typeof step.onExhausted === 'object') {
        after.text(step.onExhausted.ask, 'prompt', at('on_exhausted', 'gate'));
        step.onExhausted.show.forEach((shown, showIndex) =>
          after.document(shown, at('on_exhausted', 'gate', 'show', showIndex)),
        );
      }
      return;
    }

    if (step.kind === 'agent' && step.action !== undefined && actionProblem)
      fail(actionProblem, at('action'));

    // Only what cannot have acted retries by itself (Call 8): a command that is not safe to run in a dry run may push or post.
    if (
      (step.kind === 'run' || step.kind === 'uses') &&
      (step.onFailure?.retry ?? 0) > 0 &&
      step.dryRun !== 'run'
    )
      fail(
        step.kind === 'run'
          ? `\`${step.id}\` runs a command that may push or post, so it never retries by itself; a person retries it from the run page.`
          : `\`${step.id}\` calls a tool that may post or change things, so it never retries by itself; a person retries it from the run page.`,
        at('on_failure'),
      );

    if (step.if !== undefined) here.condition(step.if, at('if'));

    if (step.kind === 'agent')
      step.reads.forEach((read, readIndex) => here.document(read, at('reads', readIndex)));
    // A path artifact's placeholders name what the items have, as a run-owned branch's do (slice 3-B).
    if (step.kind === 'agent') {
      for (const { path: file } of step.pathArtifacts ?? []) {
        const names = branchPlaceholderNames(file);
        if (itemKind === 'none' && names.length > 0)
          fail(`\`{{${names[0]}}}\`: ${noItem}`, at('artifacts'));
        else if (itemKind === 'untrusted' && names.includes('item.number'))
          fail("A poll's items have no number; use `{{item.key}}`.", at('artifacts'));
      }
    }
    if (step.kind === 'gate')
      step.show.forEach((shown, showIndex) => here.document(shown, at('gate', 'show', showIndex)));

    if (step.kind === 'agent' && step.prompt !== undefined)
      here.text(step.prompt, 'prompt', at('prompt'));
    if (step.kind === 'gate') here.text(step.ask, 'prompt', at('gate', 'ask'));
    if (step.kind === 'run') {
      for (const [name, value] of Object.entries(step.env))
        here.text(value, 'env', at('env', name));
    }
    if (step.kind === 'uses')
      checkUsesStep(step, (ref) => here.templateProblem(ref, 'env'), at, fail);
  });
}

/**
 * Where an entry's item fields can be named, in record order: each leaf's
 * `if:` and templated text, a loop's `if:` and `until`, and its exhaustion
 * gate's question.
 */
function itemUses(
  entries: readonly StepEntry[],
): Array<{ step: string; conditions: string[]; texts: Array<[string, 'prompt' | 'env']> }> {
  return flatSteps(entries).map(({ step }) => {
    if (step.kind === 'repeat') {
      return {
        step: step.id,
        conditions: [...(step.if !== undefined ? [step.if] : []), step.until],
        texts:
          typeof step.onExhausted === 'object'
            ? [[step.onExhausted.ask, 'prompt'] as [string, 'prompt']]
            : [],
      };
    }
    return {
      step: step.id,
      conditions: step.if !== undefined ? [step.if] : [],
      texts: templatedTexts(step),
    };
  });
}

/**
 * Every `item.<field>` the steps use, and where: for the runner's re-check
 * against its connection. A loop's steps are read too, and its `if:`,
 * `until` (as `if`) and exhaustion gate (as `prompt`), under the loop's id.
 */
export function stepItemFields(
  entries: readonly StepEntry[],
): Array<{ step: string; field: string; where: 'prompt' | 'env' | 'if' }> {
  const found: Array<{ step: string; field: string; where: 'prompt' | 'env' | 'if' }> = [];
  for (const { step, conditions, texts } of itemUses(entries)) {
    for (const condition of conditions) {
      const parsed = parseExpression(condition);
      if (parsed.ok) {
        for (const ref of expressionPaths(parsed.expr)) {
          if (ref.kind === 'item') found.push({ step, field: ref.field, where: 'if' });
        }
      }
    }
    for (const [text, where] of texts) {
      for (const ref of templatePaths(text)) {
        if (ref.root === 'item') found.push({ step, field: ref.field, where });
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
  entries: readonly StepEntry[],
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
  for (const { conditions, texts } of itemUses(entries)) {
    for (const condition of conditions) {
      const parsed = parseExpression(condition);
      if (parsed.ok)
        problems.push(...ifItemProblems(parsed.expr, (name, text) => lookup(name, text)?.type));
    }
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

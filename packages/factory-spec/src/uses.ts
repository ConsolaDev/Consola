/**
 * `uses: <server>#<tool>` — a step that calls one MCP tool itself, with no
 * agent and no shell: a server `factory.yml`'s `mcpServers:` defines, or
 * `consola` for Consola's own tools. Its arguments are `with:`, as written;
 * any `{{ path }}` in a string is rendered when the step runs.
 *
 * Imports `template.ts`, `servers.ts` and `permissions.ts`; from `steps.ts` only types, since
 * `steps.ts` imports this file at runtime and hands it the readers every kind
 * of step shares (`StepReaders`), so one implementation reads each key.
 */
import type { OutputType } from './outputs';
import { USES_PERMISSIONS_REASON } from './permissions';
import { MCP_SERVER_NAME_PATTERN } from './servers';
import { parseTemplate, templatePaths, type TemplatePath } from './template';

export const USES_REF_PATTERN = /^([a-z][a-z0-9-]{0,63})#([A-Za-z0-9._-]{1,128})$/;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const MAX_CALL_TIMEOUT_MS = 600_000;
export const ENTRY_USES_REASON = '`uses:` is a step: put it under `steps:`.';

export interface UsesStep {
  id: string;
  /** The id was written in the file (only these can be referenced). */
  named: boolean;
  if?: string;
  kind: 'uses';
  /** `<server>#<tool>` as written; `server` is `consola` or a name under `mcpServers:`. */
  uses: string;
  server: string;
  tool: string;
  /** The arguments as written: YAML scalars, lists and mappings; strings may hold `{{ path }}`. `{}` when absent. */
  with: Record<string, unknown>;
  outputs: Record<string, OutputType>;
  timeoutMs: number;
  dryRun: 'report' | 'run';
  /** `then: stop`: once it completes, the run ends. Present only when the file writes it. */
  stop?: true;
  /** `on_failure: { retry: <n> }`, present only when written; above 0 only with `dry_run: run` (`checkSteps`). */
  onFailure?: { retry: number };
}

type Fail = (message: string, path?: Array<string | number>) => void;

/**
 * The readers `parseStep` uses for every kind of step, handed over by its dispatch line, so one
 * implementation reads each key and this file imports nothing from `steps.ts` at runtime (review Minor 6).
 */
export interface StepReaders {
  idAndIf(
    raw: Record<string, unknown>,
    bad: Fail,
  ): { id: string; named: boolean; condition?: string };
  outputs(raw: unknown, fail: Fail): Record<string, OutputType> | null;
  timeout(value: unknown, fail: Fail): number | null;
  /** `then:` (slice 3's `parseThen`): `stop`, or undefined once it reported. */
  thenStop(value: unknown, fail: Fail): true | undefined;
  /** `on_failure:` (slice 3's `parseRetry`): `{ retry }`, or undefined once it reported. */
  retry(value: unknown, fail: Fail): { retry: number } | undefined;
  /**
   * The reason a key no step takes here is refused with: the run's own (`checkout`, `budget`),
   * a loop's (`on_exhausted`) or a later slice's (`LATER_KEYS`); undefined for any other key.
   */
  refusedKey(key: string): string | undefined;
}

const KEYS = ['id', 'if', 'uses', 'with', 'outputs', 'timeout', 'dry_run', 'then', 'on_failure'];
const NO_AGENT = 'A tool call runs no agent and no shell.';
const READS_NOTHING = 'A tool reads nothing from the run: pass what it needs in `with:`.';
const REFERENCE =
  'Expected `uses` to name a server and one of its tools, e.g. `uses: slack#chat_post_message`.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a step key may not sit beside `uses:`, or undefined. `server`: the step's own, when it names one. */
function companionProblem(key: string, server: string | undefined): string | undefined {
  if (key === 'prompt' || key === 'action' || key === 'run' || key === 'gate')
    return `A step names one thing to do; got uses and ${key}.`;
  if (key === 'agent' || key === 'max_turns' || key === 'environment') return NO_AGENT;
  if (key === 'env') return 'A tool takes its values in `with:`.';
  if (key === 'secrets')
    return `A tool's credentials belong to its server: name them under \`mcpServers.${server ?? '<server>'}.secrets\`.`;
  if (key === 'artifacts' || key === 'reads') return READS_NOTHING;
  if (key === 'permissions') return USES_PERMISSIONS_REASON;
  return undefined;
}

/** `uses:` read: its server and tool, or why it names none. */
function readReference(value: unknown): { server: string; tool: string } | { problem: string } {
  if (typeof value !== 'string' || !value.trim()) return { problem: REFERENCE };
  if (/[/@]/.test(value)) return { problem: 'Pinned references arrive with shared factories.' };
  const at = value.indexOf('#');
  if (at === -1) return { problem: 'Calling an automation arrives with callable automations.' };
  const server = value.slice(0, at);
  const tool = value.slice(at + 1);
  if (USES_REF_PATTERN.test(value)) return { server, tool };
  if (MCP_SERVER_NAME_PATTERN.test(server) && tool.length > 0)
    return {
      problem: `\`${tool}\` is not a tool's name: MCP names are letters, digits, \`.\`, \`_\` and \`-\`, at most 128.`,
    };
  return { problem: REFERENCE };
}

/** Each string in a `with:` value, depth first, with its path; and each mapping, for its keys. */
function walk(
  value: unknown,
  path: Array<string | number>,
  visit: {
    text(text: string, path: Array<string | number>): void;
    mapping?(keys: string[], path: Array<string | number>): void;
  },
): void {
  if (typeof value === 'string') visit.text(value, path);
  else if (Array.isArray(value))
    value.forEach((item, index) => walk(item, [...path, index], visit));
  else if (isRecord(value)) {
    visit.mapping?.(Object.keys(value), path);
    for (const [key, item] of Object.entries(value)) walk(item, [...path, key], visit);
  }
}

/** `with:` as written, or null once anything in it was reported. Absent or YAML null is `{}`. */
function readWith(raw: unknown, bad: Fail): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    bad("Expected `with:` to be a mapping of the tool's arguments.", ['with']);
    return null;
  }
  let ok = true;
  walk(raw, ['with'], {
    mapping(keys, path) {
      for (const key of keys.filter((key) => key.includes('{{'))) {
        ok = false;
        bad(`An argument's name is written as it is: \`${key}\` can't hold \`{{ }}\`.`, path);
      }
    },
    text(text, path) {
      const parsed = parseTemplate(text);
      if (!parsed.ok) {
        ok = false;
        bad(`${parsed.problem[0].toUpperCase()}${parsed.problem.slice(1)}.`, path);
        return;
      }
      const file = parsed.parts.some(
        (part) => part.kind === 'path' && part.path.root !== 'item' && part.path.file,
      );
      if (file) {
        ok = false;
        bad('A tool gets values, not paths on this machine: use the artifact itself.', path);
      }
    },
  });
  return ok ? raw : null;
}

/** One `uses:` step, or null once anything was reported. `fail` paths are relative to the step. */
export function parseUsesStep(
  raw: Record<string, unknown>,
  fail: Fail,
  readers: StepReaders,
): UsesStep | null {
  let ok = true;
  const bad: Fail = (message, path) => {
    ok = false;
    fail(message, path);
  };
  const reference = readReference(raw.uses);
  const named =
    'server' in reference && reference.server !== 'consola' ? reference.server : undefined;

  // Keys: what may not sit beside `uses:`, later slices', then strangers.
  for (const key of Object.keys(raw)) {
    if (KEYS.includes(key)) continue;
    bad(
      companionProblem(key, named) ??
        readers.refusedKey(key) ??
        `Unrecognized key in a step: ${key}.`,
      [key],
    );
  }
  const { id, named: idNamed, condition } = readers.idAndIf(raw, bad);
  if ('problem' in reference) bad(reference.problem, ['uses']);
  const args = readWith(raw.with, bad);

  let outputs: Record<string, OutputType> = {};
  if ('outputs' in raw) {
    const given = raw.outputs;
    if (isRecord(given) && given.from === 'stdout')
      bad(
        "A tool's outputs are its result's fields: declare them by name, e.g. `outputs: { ts: { type: string } }`.",
        ['outputs'],
      );
    else {
      const declared = readers.outputs(given, bad);
      if (declared) outputs = declared;
    }
  }

  let timeoutMs: number | null = DEFAULT_CALL_TIMEOUT_MS;
  if ('timeout' in raw) {
    timeoutMs = readers.timeout(raw.timeout, bad);
    if (timeoutMs !== null && timeoutMs > MAX_CALL_TIMEOUT_MS) {
      bad("A tool call's timeout is at most 10m.", ['timeout']);
      timeoutMs = null;
    }
  }

  let dryRun: 'report' | 'run' = 'report';
  if ('dry_run' in raw) {
    if (raw.dry_run === 'report' || raw.dry_run === 'run') dryRun = raw.dry_run;
    else bad('Expected `dry_run` to be `report` or `run`.', ['dry_run']);
  }

  // Only when written, so a call without them parses, and hashes, as before (slice 3's keys).
  const stop = 'then' in raw ? readers.thenStop(raw.then, bad) : undefined;
  const onFailure = 'on_failure' in raw ? readers.retry(raw.on_failure, bad) : undefined;

  if (!ok || 'problem' in reference || args === null || timeoutMs === null) return null;
  return {
    id,
    named: idNamed,
    ...(condition !== undefined ? { if: condition } : {}),
    kind: 'uses',
    uses: raw.uses as string,
    server: reference.server,
    tool: reference.tool,
    with: args,
    outputs,
    timeoutMs,
    dryRun,
    ...(stop ? { stop } : {}),
    ...(onFailure ? { onFailure } : {}),
  };
}

/** Every string in `with:`, depth first, with its path under `with`: what templates are read from. */
export function usesTexts(step: UsesStep): Array<{ text: string; path: Array<string | number> }> {
  const texts: Array<{ text: string; path: Array<string | number> }> = [];
  walk(step.with, ['with'], { text: (text, path) => texts.push({ text, path }) });
  return texts;
}

/**
 * One call's paths, checked as a command's `env:` values are (`templateProblem` is `checkSteps`' own closure
 * for this step, asked with `'env'`): an unknown step or output is the same issue, at `with.<…>`.
 */
export function checkUsesStep(
  step: UsesStep,
  templateProblem: (ref: TemplatePath) => string | undefined,
  at: (...rest: Array<string | number>) => Array<string | number>,
  fail: (message: string, path: Array<string | number>) => void,
): void {
  for (const { text, path } of usesTexts(step)) {
    for (const ref of templatePaths(text)) {
      const problem = templateProblem(ref);
      if (problem) fail(problem, at(...path));
    }
  }
}

import {
  checkOutputs,
  coerceOutput,
  parseTemplate,
  type McpServerDefinition,
  type OutputType,
  type OutputValue,
  type RunRecord,
  type StepRun,
  type TemplatePath,
  type UsesStep,
} from '@consola/factory-spec';
import type {
  EngineToolContext,
  EngineToolResult,
  McpCallOutcome,
  RunFolderPort,
  ToolsPort,
} from '../ports';
import type { ItemSource } from '../sources/itemSource';
import { previousDocument } from '../sources/previous';
import { clipText, formatDuration, maskSecrets, utf8Bytes } from './commandIO';
import {
  MAX_ARTIFACT_BYTES,
  type CallFile,
  type CallResultFile,
  type RenderedArgument,
  type RunDefinition,
} from './definition';
import { withStep } from './stepRecords';

/*
 * A `uses:` step's call: its `with:` filled in, what `call.json` keeps of it,
 * the records written around the send, and what its answer makes of its
 * outputs. `AutomationService` keeps the order the spec fixes (render, reach,
 * `call.json`, intent, send, result, outputs, close); this reads the run
 * folder only through `RunFolderPort`, and starts nothing.
 */

/** The most a step's templated values may hold together, filled in. */
export const MAX_TEMPLATED_BYTES = 256 * 1024;
/** The most a step's arguments may hold, serialised. */
export const MAX_ARGUMENT_BYTES = 1024 * 1024;
/** The most of a call's answer `result.json` keeps, serialised; past it, the first 1 MB of its text. */
export const CALL_RESULT_CAP_BYTES = 1024 * 1024;
/** Connecting's budget is `min(timeoutMs, CONNECT_BUDGET_CAP_MS)` (Call 8, review Minor 19). */
export const CONNECT_BUDGET_CAP_MS = 120_000;
/** The most of a tool's own error text a step's error repeats. */
export const CALL_ERROR_CHARS = 300;

/** What a call that may have landed is settled with: it was sent, and no clean answer was recorded. */
export function mayHaveHappened(why: string): string {
  return `It may or may not have happened: ${why}. Check, then retry.`;
}

/** What a step's arguments are over, in the step error's words (the caller adds `Nothing was sent.`). */
const OVER_TEMPLATED = 'with: its templated values are over 256 KB';
const OVER_ARGUMENTS = 'with: its arguments are over 1 MB';

const own = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Found = { value: unknown } | { missing: string };

interface RenderInput {
  run: RunRecord;
  definition: RunDefinition;
  step: UsesStep;
  source: ItemSource | undefined;
  polled: Record<string, unknown> | undefined;
  previous: { runId: string } | undefined;
  workspaceId: string;
  folder: RunFolderPort;
}

/** A path's value as it is, typed: an output as recorded, an artifact as its content, an item field as the run has it. */
function pathValue(path: TemplatePath, input: RenderInput): Found {
  const { run, source, polled, previous, workspaceId, folder } = input;
  if (path.root === 'item') {
    const item = run.trigger.item;
    const value = item && source ? source.itemValue(item, path.field, polled) : undefined;
    return value === undefined ? { missing: 'this run has no such item field' } : { value };
  }
  if (path.root === 'previous') {
    const document = previousDocument({
      folder,
      workspaceId,
      previous,
      step: path.step,
      name: path.name,
      file: false,
    });
    return 'value' in document ? document : { missing: document.absent };
  }
  const record = run.steps?.find((candidate) => candidate.id === path.step);
  if (record?.status !== 'completed') return { missing: `${path.step} has not completed` };
  if (record.outputs && own(record.outputs, path.name)) return { value: record.outputs[path.name] };
  const written = (record.artifacts ?? []).some((artifact) => artifact.name === path.name);
  if (!written) return { missing: `${path.step} completed without it` };
  const content = folder.readArtifact(workspaceId, run.id, path.step, record.attempt, path.name);
  return content === null
    ? { missing: 'its file is gone from the run folder' }
    : { value: content };
}

/**
 * `with:` filled in. A string that is exactly one `{{ path }}` takes the path's type (an integer, number or
 * boolean output or item field arrives as a JSON number or boolean; an enum, a string output and an artifact as
 * a string); any other string is filled in as text; literals arrive as written; lists and mappings are walked.
 * It renders once: a value filled in is never read for templates of its own. A path with no value skips the
 * step, naming it; over `MAX_TEMPLATED_BYTES` of filled-in text, or `MAX_ARGUMENT_BYTES` serialised, refuses.
 */
export function renderCallArguments(
  input: RenderInput,
):
  | { ok: true; args: Record<string, unknown>; rendered: RenderedArgument[] }
  | { ok: false; error: string }
  | { skip: string } {
  let templated = 0;
  let lacking: string | undefined;
  let broken: string | undefined;
  const fill = (value: unknown): unknown => {
    if (lacking !== undefined || broken !== undefined) return value;
    if (typeof value === 'string') {
      const parsed = parseTemplate(value);
      if (!parsed.ok) {
        broken = `with: ${parsed.problem}`;
        return value;
      }
      if (!parsed.parts.some((part) => part.kind === 'path')) return value;
      const texts: string[] = [];
      for (const part of parsed.parts) {
        if (part.kind === 'text') {
          texts.push(part.text);
          continue;
        }
        const found = pathValue(part.path, input);
        if ('missing' in found) {
          lacking = `with: ${part.path.text} has no value: ${found.missing}`;
          return value;
        }
        const text = String(found.value);
        templated += utf8Bytes(text);
        // A lone path keeps its type.
        if (parsed.parts.length === 1) return found.value;
        texts.push(text);
      }
      return texts.join('');
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isRecord(value)) {
      const filled: Record<string, unknown> = {};
      for (const key of Object.keys(value)) filled[key] = fill(value[key]);
      return filled;
    }
    return value;
  };
  const { step, definition } = input;
  const args: Record<string, unknown> = {};
  for (const name of Object.keys(step.with)) args[name] = fill(step.with[name]);
  if (lacking !== undefined) return { skip: lacking };
  if (broken !== undefined) return { ok: false, error: broken };
  if (templated > MAX_TEMPLATED_BYTES) return { ok: false, error: OVER_TEMPLATED };
  if (utf8Bytes(JSON.stringify(args)) > MAX_ARGUMENT_BYTES)
    return { ok: false, error: OVER_ARGUMENTS };
  const trusts = definition.calls?.[step.id]?.arguments ?? [];
  const rendered = Object.keys(step.with).map(
    (name): RenderedArgument => ({
      name,
      template: step.with[name],
      value: args[name],
      trust: trusts.find((argument) => argument.name === name)?.trust ?? 'untrusted',
    }),
  );
  return { ok: true, args, rendered };
}

/**
 * A structure with every string masked, keys included (review S9): what `call.json`, `result.json`, `output`
 * and the outputs are made from, before anything is serialised. Two keys that mask to the same text keep both
 * values, the second under `***#2`.
 */
export function maskDeep(value: unknown, masks: readonly string[]): unknown {
  if (typeof value === 'string') return maskSecrets(value, masks);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, masks));
  if (isRecord(value)) {
    const masked: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const base = maskSecrets(key, masks);
      let named = base;
      for (let count = 2; own(masked, named); count++) named = `${base}#${count}`;
      masked[named] = maskDeep(value[key], masks);
    }
    return masked;
  }
  return value;
}

/** "started `<command> <args…>` on this Mac" or "called <url>"; a Consola tool: "Consola's own tool, in process". */
export function reachedOf(server: McpServerDefinition | 'consola'): string {
  if (server === 'consola') return "Consola's own tool, in process";
  if (server.transport === 'http') return `called ${server.url}`;
  return `started \`${[server.command, ...server.args].join(' ')}\` on this Mac`;
}

/** `call.json`: what was (or would have been) sent, every string masked, keys included. */
export function callFileOf(
  input: {
    server: string;
    reached: string;
    tool: string;
    rendered: RenderedArgument[];
    wouldHave?: boolean;
  },
  masks: readonly string[],
): CallFile {
  return {
    server: input.server,
    reached: input.reached,
    tool: input.tool,
    arguments: input.rendered.map((argument) => ({
      name: maskSecrets(argument.name, masks),
      template: maskDeep(argument.template, masks),
      value: maskDeep(argument.value, masks),
      trust: argument.trust,
    })),
    ...(input.wouldHave ? { wouldHave: true as const } : {}),
  };
}

/** The one in-process branch: `run: { tool }` (its `with:` exactly as written) and `uses: consola#…` (rendered). */
export function invokeInProcess(
  registry: ToolsPort,
  call: { tool: string; args: unknown; context: EngineToolContext; mode: 'preview' | 'run' },
): Promise<EngineToolResult> {
  return registry.invoke(call.tool, call.args, call.context, call.mode);
}

/** `records` with the call's attempt started (running, no session, and no `call` an earlier attempt left), as `withAttemptStarted`. */
export function withCallStarted(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  return records.map((record) => {
    if (record.id !== stepId) return record;
    const { sessionId: _sessionId, conversation: _conversation, call: _call, ...rest } = record;
    return { ...rest, status: 'running', startedAt: nowIso };
  });
}

/** `records` with `call.intentAt`: what is written durably right before the send. */
export function withCallIntent(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  const record = records.find((candidate) => candidate.id === stepId);
  return withStep(records, stepId, { call: { ...record?.call, intentAt: nowIso } });
}

/** `records` with the answer recorded: `call.resultAt`, `resultBytes`, and `isError` when it reported one. */
export function withCallResult(
  records: StepRun[],
  stepId: string,
  nowIso: string,
  answer: { isError: boolean; bytes: number },
): StepRun[] {
  const record = records.find((candidate) => candidate.id === stepId);
  return withStep(records, stepId, {
    call: {
      ...record?.call,
      resultAt: nowIso,
      resultBytes: answer.bytes,
      ...(answer.isError ? { isError: true as const } : {}),
    },
  });
}

/** The words a result whose outputs fail is settled with: it did what it does. */
const HAPPENED = 'It happened, but';

/**
 * The declared outputs, coerced and checked as `$CONSOLA_OUTPUT` values are; extra fields are the tool's,
 * never a problem. A Consola tool's `data` is its object; an MCP result's is `resultObjectOf`'s.
 */
export function callOutputs(
  declared: Readonly<Record<string, OutputType>>,
  object: Record<string, unknown> | null,
): { ok: true; outputs: Record<string, OutputValue> } | { ok: false; error: string } {
  const names = Object.keys(declared);
  if (names.length === 0) return { ok: true, outputs: {} };
  if (object === null)
    return { ok: false, error: `${HAPPENED} its result has no \`${names[0]}\`.` };
  const outputs: Record<string, OutputValue> = {};
  for (const name of names) {
    if (!own(object, name))
      return { ok: false, error: `${HAPPENED} its result has no \`${name}\`.` };
    const type = declared[name];
    const raw = object[name];
    // Text is coerced as a command's is: "42" is an integer output's 42.
    const coerced =
      typeof raw === 'string' && type.type !== 'string' && type.type !== 'enum'
        ? coerceOutput(type, raw)
        : null;
    const value = coerced?.ok ? coerced.value : raw;
    const checked = checkOutputs({ [name]: type }, { [name]: value });
    if (checked.problems.length > 0) {
      const problem = checked.problems[0].slice(name.length + 1);
      return { ok: false, error: `${HAPPENED} its result's \`${name}\` ${problem}.` };
    }
    outputs[name] = checked.valid[name];
  }
  return { ok: true, outputs };
}

/** What a server's secret is refused with when the run does not hold it (defensive: the gate read it). */
export const SECRETS_NOT_READ =
  "its server's secrets were not read before it started. Nothing was sent.";

/**
 * A launch from the run's snapshot of the server and the values it holds: a stdio server's `env:` and its own
 * secrets as its environment, or a remote one's headers with each `${NAME}` filled in. Only the server's own
 * secrets go (review S8); a header value with a CR or LF refuses.
 */
export function serverLaunchOf(
  server: McpServerDefinition,
  values: Readonly<Record<string, string>>,
):
  | {
      ok: true;
      launch:
        | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
        | { transport: 'http'; url: string; headers: Record<string, string> };
    }
  | { ok: false; error: string } {
  const names = server.secrets ?? [];
  if (names.some((name) => !own(values, name))) return { ok: false, error: SECRETS_NOT_READ };
  if (server.transport === 'stdio') {
    const env: Record<string, string> = { ...server.env };
    for (const name of names) env[name] = values[name];
    return {
      ok: true,
      launch: { transport: 'stdio', command: server.command, args: [...server.args], env },
    };
  }
  const headers: Record<string, string> = {};
  for (const [header, template] of Object.entries(server.headers)) {
    let broken: string | undefined;
    const value = template.replace(/\$\{([^}]*)\}/g, (whole, name: string) => {
      if (!names.includes(name)) return whole;
      if (broken === undefined && /[\r\n]/.test(values[name])) broken = name;
      return values[name];
    });
    if (broken !== undefined)
      return {
        ok: false,
        error: `Couldn't use \`${broken}\` in a header: its value holds a line break. Nothing was sent.`,
      };
    headers[header] = value;
  }
  return { ok: true, launch: { transport: 'http', url: server.url, headers } };
}

/** The JSON Schema types a declared output takes from a tool's `outputSchema`. */
function acceptedTypes(type: OutputType): string[] {
  switch (type.type) {
    case 'string':
    case 'enum':
      return ['string'];
    case 'integer':
      return ['integer'];
    case 'number':
      return ['number', 'integer'];
    case 'boolean':
      return ['boolean'];
  }
}

/** Each declared output against a tool's `outputSchema`; null when every one is a property of a compatible type (or the tool has none). */
export function outputSchemaProblem(
  declared: Readonly<Record<string, OutputType>>,
  outputSchema: unknown,
  ref: string,
): string | null {
  if (!isRecord(outputSchema)) return null;
  const properties = isRecord(outputSchema.properties) ? outputSchema.properties : {};
  for (const name of Object.keys(declared)) {
    if (!own(properties, name))
      return `\`${ref}\`'s output schema has no \`${name}\`. Nothing was sent.`;
    const property = properties[name];
    const given = isRecord(property) ? property.type : undefined;
    const types =
      typeof given === 'string' ? [given] : Array.isArray(given) ? given.map(String) : [];
    // A property with no type takes anything.
    if (types.length === 0) continue;
    const wanted = acceptedTypes(declared[name]);
    if (!types.some((type) => wanted.includes(type)))
      return `\`${ref}\` returns \`${name}\` as ${types.join(' or ')}, and this step declares it ${declared[name].type}. Nothing was sent.`;
  }
  return null;
}

type Answered = Extract<McpCallOutcome, { kind: 'answered' }>;

/** The text of a content block, when it is one. */
function textOf(block: unknown): string | undefined {
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ? block.text
    : undefined;
}

/** The object outputs are read from: `structuredContent` when it is an object, else the text of the one text block parsed as a JSON object; null otherwise. */
export function resultObjectOf(outcome: Answered): Record<string, unknown> | null {
  if (outcome.structuredContent !== undefined)
    return isRecord(outcome.structuredContent) ? outcome.structuredContent : null;
  if (outcome.content.length !== 1) return null;
  const text = textOf(outcome.content[0]);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The first `bytes` of `text`'s UTF-8, as text. */
function firstBytes(text: string, bytes: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, bytes));
}

/** `result.json`: masked (`maskDeep`), then serialised, then cut at `CALL_RESULT_CAP_BYTES`, so no secret straddles the cut (review S9). */
export function resultFileOf(outcome: Answered, masks: readonly string[]): CallResultFile {
  const result = maskDeep(
    {
      content: outcome.content,
      ...(outcome.structuredContent !== undefined
        ? { structuredContent: outcome.structuredContent }
        : {}),
    },
    masks,
  );
  const text = JSON.stringify(result);
  if (utf8Bytes(text) <= CALL_RESULT_CAP_BYTES)
    return { isError: outcome.isError, bytes: outcome.bytes, result };
  return {
    isError: outcome.isError,
    bytes: outcome.bytes,
    cut: firstBytes(text, CALL_RESULT_CAP_BYTES),
  };
}

/** The `output` artifact: `structuredContent` as JSON or the one text block as text, masked; null over `MAX_ARTIFACT_BYTES` or for anything else. */
export function outputArtifactOf(
  outcome: Answered,
  masks: readonly string[],
): { content: string; format: 'json' | 'text' } | null {
  let found: { content: string; format: 'json' | 'text' } | null = null;
  if (outcome.structuredContent !== undefined)
    found = { content: JSON.stringify(maskDeep(outcome.structuredContent, masks)), format: 'json' };
  else if (outcome.content.length === 1) {
    const text = textOf(outcome.content[0]);
    if (text !== undefined) found = { content: maskSecrets(text, masks), format: 'text' };
  }
  return found && utf8Bytes(found.content) <= MAX_ARTIFACT_BYTES ? found : null;
}

/** Why a call got no clean answer, as the may-or-may-not words say it. */
function unansweredWhy(
  outcome: Extract<McpCallOutcome, { kind: 'unanswered' }>,
  timeoutMs: number,
  masks: readonly string[],
): string {
  switch (outcome.why) {
    case 'timeout':
      return `the call timed out after ${formatDuration(timeoutMs)}`;
    case 'stopped':
      return 'it was stopped while the call ran';
    case 'closed':
      return 'the server closed the connection before answering';
    case 'too-large':
      return 'its answer was over 8 MB';
    case 'unreadable':
      return `its answer could not be read (${clipText(maskSecrets(outcome.detail, masks), CALL_ERROR_CHARS)})`;
  }
}

/** How the step ends, from the outcome (the Failure table): its status, its error, and the record's `call` fields. */
export function callEnd(
  input: {
    ref: string;
    timeoutMs: number;
    outcome: McpCallOutcome;
    outputs?: ReturnType<typeof callOutputs>;
  },
  masks: readonly string[],
): {
  status: 'completed' | 'failed';
  error?: string;
  call: Pick<NonNullable<StepRun['call']>, 'isError' | 'landed'>;
} {
  const { ref, timeoutMs, outcome, outputs } = input;
  if (outcome.kind === 'unanswered')
    return {
      status: 'failed',
      error: mayHaveHappened(unansweredWhy(outcome, timeoutMs, masks)),
      call: {},
    };
  if (outcome.isError) {
    const text = outcome.content.map(textOf).find((found) => found !== undefined);
    const said =
      text === undefined ? 'it gave no text' : clipText(maskSecrets(text, masks), CALL_ERROR_CHARS);
    return { status: 'failed', error: `\`${ref}\` failed: ${said}`, call: { isError: true } };
  }
  if (outputs && !outputs.ok)
    return { status: 'failed', error: outputs.error, call: { landed: true } };
  return { status: 'completed', call: { landed: true } };
}

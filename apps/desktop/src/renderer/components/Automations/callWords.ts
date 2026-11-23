import type {
  CallArgument,
  CallFile,
  CallResultFile,
  RenderedArgument,
  StepRun,
  ValueSource,
} from '../../../shared/automations';

/**
 * Every sentence the renderer says about a `uses:` step, its server and
 * Check server, from the engine's views alone. The renderer interprets
 * nothing: it words what the engine recorded (trust, sources, what was
 * reached, what came back), and the engine's own error sentences are shown
 * as they are.
 */

/** What a step is, as the trace row, the pipeline and the run graph label it. */
export function stepKindLabel(kind: StepRun['kind']): 'Agent' | 'Command' | 'Tool' {
  if (kind === 'agent') return 'Agent';
  return kind === 'uses' ? 'Tool' : 'Command';
}

/** An argument's trust, as the card and the detail label it. */
export function trustLabel(
  trust: CallArgument['trust'],
): '(literal)' | '(trusted)' | '(untrusted material)' {
  if (trust === 'literal') return '(literal)';
  return trust === 'trusted' ? '(trusted)' : '(untrusted material)';
}

/** Where a value comes from: `` `brief`'s handover ``, `` `item.ts` (from the item) ``. */
export function sourceWords(source: ValueSource): string {
  switch (source.kind) {
    case 'item':
      return `\`item.${source.field}\` (from the item)`;
    case 'previous':
      return `\`previous.${source.step}.${source.name}\` (from the last run)`;
    case 'artifact':
      return source.name === 'handover'
        ? `\`${source.step}\`'s handover`
        : `\`${source.step}\`'s \`${source.name}\``;
    case 'output':
      return `\`${source.step}\`'s \`${source.name}\``;
  }
}

/** A sent value past this many lines, or characters, folds behind a disclosure. */
const LONG_LINES = 3;
const LONG_CHARS = 300;

/** Text as written, or a value's JSON: compact for a template, indented for what was sent. */
function textOf(value: unknown, indent: boolean): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, indent ? 2 : undefined) ?? String(value);
}

/**
 * The detail's line for one argument as sent: "`text` = {{steps.brief.handover}} → <value>"
 * and its trust label; a literal's line has no template part. `head` and
 * `label` are the line's two ends, for a long value shown folded between them.
 */
export function sentArgumentLine(argument: RenderedArgument): {
  line: string;
  head: string;
  value: string;
  label: string;
  long: boolean;
} {
  const value = textOf(argument.value, true);
  const label = trustLabel(argument.trust);
  const head =
    argument.trust === 'literal'
      ? `\`${argument.name}\` = `
      : `\`${argument.name}\` = ${textOf(argument.template, false)} → `;
  return {
    line: `${head}${value} ${label}`,
    head,
    value,
    label,
    long: value.split('\n').length > LONG_LINES || value.length > LONG_CHARS,
  };
}

/** The retry warnings of a call, word for word (the spec's *Failure* table). */
export const CALL_ERROR_WARNING =
  'The tool reported an error after it was called; it may have done part of its work. Check before calling it again.';
export const CALL_HAPPENED_WARNING = 'This call already happened.';
export const CALL_MAY_HAVE_WARNING =
  'This call may already have happened; check before calling it again.';

/**
 * What Retry warns before it retries a call, or null (Call 23), from the
 * record alone: an error the tool reported; an answer that came back; an
 * intent with no clean answer. Nothing sent: null. Only a call's record
 * holds `call`, so any other step reads null too.
 */
export function callRetryWarning(step: StepRun): string | null {
  const call = step.call;
  if (call?.isError) return CALL_ERROR_WARNING;
  if (call?.landed || call?.resultAt) return CALL_HAPPENED_WARNING;
  if (call?.intentAt) return CALL_MAY_HAVE_WARNING;
  return null;
}

/** Said when a process a call started outlived its end. */
export const SURVIVORS_LINE = 'Something it started was still running after it was stopped.';

/** The detail's head: "Would have called" under a dry run, how it was reached, and what survived. */
export function callHead(
  call: CallFile | undefined,
  record: StepRun,
): { heading: string | null; reached: string | null; survivors: string | null } {
  return {
    heading: call?.wouldHave ? 'Would have called' : null,
    reached: call?.reached ?? null,
    survivors: (record.call?.survivors ?? 0) > 0 ? SURVIVORS_LINE : null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A result's text blocks, one per line; a block of another type by its type. */
function blocksText(content: unknown[]): string {
  return content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : `[${isRecord(block) && typeof block.type === 'string' ? block.type : 'block'}]`,
    )
    .join('\n');
}

/**
 * The result as the detail shows it: its state, and its text (folded past
 * 40 lines by the view). A Consola tool's summary, then its data; a
 * server's structured content as JSON, else its text blocks; a result cut at
 * 1 MB as the part that was kept.
 */
export function resultView(result: CallResultFile | undefined): {
  state: 'error' | 'ok' | 'cut' | 'none';
  text: string;
} {
  if (!result) return { state: 'none', text: '' };
  if (result.cut !== undefined) return { state: 'cut', text: result.cut };
  const state = result.isError ? 'error' : 'ok';
  const body = result.result;
  if (result.summary !== undefined) {
    const data = body === undefined || body === null ? '' : `\n\n${textOf(body, true)}`;
    return { state, text: `${result.summary}${data}` };
  }
  if (isRecord(body) && body.structuredContent !== undefined)
    return { state, text: textOf(body.structuredContent, true) };
  if (isRecord(body) && Array.isArray(body.content))
    return { state, text: blocksText(body.content) };
  return { state, text: body === undefined ? '' : textOf(body, true) };
}

/** A result's text folds past this many lines, behind Show all. */
export const RESULT_FOLD_LINES = 40;

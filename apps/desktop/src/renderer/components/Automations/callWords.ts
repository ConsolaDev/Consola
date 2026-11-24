import type {
  CallArgument,
  CallFile,
  CallResultFile,
  CallView,
  RenderedArgument,
  ServerCheckView,
  ServerFacts,
  StepRun,
  ValueSource,
} from '../../../shared/automations';
import { formatChangedAt } from '../WorkspaceSettings/secretsWords';

/**
 * Every sentence the renderer says about a `uses:` step, its server and
 * Check server, from the engine's views alone. The renderer interprets
 * nothing: it words what the engine recorded (trust, sources, what was
 * reached, what came back), and the engine's own error sentences are shown
 * as they are.
 */

/** What a step is, as the trace row, the pipeline and the run graph label it. */
export function stepKindLabel(
  kind: StepRun['kind'],
): 'Agent' | 'Gate' | 'Loop' | 'Tool' | 'Command' {
  if (kind === 'agent') return 'Agent';
  if (kind === 'gate') return 'Gate';
  if (kind === 'repeat') return 'Loop';
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

// --- The cards, the servers and Check server (Task 15) ---------------------------------------

/**
 * The card's line for one argument: "`text` ← `brief`'s handover (untrusted material)",
 * "`channel` = C0SUPPORT1 (literal)"; then its notice, when it has one. A
 * card shows where a value comes from, never a value: none exists yet.
 */
export function cardArgumentLines(argument: CallArgument): string[] {
  const label = trustLabel(argument.trust);
  // A literal is exactly an argument with no path (factory-spec's `callArguments`).
  const line =
    argument.trust === 'literal'
      ? `\`${argument.name}\` = ${textOf(argument.template, false)} ${label}`
      : `\`${argument.name}\` ← ${argument.sources.map(sourceWords).join(', ')} ${label}`;
  return argument.notice !== undefined ? [line, argument.notice] : [line];
}

/** A Consola tool that changes things, in `steps:` (the spec's, generalised). */
export const DESTRUCTIVE_TOOL_NOTE =
  'It acts on what is true when this step runs; approving the run does not approve a list.';
export const ALSO_IN_DRY_RUN = 'also runs in a dry run';

/** A call's lines on a card: its ref, its arguments, its outputs ("Outputs: ts"), "also runs in a dry run", a destructive tool's note. */
export function callCardLines(call: CallView, outputs: readonly string[]): string[] {
  return [
    `Calls \`${call.ref}\``,
    ...call.arguments.flatMap(cardArgumentLines),
    ...(outputs.length > 0 ? [`Outputs: ${outputs.join(', ')}`] : []),
    ...(call.alsoInDryRun ? [ALSO_IN_DRY_RUN] : []),
    ...(call.destructive ? [DESTRUCTIVE_TOOL_NOTE] : []),
  ];
}

/** Each factory server the calls name, once, in the order the calls name them; a Consola call names none. */
export function serversOf(calls: readonly CallView[]): ServerFacts[] {
  const seen = new Map<string, ServerFacts>();
  for (const call of calls)
    if (call.facts && !seen.has(call.facts.name)) seen.set(call.facts.name, call.facts);
  return [...seen.values()];
}

export const SERVER_STARTED_LINE = 'Started for each call and stopped after.';
export const LAUNCHER_NOTE =
  'A pinned version still fetches its dependencies when it starts; an installed program by absolute path does not.';
export const UNPINNED_WARNING = 'This runs the newest version at every call, unattended; pin one.';

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The headers a remote server's secrets make: "an `Authorization` header made from TOKEN". */
function headerWords(headers: NonNullable<ServerFacts['secretHeaders']>): string {
  const names = headers.map(({ header }) => `\`${header}\``);
  const secrets: string[] = [];
  for (const { secrets: named } of headers)
    for (const name of named) if (!secrets.includes(name)) secrets.push(name);
  const which =
    names.length === 1
      ? `${/^[aeiou]/i.test(headers[0].header) ? 'an' : 'a'} ${names[0]} header`
      : `${andList(names)} headers`;
  return `${which} made from ${andList(secrets)}`;
}

/** A server's own line: what it starts (stdio) or calls (http), as you, with what. */
function serverLine(facts: ServerFacts): string {
  if (facts.transport === 'http') {
    const headers = facts.secretHeaders ?? [];
    return headers.length > 0
      ? `calls ${facts.target} with ${headerWords(headers)}`
      : `calls ${facts.target}`;
  }
  return `starts \`${facts.target}\` on this Mac as you, with your files and network, in an empty folder, with ${andList(facts.environment ?? [])}`;
}

/**
 * A server's definition in full past its line (review S1): each literal
 * `env:` pair (`env: \`NAME=value\``) and each header as written (`header:
 * \`Name: value\``), a header made from a secret as its template. The card
 * shows every literal, so a credential the file's heuristic missed is seen.
 */
function literalLines(facts: ServerFacts): string[] {
  return [
    ...(facts.env ?? []).map(({ name, value }) => `env: \`${name}=${value}\``),
    ...(facts.headers ?? []).map(({ name, value }) => `header: \`${name}: ${value}\``),
  ];
}

/** A server's lines (the spec's): what it starts or calls, as you, with what; its literal `env:` and headers; "Started for each call and stopped after."; the npx note; the unpinned warning. */
export function serverLines(facts: ServerFacts): string[] {
  return [
    serverLine(facts),
    ...literalLines(facts),
    SERVER_STARTED_LINE,
    ...(facts.launcher ? [LAUNCHER_NOTE] : []),
    ...(facts.unpinned ? [UNPINNED_WARNING] : []),
  ];
}

export const CHECK_DIALOG_SENTENCE =
  'Consola starts it once, lists its tools and stops it. It calls no tool.';

/** Check server's dialog: its question and what it starts, its definition in full (review S1). */
export function checkDialogLines(facts: ServerFacts): { title: string; lines: string[] } {
  return {
    title: `Check \`${facts.name}\`?`,
    lines: [serverLine(facts), ...literalLines(facts), CHECK_DIALOG_SENTENCE],
  };
}

/** What a check found: when, how many tools (or why it could not tell), each call's verdict, and what survived it. */
export function checkResultLines(view: ServerCheckView, at: { timeZone?: string }): string[] {
  const when = formatChangedAt(view.at, at, { time: true }) ?? view.at;
  const count = view.tools?.length ?? 0;
  const lines = [
    view.problem !== undefined
      ? `Checked ${when}: ${view.problem}`
      : `Checked ${when}: ${count} ${count === 1 ? 'tool' : 'tools'}.`,
  ];
  for (const { step, tool, verdict } of view.steps) {
    if (verdict === 'fits')
      lines.push(`\`${step}\`: \`${tool}\` is there, and its literal values fit`);
    else if (verdict === 'missing')
      lines.push(`\`${step}\`: \`${view.server}\` has no \`${tool}\``);
    else lines.push(`\`${step}\`: ${verdict.problem}`);
  }
  if ((view.survivors ?? 0) > 0) lines.push(SURVIVORS_LINE);
  return lines;
}

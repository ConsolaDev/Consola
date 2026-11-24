import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type {
  ConversationEntry,
  ConversationRecord,
  ConversationWindow,
} from '../../shared/conversation';
import { capText, ConversationBuilder } from '../conversationBuilder';

/**
 * A Codex conversation read from its rollout file
 * (`<CODEX_HOME>/sessions/…/rollout-…-<thread>.jsonl`), in the shape every
 * driver reads into. Never by resuming it.
 *
 * Each line is an envelope `{ timestamp, type, payload }`. What a person saw
 * is the `response_item` lines: user and assistant messages, tool calls, and
 * their results — which say when a call ended and whether it failed, never
 * what it returned. Reasoning, token counts, turn and session metadata are
 * not part of the conversation.
 *
 * The format is the CLI's own, not a promised contract, so it is read the way
 * AGENTS.md asks for one: a line cut off mid-write is skipped, but a file
 * whose lines are none of them envelopes throws, rather than reading as a
 * conversation where nothing was said.
 */

const MAX_DETAIL_CHARS = 120;

/** Argument names tried, in order, for the one-line detail of a tool call. */
const DETAIL_KEYS = ['cmd', 'command', 'path', 'file_path', 'pattern', 'query', 'url'];

/** What Codex puts in a user message that the person did not type. */
const INJECTED_CONTEXT = [/^<([a-z_]+)>[\s\S]*<\/\1>$/, /^# AGENTS\.md instructions/];

interface Envelope {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface ResponseItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  input?: unknown;
  call_id?: unknown;
  output?: unknown;
}

type Step = Extract<ConversationEntry, { kind: 'step' }>;

function oneLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  return line ? line.slice(0, MAX_DETAIL_CHARS) : undefined;
}

function textParts(content: unknown, partType: string): string {
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .filter((part): part is { type: string; text: string } => {
      const fields = part as { type?: unknown; text?: unknown } | null;
      return !!fields && fields.type === partType && typeof fields.text === 'string';
    })
    .map((part) => part.text)
    .join('\n\n');
}

/** A function call's arguments, a JSON string: the first argument that reads as a detail. */
function argumentDetail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return oneLine(raw);
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  for (const key of DETAIL_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
    if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
      return oneLine(value.join(' '));
  }
  return undefined;
}

/** A custom tool's free-form input: the files a patch touches, else its first line. */
function inputDetail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const files = [...raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  return files.length > 0 ? files.join(', ').slice(0, MAX_DETAIL_CHARS) : oneLine(raw);
}

/** A result that says outright that its command failed. Anything less certain is not a failure. */
function resultFailed(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  try {
    const parsed = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
    const code = parsed?.metadata?.exit_code;
    return typeof code === 'number' && code !== 0;
  } catch {
    return false;
  }
}

/**
 * The conversation in rollout lines, oldest first. Only records inside
 * `window` count; a record without a timestamp counts as inside.
 */
export async function codexConversationFromLines(
  lines: Iterable<string> | AsyncIterable<string>,
  window: ConversationWindow = {},
): Promise<ConversationRecord> {
  const since = window.since ? Date.parse(window.since) : Number.NaN;
  const until = window.until ? Date.parse(window.until) : Number.NaN;
  const conversation = new ConversationBuilder();
  const awaitingResult = new Map<string, Step>();
  let parsedLines = 0;
  let envelopes = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: Envelope;
    try {
      record = JSON.parse(line) as Envelope;
    } catch {
      continue;
    }
    parsedLines++;
    if (
      !record ||
      typeof record.type !== 'string' ||
      !record.payload ||
      typeof record.payload !== 'object'
    )
      continue;
    envelopes++;
    if (record.type !== 'response_item') continue;

    const at = typeof record.timestamp === 'string' ? record.timestamp : undefined;
    const time = at ? Date.parse(at) : Number.NaN;
    if (!Number.isNaN(time)) {
      if (!Number.isNaN(since) && time < since) continue;
      if (!Number.isNaN(until) && time > until) continue;
    }
    const stamp = at ? { at } : {};
    const item = record.payload as ResponseItem;

    if (item.type === 'message' && item.role === 'user') {
      const text = textParts(item.content, 'input_text');
      const trimmed = text.trim();
      if (trimmed === '' || INJECTED_CONTEXT.some((pattern) => pattern.test(trimmed))) continue;
      conversation.add({ kind: 'prompt', text: capText(text), ...stamp });
    } else if (item.type === 'message' && item.role === 'assistant') {
      const text = textParts(item.content, 'output_text');
      if (text.trim() !== '') conversation.add({ kind: 'text', text: capText(text), ...stamp });
    } else if (
      (item.type === 'function_call' || item.type === 'custom_tool_call') &&
      typeof item.name === 'string'
    ) {
      const detail =
        item.type === 'function_call' ? argumentDetail(item.arguments) : inputDetail(item.input);
      const step: Step = { kind: 'step', tool: item.name, ...(detail ? { detail } : {}), ...stamp };
      if (typeof item.call_id === 'string') awaitingResult.set(item.call_id, step);
      conversation.add(step);
    } else if (
      (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') &&
      typeof item.call_id === 'string'
    ) {
      const step = awaitingResult.get(item.call_id);
      if (!step) continue;
      awaitingResult.delete(item.call_id);
      if (at) step.endedAt = at;
      if (resultFailed(item.output)) step.failed = true;
    }
  }

  if (parsedLines > 0 && envelopes === 0) {
    throw new Error('This Codex conversation is in a format Consola does not recognise.');
  }
  return conversation.build();
}

/** The conversation in a rollout file, streamed: a long-running thread's file is large. */
export async function readCodexRollout(
  file: string,
  window?: ConversationWindow,
): Promise<ConversationRecord> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await codexConversationFromLines(lines, window);
  } finally {
    lines.close();
    stream.destroy();
  }
}

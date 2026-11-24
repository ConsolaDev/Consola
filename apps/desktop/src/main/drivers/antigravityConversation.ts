import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { ConversationRecord, ConversationWindow } from '../../shared/conversation';
import { capText, ConversationBuilder } from '../conversationBuilder';

/**
 * An Antigravity conversation read from its transcript file
 * (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`),
 * in the shape every driver reads into. Never by resuming it.
 *
 * Each line is one step `{ step_index, source, type, status, created_at, content, tool_calls }`.
 * What a person saw is `USER_INPUT` prompts, `PLANNER_RESPONSE` tool calls, and
 * `PLANNER_RESPONSE` response text. Reasoning (`thinking`), tool output (`GENERIC`),
 * and injected system messages (`SYSTEM_MESSAGE`) are not part of the conversation.
 *
 * The format is the CLI's own, not a promised contract, so a line cut off mid-write
 * is skipped, while a file whose parsed lines match none of these records throws
 * rather than reading as an empty conversation.
 */

const MAX_DETAIL_CHARS = 120;

/** Argument names tried, in order, for the one-line detail of a tool call. */
const DETAIL_KEYS = [
  'CommandLine',
  'command',
  'cmd',
  'Path',
  'path',
  'file_path',
  'Query',
  'query',
  'Pattern',
  'pattern',
  'Url',
  'url',
  'toolSummary',
  'Role',
  'Description',
  'description',
];

const USER_REQUEST_BLOCK = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const METADATA_BLOCKS =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;

interface TranscriptStep {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

interface ToolCallEntry {
  name?: unknown;
  args?: unknown;
}

function oneLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  return line ? line.slice(0, MAX_DETAIL_CHARS) : undefined;
}

/**
 * Antigravity serializes string tool arguments inside `args` as JSON-quoted
 * strings (e.g. `"\"git status\""`). Unwrap one level when valid.
 */
function unwrapArgString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return oneLine(parsed);
    } catch {
      // Keep the raw string when it is not valid JSON.
    }
  }
  return oneLine(trimmed);
}

function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    const detail = unwrapArgString(value);
    if (detail) return detail;
  }
  return undefined;
}

/**
 * Extract the person's actual prompt from a `USER_INPUT` step.
 *
 * Antigravity wraps user messages in `<USER_REQUEST>...</USER_REQUEST>` beside
 * `<ADDITIONAL_METADATA>` and `<USER_SETTINGS_CHANGE>` blocks. Plain user text
 * without tags is returned trimmed as-is.
 */
export function extractUserPrompt(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const tagged = USER_REQUEST_BLOCK.exec(content);
  if (tagged) {
    const inner = tagged[1].trim();
    return inner || null;
  }
  const stripped = content.replace(METADATA_BLOCKS, '').trim();
  return stripped || null;
}

function isStepRecord(record: unknown): record is TranscriptStep {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const candidate = record as TranscriptStep;
  return typeof candidate.type === 'string' && typeof candidate.step_index === 'number';
}

/**
 * The conversation in transcript lines, oldest first. Only records inside
 * `window` count; a record without a timestamp counts as inside.
 */
export async function antigravityConversationFromLines(
  lines: Iterable<string> | AsyncIterable<string>,
  window: ConversationWindow = {},
): Promise<ConversationRecord> {
  const since = window.since ? Date.parse(window.since) : Number.NaN;
  const until = window.until ? Date.parse(window.until) : Number.NaN;
  const conversation = new ConversationBuilder();
  let parsedLines = 0;
  let validSteps = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    parsedLines++;
    if (!isStepRecord(parsed)) continue;
    validSteps++;

    const at = typeof parsed.created_at === 'string' ? parsed.created_at : undefined;
    const time = at ? Date.parse(at) : Number.NaN;
    if (!Number.isNaN(time)) {
      if (!Number.isNaN(since) && time < since) continue;
      if (!Number.isNaN(until) && time > until) continue;
    }
    const stamp = at ? { at } : {};

    if (parsed.type === 'USER_INPUT' && parsed.source !== 'SYSTEM') {
      const prompt = extractUserPrompt(parsed.content);
      if (prompt) conversation.add({ kind: 'prompt', text: capText(prompt), ...stamp });
    } else if (parsed.type === 'PLANNER_RESPONSE') {
      if (Array.isArray(parsed.tool_calls)) {
        for (const rawCall of parsed.tool_calls) {
          if (!rawCall || typeof rawCall !== 'object') continue;
          const call = rawCall as ToolCallEntry;
          if (typeof call.name !== 'string' || !call.name) continue;
          const detail = toolDetail(call.args);
          conversation.add({
            kind: 'step',
            tool: call.name,
            ...(detail ? { detail } : {}),
            ...stamp,
          });
        }
      }
      if (typeof parsed.content === 'string' && parsed.content.trim() !== '') {
        conversation.add({ kind: 'text', text: capText(parsed.content), ...stamp });
      }
    }
  }

  if (parsedLines > 0 && validSteps === 0) {
    throw new Error('This Antigravity conversation is in a format Consola does not recognise.');
  }
  return conversation.build();
}

/** The conversation in a transcript file, streamed. */
export async function readAntigravityTranscript(
  file: string,
  window?: ConversationWindow,
): Promise<ConversationRecord> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await antigravityConversationFromLines(lines, window);
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * The first real user message in an Antigravity transcript, outer whitespace
 * trimmed. Null when there is none yet.
 */
export async function readAntigravityFirstPrompt(file: string): Promise<string | null> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isStepRecord(parsed)) continue;
      if (parsed.type !== 'USER_INPUT' || parsed.source === 'SYSTEM') continue;
      const prompt = extractUserPrompt(parsed.content);
      if (prompt) return prompt;
    }
  } catch {
    // A new transcript may not have been flushed yet.
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

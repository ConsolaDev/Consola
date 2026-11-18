import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  ConversationEntry,
  ConversationRecord,
  ConversationWindow,
} from '../shared/conversation';
import { capText, ConversationBuilder } from './conversationBuilder';
import { getLoginEnv } from './LoginEnvironment';
import type { CliNameRead } from './drivers/HarnessDriver';

/**
 * Access to Claude Code's own session storage: read-only, except that a
 * harness switch copies a conversation into another config directory
 * (`copyConversation`), never overwriting anything there.
 *
 * Claude keeps each conversation as `<config>/projects/<project>/<id>.jsonl`.
 * Consola assigns each tab's session ID, so it can look its sessions up here
 * instead of tracking conversation state separately.
 *
 * The transcript is the only source. Claude's `sessions-index.json` is a cache
 * that lags and holds summaries Claude generates itself, and is never read.
 */

/**
 * Where Claude keeps its projects.
 *
 * Each harness can point at its own config directory, so lookups are scoped to
 * the one the session was actually launched under. With none given this falls
 * back to the ambient environment the spawned CLI would see, so a user who
 * sets CLAUDE_CONFIG_DIR in their shell keeps being looked up in the directory
 * their sessions really live in.
 */
function getProjectsDir(configDir?: string): string {
  const resolved =
    configDir || getLoginEnv().CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(resolved, 'projects');
}

function listProjectDirs(configDir?: string): string[] {
  const projectsDir = getProjectsDir(configDir);
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir, entry.name));
  } catch {
    // No projects directory yet — Claude has never run.
    return [];
  }
}

/**
 * The transcript file for a session, if Claude has written one.
 *
 * Located by probing each project directory for `<sessionId>.jsonl` rather than
 * deriving the directory name from the working directory: that encoding is
 * lossy, whereas the file name is exactly the session ID.
 */
export function findSessionFile(sessionId: string, configDir?: string): string | null {
  for (const dir of listProjectDirs(configDir)) {
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Make a conversation stored under one config directory forkable from
 * another: its transcript, and the folder beside it that holds its
 * subagents' transcripts and session memory, copied into the same project
 * folder there. The folder keeps the source's own name rather than one
 * derived from a working directory, an encoding that is lossy.
 *
 * Never overwrites. A conversation the target already holds — two harnesses
 * sharing a config directory, or a switch back to where it came from — is
 * left exactly as it is, and reported `present`. `missing` when there is no
 * transcript to carry: Claude writes one only once a message is sent. The
 * transcript is copied under a temporary name and moved into place, so a
 * copy cut short never passes for one. Throws when the copy is not where it
 * was written: a fork launched against a missing file fails.
 */
export async function copyConversation(
  sessionId: string,
  fromConfigDir: string | undefined,
  toConfigDir: string | undefined,
): Promise<'copied' | 'present' | 'missing'> {
  const source = findSessionFile(sessionId, fromConfigDir);
  if (!source) return 'missing';

  const projectDir = path.join(getProjectsDir(toConfigDir), path.basename(path.dirname(source)));
  const target = path.join(projectDir, `${sessionId}.jsonl`);
  if (path.resolve(target) === path.resolve(source) || fs.existsSync(target)) return 'present';

  await fsp.mkdir(projectDir, { recursive: true });
  const partial = path.join(projectDir, `.${sessionId}.jsonl.${process.pid}.partial`);
  try {
    await fsp.copyFile(source, partial);
    // Checked again: the target may have appeared during the copy.
    if (fs.existsSync(target)) return 'present';
    await fsp.rename(partial, target);
  } finally {
    await fsp.rm(partial, { force: true });
  }

  const siblings = path.join(path.dirname(source), sessionId);
  if (fs.existsSync(siblings)) {
    await fsp.cp(siblings, path.join(projectDir, sessionId), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }

  if (!fs.existsSync(target)) {
    throw new Error(`The conversation could not be copied to ${projectDir}.`);
  }
  return 'copied';
}

/**
 * The first message the person actually wrote, read straight from the
 * transcript. `null` when there is no transcript or no real message yet.
 *
 * Streams line by line and stops at the first qualifying record. A line that
 * does not parse — a record caught mid-write — is skipped, never taken for a
 * message. Records that are not the person's own words are skipped: meta and
 * sidechain records, images and tool results (no text), built-in commands and
 * their output, bash lines, task notifications, `#` memory lines and injected
 * skill text. A skill command's own words are its `<command-args>`.
 */
export async function readFirstUserPrompt(
  sessionId: string,
  configDir: string | undefined,
): Promise<string | null> {
  const file = findSessionFile(sessionId, configDir);
  if (!file) return null;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      let record: {
        type?: string;
        isSidechain?: boolean;
        isMeta?: boolean;
        message?: { content?: unknown };
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || record.type !== 'user') continue;
      if (record.isMeta === true || record.isSidechain === true) continue;

      const content = record.message?.content;
      const text = (typeof content === 'string' ? content : textBlocks(content).join(' ')).trim();
      if (!text) continue;

      if (text.startsWith('<command-message>')) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        if (args) return args;
        continue;
      }
      if (
        text.startsWith('<') ||
        text.startsWith('#') ||
        text.startsWith('Base directory for this skill:')
      ) {
        continue;
      }
      return text;
    }
  } catch {
    // Unreadable part-way: no message found yet.
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/** Bytes read from a transcript at a time when following renames. */
const TITLE_CHUNK_BYTES = 64 * 1024;

/**
 * The name the person last gave a conversation inside the CLI (`/rename`),
 * among the complete records after `from`. `next` is the position to pass
 * next time: just past the last complete line, so a record still being
 * written is read once it is whole, never half. A `from` beyond the file's
 * size means the file was replaced, so reading starts over at 0. `null` when
 * there is no transcript.
 *
 * Reads in chunks, so a long conversation costs what was appended since, not
 * the whole file.
 */
export async function readCustomTitleSince(
  sessionId: string,
  configDir: string | undefined,
  from: number,
): Promise<CliNameRead | null> {
  const file = findSessionFile(sessionId, configDir);
  if (!file) return null;

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    let position = from > size || from < 0 ? 0 : from;
    let name: string | null = null;
    let next = position;
    // Bytes of an unfinished line carried into the next chunk.
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.alloc(TITLE_CHUNK_BYTES);

    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      let data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry = data;
        continue;
      }
      carry = Buffer.from(data.subarray(lastNewline + 1));
      data = data.subarray(0, lastNewline + 1);
      next = position - carry.length;

      for (const line of data.toString('utf8').split('\n')) {
        if (!line.includes('"custom-title"')) continue;
        try {
          const record = JSON.parse(line) as { type?: string; customTitle?: unknown };
          if (record?.type === 'custom-title' && typeof record.customTitle === 'string') {
            name = record.customTitle;
          }
        } catch {
          // Not a record: leave the name as it was.
        }
      }
    }
    return { name, next };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Longest reply handed out; the tail is kept, since a reply's conclusion is its end. */
export const MAX_REPLY_CHARS = 4_000;

type TranscriptBlock = { type?: string; text?: string };

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as TranscriptBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b) => b.text as string);
}

/** Backwards read size, and the most one call reads looking for `count` turns. */
const REPLY_CHUNK_BYTES = 64 * 1024;
const REPLY_SCAN_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * What the assistant last said, one entry per turn, oldest first.
 *
 * A turn opens at a real user prompt and runs through its tool calls: a user
 * record holding only tool results continues the turn instead of ending it,
 * and a meta record (injected context, not something the person typed) never
 * opens one. Subagent sidechains are another conversation and are skipped.
 * `null` means there is no transcript; a transcript with no replies yields `[]`.
 *
 * Read backwards in chunks, like `readSessionModel`, so a long conversation
 * costs its last few turns instead of freezing the main process on the whole
 * file. A turn is complete once its opening prompt is reached.
 */
export async function readRecentReplies(
  sessionId: string,
  configDir: string | undefined,
  count: number,
): Promise<string[] | null> {
  const file = findSessionFile(sessionId, configDir);
  if (!file) return null;
  if (count <= 0) return [];

  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();

    const replies: string[] = []; // newest first while scanning
    let pending: string[][] = []; // the open turn's text blocks, newest first

    const closeTurn = (): void => {
      const reply = pending.reverse().flat().join('\n\n');
      pending = [];
      if (reply.trim() !== '') replies.push(reply);
    };

    /** Returns true once `count` turns are collected. */
    const readLine = (line: string): boolean => {
      if (!line.trim()) return false;

      let record: {
        type?: string;
        isSidechain?: boolean;
        isMeta?: boolean;
        message?: { content?: unknown };
      };
      try {
        record = JSON.parse(line);
      } catch {
        // The last line can be mid-write.
        return false;
      }
      if (record.isSidechain === true) return false;

      const content = record.message?.content;
      if (record.type === 'user') {
        if (record.isMeta === true) return false;
        const startsTurn =
          typeof content === 'string' ? content.trim() !== '' : textBlocks(content).length > 0;
        if (startsTurn) {
          closeTurn();
          return replies.length >= count;
        }
      } else if (record.type === 'assistant') {
        pending.push(textBlocks(content));
      }
      return false;
    };

    let position = size;
    let scanned = 0;
    let remainder = Buffer.alloc(0);
    let done = false;
    while (position > 0 && !done && scanned < REPLY_SCAN_LIMIT_BYTES) {
      const length = Math.min(position, REPLY_CHUNK_BYTES);
      position -= length;
      scanned += length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
      const start = position === 0 ? 0 : data.indexOf(10) + 1;
      // Keep an incomplete first line for the next chunk. Buffers preserve
      // UTF-8 characters split at a chunk boundary.
      remainder = start === 0 && position > 0 ? data : data.subarray(0, start);
      if (start === 0 && position > 0) continue;
      const lines = data.subarray(start).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && !done; i--) done = readLine(lines[i]);
    }
    // Reached the start of the file: whatever is still open is the first turn.
    if (!done && position === 0) closeTurn();

    return replies
      .slice(0, count)
      .reverse()
      .map((reply) =>
        reply.length > MAX_REPLY_CHARS ? '…' + reply.slice(-(MAX_REPLY_CHARS - 1)) : reply,
      );
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export { MAX_CONVERSATION_ENTRIES, MAX_ENTRY_CHARS } from './conversationBuilder';
const MAX_DETAIL_CHARS = 120;

/** Argument names tried, in order, for the one-line detail of a tool call. */
const DETAIL_KEYS = [
  'file_path',
  'path',
  'pattern',
  'command',
  'url',
  'skill',
  'description',
  'query',
];

function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  for (const key of DETAIL_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().split('\n')[0].slice(0, MAX_DETAIL_CHARS);
    }
  }
  return undefined;
}

/**
 * A conversation's prompts, tool calls and replies, oldest first, read from
 * the transcript. Only records inside `window` count; a record without a
 * timestamp counts as inside. `null` means there is no transcript.
 *
 * Streamed line by line: a transcript can be tens of megabytes, and a running
 * session is still appending to it, so an unparsable line (the last one,
 * mid-write) is skipped rather than failing the read. Past
 * `MAX_CONVERSATION_ENTRIES` the middle is dropped, keeping the opening
 * prompt and the newest entries. Thinking, subagent sidechains and injected
 * meta records are not part of what the person sees, nor is what a tool
 * returned: only when it came back, and whether as an error.
 */
export async function readConversation(
  sessionId: string,
  configDir: string | undefined,
  window: ConversationWindow = {},
): Promise<ConversationRecord | null> {
  const file = findSessionFile(sessionId, configDir);
  if (!file) return null;

  const since = window.since ? Date.parse(window.since) : NaN;
  const until = window.until ? Date.parse(window.until) : NaN;
  const conversation = new ConversationBuilder();
  // Each tool call waits here for its result, which says when it ended and whether it failed.
  const awaitingResult = new Map<string, Extract<ConversationEntry, { kind: 'step' }>>();

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      let record: {
        type?: string;
        isSidechain?: boolean;
        isMeta?: boolean;
        timestamp?: string;
        message?: { content?: unknown };
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || record.isSidechain === true || record.isMeta === true) continue;
      if (record.type !== 'user' && record.type !== 'assistant') continue;

      const at = typeof record.timestamp === 'string' ? record.timestamp : undefined;
      const time = at ? Date.parse(at) : NaN;
      if (!Number.isNaN(time)) {
        if (!Number.isNaN(since) && time < since) continue;
        if (!Number.isNaN(until) && time > until) continue;
      }
      const stamp = at ? { at } : {};

      const found: ConversationEntry[] = [];
      const content = record.message?.content;
      if (record.type === 'user') {
        if (Array.isArray(content)) settleSteps(content, awaitingResult, at);
        const text = typeof content === 'string' ? content : textBlocks(content).join('\n\n');
        if (text.trim() !== '') found.push({ kind: 'prompt', text: capText(text), ...stamp });
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{
          type?: string;
          id?: unknown;
          text?: unknown;
          name?: unknown;
          input?: unknown;
        }>) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            found.push({ kind: 'text', text: capText(block.text), ...stamp });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const detail = toolDetail(block.input);
            const step: Extract<ConversationEntry, { kind: 'step' }> = {
              kind: 'step',
              tool: block.name.replace(/^mcp__.+?__/, ''),
              ...(detail ? { detail } : {}),
              ...stamp,
            };
            if (typeof block.id === 'string') awaitingResult.set(block.id, step);
            found.push(step);
          }
        }
      }

      for (const entry of found) conversation.add(entry);
    }
  } catch {
    // Unreadable part-way: show what was read.
  } finally {
    lines.close();
    stream.destroy();
  }
  return conversation.build();
}

/**
 * Marks the tool calls a user record answers: when each ended, and whether
 * its result was an error. A result the transcript never wrote leaves its
 * step open — still running, or cut off.
 */
function settleSteps(
  content: unknown[],
  awaitingResult: Map<string, Extract<ConversationEntry, { kind: 'step' }>>,
  at: string | undefined,
): void {
  for (const block of content as Array<{
    type?: unknown;
    tool_use_id?: unknown;
    is_error?: unknown;
  }>) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const step = awaitingResult.get(block.tool_use_id);
    if (!step) continue;
    awaitingResult.delete(block.tool_use_id);
    if (at) step.endedAt = at;
    if (block.is_error === true) step.failed = true;
  }
}

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
import type { SessionNameResult } from '../shared/types';
import { capText, ConversationBuilder } from './conversationBuilder';
import { getLoginEnv } from './LoginEnvironment';

/**
 * Access to Claude Code's own session storage: read-only, except that a
 * harness switch copies a conversation into another config directory
 * (`copyConversation`), never overwriting anything there.
 *
 * Claude keeps each conversation as `<config>/projects/<project>/<id>.jsonl`
 * alongside a `sessions-index.json` cache holding a summary it generates
 * itself. Consola assigns each tab's session ID, so it can look its sessions up
 * here instead of tracking conversation state separately.
 *
 * The transcript is authoritative; the index is a cache that can lag behind or
 * be missing entirely, so every lookup falls back to the transcript.
 */

export interface ClaudeSessionEntry {
  sessionId: string;
  fullPath: string;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
}

interface SessionsIndexFile {
  version: number;
  entries: ClaudeSessionEntry[];
}

// Parsed indexes keyed by file path, invalidated on mtime change.
const indexCache = new Map<string, { mtimeMs: number; entries: ClaudeSessionEntry[] }>();

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

function listIndexFiles(configDir?: string): string[] {
  return listProjectDirs(configDir)
    .map((dir) => path.join(dir, 'sessions-index.json'))
    .filter((file) => fs.existsSync(file));
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

function readIndex(file: string): ClaudeSessionEntry[] {
  try {
    const { mtimeMs } = fs.statSync(file);
    const cached = indexCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.entries;
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionsIndexFile;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    indexCache.set(file, { mtimeMs, entries });
    return entries;
  } catch {
    // A partially written or malformed index is not worth failing over.
    return [];
  }
}

/**
 * Find a session's index entry by ID.
 *
 * Scans every project index rather than deriving the directory name from the
 * working directory: that encoding is lossy (a single project directory can
 * hold sessions whose `projectPath` is a subdirectory), whereas session IDs are
 * unique. The whole index set is a few tens of kilobytes.
 */
export function findEntry(sessionId: string, configDir?: string): ClaudeSessionEntry | null {
  for (const file of listIndexFiles(configDir)) {
    const match = readIndex(file).find((entry) => entry.sessionId === sessionId);
    if (match) return match;
  }
  return null;
}

/** Whether Claude still holds a conversation for this session. */
export function sessionExists(sessionId: string, configDir?: string): boolean {
  return findSessionFile(sessionId, configDir) !== null;
}

/**
 * The opening user message, read straight from the transcript.
 *
 * The transcript exists as soon as the conversation has a turn, well before the
 * index cache catches up, so this is what names a session in practice.
 */
function readFirstPrompt(sessionId: string, configDir?: string): string | null {
  const file = findSessionFile(sessionId, configDir);
  if (!file) return null;

  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;

      let record: { type?: string; message?: { content?: unknown } };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== 'user') continue;

      const content = record.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (block): block is { type: string; text: string } =>
                    typeof block === 'object' &&
                    block !== null &&
                    (block as { type?: string }).type === 'text',
                )
                .map((block) => block.text)
                .join(' ')
            : '';

      const trimmed = text.trim();
      if (!trimmed) continue;

      // A slash-command expansion carries the user's own words after an
      // ARGUMENTS: marker — prefer them over anything the skill injected.
      const argumentsIndex = trimmed.indexOf('ARGUMENTS:');
      if (argumentsIndex !== -1) {
        const args = trimmed.slice(argumentsIndex + 'ARGUMENTS:'.length).trim();
        if (args) return args;
      }

      // Skip command wrappers, tool results, and injected skill content
      // (markdown headings, skill preambles) to reach real prose.
      if (
        trimmed.startsWith('<') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('Base directory for this skill:')
      ) {
        continue;
      }

      return trimmed;
    }
  } catch {
    // Transcript unreadable or mid-write.
  }
  return null;
}

type TranscriptBlock = { type?: string; text?: string };

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as TranscriptBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b) => b.text as string);
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

/**
 * The best available display name for a session.
 *
 * Prefers the summary Claude writes itself, then the opening prompt from the
 * index, then the opening prompt read from the transcript — the last of which
 * is available immediately, while the index can lag by a long time.
 */
export function getDisplayName(
  sessionId: string,
  configDir?: string,
  maxLength = 60,
): SessionNameResult | null {
  const entry = findEntry(sessionId, configDir);
  const summary = entry?.summary?.trim();
  const raw = summary || (entry?.firstPrompt || readFirstPrompt(sessionId, configDir) || '').trim();
  if (!raw) return null;

  const collapsed = raw.replace(/\s+/g, ' ');
  const name =
    collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…` : collapsed;
  return { name, source: summary ? 'summary' : 'prompt' };
}

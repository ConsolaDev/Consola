import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { ConversationEntry, ConversationRecord, ConversationWindow } from '../shared/conversation';
import type { SessionNameResult } from '../shared/types';
import { getLoginEnv } from './LoginEnvironment';

/**
 * Read-only access to Claude Code's own session storage.
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
                                    (block as { type?: string }).type === 'text'
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
    count: number
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
                reply.length > MAX_REPLY_CHARS ? '…' + reply.slice(-(MAX_REPLY_CHARS - 1)) : reply
            );
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

export const MAX_CONVERSATION_ENTRIES = 2000;
export const MAX_ENTRY_CHARS = 20_000;
const MAX_DETAIL_CHARS = 120;

/** Argument names tried, in order, for the one-line detail of a tool call. */
const DETAIL_KEYS = ['file_path', 'path', 'pattern', 'command', 'url', 'skill', 'description', 'query'];

function capText(text: string): string {
    return text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS - 1) + '…' : text;
}

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
 * mid-write) is skipped rather than failing the read. Stops at
 * `MAX_CONVERSATION_ENTRIES`. Thinking, tool results, subagent sidechains and
 * injected meta records are not part of what the person sees.
 */
export async function readConversation(
    sessionId: string,
    configDir: string | undefined,
    window: ConversationWindow = {}
): Promise<ConversationRecord | null> {
    const file = findSessionFile(sessionId, configDir);
    if (!file) return null;

    const since = window.since ? Date.parse(window.since) : NaN;
    const until = window.until ? Date.parse(window.until) : NaN;
    const entries: ConversationEntry[] = [];
    let truncated = false;

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
                const text = typeof content === 'string' ? content : textBlocks(content).join('\n\n');
                if (text.trim() !== '') found.push({ kind: 'prompt', text: capText(text), ...stamp });
            } else if (Array.isArray(content)) {
                for (const block of content as Array<{
                    type?: string;
                    text?: unknown;
                    name?: unknown;
                    input?: unknown;
                }>) {
                    if (!block) continue;
                    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
                        found.push({ kind: 'text', text: capText(block.text), ...stamp });
                    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                        const detail = toolDetail(block.input);
                        found.push({
                            kind: 'step',
                            tool: block.name.replace(/^mcp__.+?__/, ''),
                            ...(detail ? { detail } : {}),
                            ...stamp,
                        });
                    }
                }
            }

            for (const entry of found) {
                if (entries.length >= MAX_CONVERSATION_ENTRIES) {
                    truncated = true;
                    break;
                }
                entries.push(entry);
            }
            if (truncated) break;
        }
    } catch {
        // Unreadable part-way: show what was read.
    } finally {
        lines.close();
        stream.destroy();
    }
    return { entries, truncated };
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
    maxLength = 60
): SessionNameResult | null {
    const entry = findEntry(sessionId, configDir);
    const summary = entry?.summary?.trim();
    const raw =
        summary ||
        (entry?.firstPrompt || readFirstPrompt(sessionId, configDir) || '').trim();
    if (!raw) return null;

    const collapsed = raw.replace(/\s+/g, ' ');
    const name =
        collapsed.length > maxLength
            ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
            : collapsed;
    return { name, source: summary ? 'summary' : 'prompt' };
}

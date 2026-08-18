import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
            // Skip command wrappers and tool results to reach real prose.
            if (trimmed && !trimmed.startsWith('<')) {
                return trimmed;
            }
        }
    } catch {
        // Transcript unreadable or mid-write.
    }
    return null;
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
): string | null {
    const entry = findEntry(sessionId, configDir);
    const raw = (
        entry?.summary ||
        entry?.firstPrompt ||
        readFirstPrompt(sessionId, configDir) ||
        ''
    ).trim();
    if (!raw) return null;

    const collapsed = raw.replace(/\s+/g, ' ');
    return collapsed.length > maxLength
        ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
        : collapsed;
}

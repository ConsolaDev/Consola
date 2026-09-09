import * as fs from 'fs/promises';
import * as path from 'path';

const cache = new Map<string, { size: number; mtimeMs: number; model: string | null }>();

/** Read backwards so long conversations cost only their most recent turn. */
export async function readSessionModel(file: string, driver: 'claude' | 'codex'): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
        handle = await fs.open(file, 'r');
        const { size, mtimeMs } = await handle.stat();
        const previous = cache.get(file);
        if (previous?.size === size && previous.mtimeMs === mtimeMs) return previous.model;
        let position = size;
        let remainder = Buffer.alloc(0);
        let model: string | null = null;
        while (position > 0 && !model) {
            const length = Math.min(position, 64 * 1024);
            position -= length;
            const chunk = Buffer.alloc(length);
            const { bytesRead } = await handle.read(chunk, 0, length, position);
            const data = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
            const start = position === 0 ? 0 : data.indexOf(10) + 1;
            // Keep an incomplete first line for the next chunk. Buffers preserve
            // UTF-8 characters split at a chunk boundary.
            remainder = start === 0 && position > 0 ? data : data.subarray(0, start);
            if (start === 0 && position > 0) continue;
            const lines = data.subarray(start).toString('utf8').split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const record = JSON.parse(lines[i]);
                    const candidate = driver === 'claude'
                        ? record?.type === 'assistant' && record.message?.model
                        : record?.type === 'turn_context' && record.payload?.model;
                    if (typeof candidate === 'string' && candidate.trim() && !candidate.startsWith('<')) {
                        model = candidate.trim();
                        break;
                    }
                } catch { /* A transcript can end with a partially written record. */ }
            }
        }
        // Bound the process-wide cache as sessions come and go.
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(file, { size, mtimeMs, model });
        return model;
    } catch { return null; }
    finally { await handle?.close(); }
}

/** Codex stores rollouts under sessions/YYYY/MM/DD, named by native thread ID. */
export async function findCodexRollout(directory: string, threadId: string): Promise<string | null> {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries.reverse()) {
            const target = path.join(directory, entry.name);
            if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) return target;
            if (entry.isDirectory()) {
                const found = await findCodexRollout(target, threadId);
                if (found) return found;
            }
        }
    } catch { /* The profile may not have any sessions yet. */ }
    return null;
}

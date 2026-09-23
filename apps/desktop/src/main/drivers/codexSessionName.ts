import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { SessionNameResult } from '../../shared/types';

/** Stream rollouts so naming does not load a whole conversation into memory. */
async function* records(file: string): AsyncGenerator<any> {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            try { yield JSON.parse(line); }
            catch { /* Ignore incomplete or malformed records while Codex writes. */ }
        }
    } catch { /* A new session may not have been flushed yet. */ }
    finally { lines.close(); input.destroy(); }
}

function displayName(text: string, source: SessionNameResult['source']): SessionNameResult {
    const name = text.trim().replace(/\s+/g, ' ');
    return { name: name.length > 60 ? `${name.slice(0, 59).trimEnd()}…` : name, source };
}

export async function readCodexSessionName(
    index: string, threadId: string, sessionId: string, rollout: string | undefined
): Promise<SessionNameResult | null> {
    let title: string | undefined;
    for await (const record of records(index)) {
        if (record?.id === threadId && typeof record.thread_name === 'string') {
            title = record.thread_name.trim();
        }
    }
    // Thread preparation assigns an internal name just to materialize the rollout.
    if (title && title !== `Consola ${sessionId}` && title !== 'New Session') {
        return displayName(title, 'summary');
    }
    if (!rollout) return null;
    for await (const record of records(rollout)) {
        const payload = record?.payload;
        let texts: string[] = [];
        if (record?.type === 'event_msg' && payload?.type === 'user_message') {
            if (typeof payload.message === 'string') texts = [payload.message];
        } else if (record?.type === 'response_item' && payload?.type === 'message'
            && payload.role === 'user' && Array.isArray(payload.content)) {
            texts = payload.content.filter((block: any) => block?.type === 'input_text'
                && typeof block.text === 'string').map((block: any) => block.text);
        }
        const prompt = texts.map(text => text.trim()).filter(text => text
            && !text.startsWith('<') && !text.startsWith('# AGENTS.md')
            && !text.startsWith('Base directory for this skill:')).join(' ');
        if (prompt) return displayName(prompt, 'prompt');
    }
    return null;
}

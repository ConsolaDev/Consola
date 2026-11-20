import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Stream rollouts so reading does not load a whole conversation into memory. */
async function* records(file: string): AsyncGenerator<any> {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        yield JSON.parse(line);
      } catch {
        /* Ignore incomplete or malformed records while Codex writes. */
      }
    }
  } catch {
    /* A new session may not have been flushed yet. */
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * The first real user message in a Codex rollout, outer whitespace trimmed.
 * Skips AGENTS.md and injected context. Null when there is none yet.
 */
export async function readCodexFirstPrompt(rollout: string): Promise<string | null> {
  for await (const record of records(rollout)) {
    const payload = record?.payload;
    let texts: string[] = [];
    if (record?.type === 'event_msg' && payload?.type === 'user_message') {
      if (typeof payload.message === 'string') texts = [payload.message];
    } else if (
      record?.type === 'response_item' &&
      payload?.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content)
    ) {
      texts = payload.content
        .filter((block: any) => block?.type === 'input_text' && typeof block.text === 'string')
        .map((block: any) => block.text);
    }
    const prompt = texts
      .map((text) => text.trim())
      .filter(
        (text) =>
          text &&
          !text.startsWith('<') &&
          !text.startsWith('# AGENTS.md') &&
          !text.startsWith('Base directory for this skill:'),
      )
      .join('\n');
    if (prompt) return prompt;
  }
  return null;
}

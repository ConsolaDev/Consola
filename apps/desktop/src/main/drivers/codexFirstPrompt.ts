import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Stream rollouts so reading does not load a whole conversation into memory. */
async function* records(file: string): AsyncGenerator<unknown> {
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

/** A parsed JSON value's fields, when it is an object. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The first real user message in a Codex rollout, outer whitespace trimmed.
 * Skips AGENTS.md and injected context. Null when there is none yet.
 */
export async function readCodexFirstPrompt(rollout: string): Promise<string | null> {
  for await (const line of records(rollout)) {
    const record = fieldsOf(line);
    const payload = fieldsOf(record?.payload);
    let texts: string[] = [];
    if (record?.type === 'event_msg' && payload?.type === 'user_message') {
      if (typeof payload.message === 'string') texts = [payload.message];
    } else if (
      record?.type === 'response_item' &&
      payload?.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content)
    ) {
      texts = payload.content.flatMap((item: unknown) => {
        const block = fieldsOf(item);
        return block?.type === 'input_text' && typeof block.text === 'string' ? [block.text] : [];
      });
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

import type { ReadResult } from '@consola/cloud-contract';

// What every signed delivery from `cloud-global` shares once its signature checks: a payload of
// JSON, and a store that may fail to answer.

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A checked payload's value: UTF-8 text, then JSON, or why it is neither. */
export function readJsonPayload(payload: Uint8Array): ReadResult<unknown> {
  let text: string;
  try {
    text = UTF8.decode(payload);
  } catch {
    return { ok: false, reason: 'the payload is not UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'the payload is not JSON' };
  }
}

/** The innermost cause's first line: what failed, without the query that failed. */
export function whatFailed(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    current instanceof Error && current.cause !== undefined && depth < 5;
    depth++
  ) {
    current = current.cause;
  }
  const line = current instanceof Error ? current.message.split('\n')[0]?.trim() : undefined;
  return line || 'an unexpected error';
}

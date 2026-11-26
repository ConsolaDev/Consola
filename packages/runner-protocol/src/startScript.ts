import { fieldProblem, isId, isRecord, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/**
 * A line the sandbox's start script prints to the runner, before the host takes over. It is not
 * one of the host's own lines (`ready`, `dev-pass`, `title`, `status`, and an `exit` for
 * `idle`): the script ends before the host runs, when the clone fails.
 */
export type StartScriptLine = { type: 'exit'; reason: 'clone-failed'; message: string };

const FIELDS = ['type', 'reason', 'message'] as const;

export function readStartScriptLine(json: unknown): ReadResult<StartScriptLine> {
  if (!isRecord(json)) return refused('the line is not an object');
  const fields = fieldProblem(json, FIELDS, 'the line');
  if (fields !== null) return refused(fields);
  const { type, reason, message } = json;
  if (type !== 'exit') return refused('`type` is not a start script line');
  if (reason !== 'clone-failed') return refused('`reason` is not a start script reason');
  if (!isId(message)) return refused('`message` is not text');
  return read({ type, reason, message });
}

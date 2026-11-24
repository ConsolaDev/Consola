/**
 * What an agent is told about a page's problems, read from the page's own
 * DevTools events. Pure: `PageDriver` feeds it what the debugger emits and
 * keeps the answers in its rings.
 *
 * Three events say everything needed, and all three are replayed when a
 * client enables their domain, which is what lets the agent see what went
 * wrong before it connected (a page's first load usually happens first):
 *
 * - `Runtime.consoleAPICalled`: the page's own `console.error` and failed
 *   `console.assert`.
 * - `Runtime.exceptionThrown`: an uncaught error or unhandled rejection.
 * - `Log.entryAdded`: what Chromium itself reports. Its `network` errors are
 *   the failed requests ("Failed to load resource: ..." with the address,
 *   for a refused connection and an HTTP error status alike; a cancelled
 *   request logs nothing). Its other errors (a refused script, a blocked
 *   frame) are console errors, as DevTools shows them.
 */

import { cutCopy } from './ownCopy';

/** What one entry may hold, in characters: a page decides how much it logs. */
export const MAX_ENTRY_CHARS = 2000;

export interface ConsoleError {
  text: string;
  /** Where it came from, `<address>:<line>`, when the page said. */
  source?: string;
  /** Epoch milliseconds, the page's own clock reading of when it happened. */
  at: number;
}

export interface FailedRequest {
  url: string;
  /** Chromium's own words: the network error, or the HTTP status. */
  reason: string;
  /** Epoch milliseconds. */
  at: number;
}

export type PageEvent =
  | { kind: 'console-error'; entry: ConsoleError }
  | { kind: 'failed-request'; entry: FailedRequest };

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

/**
 * At most `MAX_ENTRY_CHARS` of the text. What is cut is copied (`cutCopy`):
 * an entry is kept until the agent's next snapshot, and a cut that pointed
 * into the page's whole message would keep all of it that long.
 */
function clip(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${cutCopy(text, MAX_ENTRY_CHARS - 1)}…` : text;
}

/** A CDP `RemoteObject` as console text, the way DevTools prints a value it did not expand. */
function remoteText(remote: unknown): string {
  if (!isFields(remote)) return '';
  if ('value' in remote) {
    const { value } = remote;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  if (typeof remote.unserializableValue === 'string') return remote.unserializableValue;
  if (typeof remote.description === 'string') return remote.description;
  return typeof remote.type === 'string' ? remote.type : '';
}

/** `<address>:<line>`, with CDP's zero-based line made one-based as people count lines. */
function sourceOf(url: unknown, line: unknown): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined;
  return clip(typeof line === 'number' ? `${url}:${line + 1}` : url);
}

function timeOf(value: unknown, now: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : now;
}

function consoleError(text: string, source: string | undefined, at: number): PageEvent {
  return {
    kind: 'console-error',
    entry: source ? { text: clip(text), source, at } : { text: clip(text), at },
  };
}

/**
 * The console error or failed request one debugger event is, or null for
 * anything else. `now` dates an entry the page sent undated.
 */
export function readPageEvent(method: string, params: unknown, now: number): PageEvent | null {
  if (!isFields(params)) return null;

  if (method === 'Runtime.consoleAPICalled') {
    if (params.type !== 'error' && params.type !== 'assert') return null;
    const args = Array.isArray(params.args) ? params.args : [];
    // Each argument is cut before they are joined, so a call with many long
    // ones never builds their whole text only to cut it.
    const text = args.map((arg) => clip(remoteText(arg))).join(' ');
    const frames = isFields(params.stackTrace) ? params.stackTrace.callFrames : undefined;
    const top = Array.isArray(frames) && isFields(frames[0]) ? frames[0] : undefined;
    return consoleError(
      params.type === 'assert' ? `Assertion failed: ${text}` : text,
      sourceOf(top?.url, top?.lineNumber),
      timeOf(params.timestamp, now),
    );
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails;
    if (!isFields(details)) return null;
    const what = details.exception === undefined ? '' : remoteText(details.exception);
    const text = [details.text, what]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .map(clip)
      .join(' ');
    return consoleError(
      text,
      sourceOf(details.url, details.lineNumber),
      timeOf(params.timestamp, now),
    );
  }

  if (method === 'Log.entryAdded') {
    const entry = params.entry;
    if (!isFields(entry) || entry.level !== 'error') return null;
    const text = typeof entry.text === 'string' ? entry.text : '';
    const at = timeOf(entry.timestamp, now);
    if (entry.source === 'network') {
      const url = typeof entry.url === 'string' ? entry.url : '';
      return { kind: 'failed-request', entry: { url: clip(url), reason: clip(text), at } };
    }
    return consoleError(text, sourceOf(entry.url, entry.lineNumber), at);
  }

  return null;
}

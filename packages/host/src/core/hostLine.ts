/**
 * What the session is doing, as whoever started the host shows it: `waiting` while a runtime
 * request (an approval or a question) waits on the person, `working` while a run is active, and
 * `idle` otherwise.
 */
export type SessionStatus = 'working' | 'waiting' | 'idle';

/**
 * One line of the host's stdout, which carries these and nothing else: it is how Track B's
 * runner (or a person running the host) learns what the host is doing. t3's logs go to stderr.
 *
 * - `ready`: the host serves the session at `port` (the one it got, for `--port 0`). It is idle,
 *   and the thread has its first title.
 * - `dev-pass`: with `--dev` only, right after `ready`: a pass for the session.
 * - `title`, `status`: the thread's title or the session's status changed.
 * - `exit`: the host is stopping by itself (`idle`); the process exits 0 once it has stopped.
 */
export type HostLine =
  | { readonly type: 'ready'; readonly port: number }
  | { readonly type: 'dev-pass'; readonly pass: string; readonly expiresInSeconds: number }
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'status'; readonly status: SessionStatus }
  | { readonly type: 'exit'; readonly reason: 'idle' };

/** Every `type` a `HostLine` has: the runner may refuse any other. */
export const HOST_LINE_TYPES: ReadonlyArray<HostLine['type']> = [
  'ready',
  'dev-pass',
  'title',
  'status',
  'exit',
];

const SESSION_STATUSES: ReadonlyArray<SessionStatus> = ['working', 'waiting', 'idle'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `value` has exactly the fields named, no more. */
const hasExactly = (value: Record<string, unknown>, fields: ReadonlyArray<string>): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
};

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * Reads one line the host printed, parsed from JSON, as strictly as it is written: a type it
 * does not know, a field it does not name or a value out of its range is `null`. The runner reads
 * a sandbox's stdout with it, where anything else may be printed too.
 */
export function readHostLine(json: unknown): HostLine | null {
  if (!isRecord(json)) return null;
  switch (json.type) {
    case 'ready':
      return hasExactly(json, ['type', 'port']) && isPort(json.port)
        ? { type: 'ready', port: json.port }
        : null;
    case 'dev-pass':
      return hasExactly(json, ['type', 'pass', 'expiresInSeconds']) &&
        typeof json.pass === 'string' &&
        typeof json.expiresInSeconds === 'number'
        ? { type: 'dev-pass', pass: json.pass, expiresInSeconds: json.expiresInSeconds }
        : null;
    case 'title':
      return hasExactly(json, ['type', 'title']) && typeof json.title === 'string'
        ? { type: 'title', title: json.title }
        : null;
    case 'status': {
      const status = SESSION_STATUSES.find((each) => each === json.status);
      return hasExactly(json, ['type', 'status']) && status !== undefined
        ? { type: 'status', status }
        : null;
    }
    case 'exit':
      return hasExactly(json, ['type', 'reason']) && json.reason === 'idle'
        ? { type: 'exit', reason: 'idle' }
        : null;
    default:
      return null;
  }
}

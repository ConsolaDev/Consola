import { parseDurationMs } from './duration';
import { parseFieldPath } from './fieldPath';
import { parseSecretNames, secretTemplateReason } from './secrets';

export const MIN_POLL_EVERY_MS = 60_000;
export const MAX_POLL_EVERY_MS = 86_400_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
export const MAX_CHECK_TIMEOUT_MS = 300_000;

/** Names no connection can take: the first key of `on:` means these. */
export const RESERVED_TRIGGER_NAMES = ['cron', 'poll', 'manual', 'webhook', 'consola'] as const;

/**
 * `on: { poll: { run, every, key | item, changed?, timeout?, secrets? } }`: a command
 * whose stdout is a JSON array of objects, one per item. The grammar knows a
 * command and field paths, nothing about any vendor.
 */
export interface PollTrigger {
  kind: 'poll';
  run: string;
  everyMs: number;
  timeoutMs: number;
  /** A field path to the item's identity, as written. */
  key?: string;
  /** `{ github: .url }`: that field holds the URL of a work item of that connection. */
  item?: { connection: string; path: string };
  /** A field path to the item's revision, as written. */
  changed?: string;
  /** The secrets its check command needs, by name; present only when written and non-empty. */
  secrets?: string[];
}

/** `on: manual`: it runs only when a person starts it. */
export interface ManualTrigger {
  kind: 'manual';
}

type Fail = (message: string, path?: Array<string | number>) => void;

const POLL_KEYS = ['run', 'every', 'key', 'item', 'changed', 'timeout', 'secrets'] as const;
/** A poll's keys that arrive with polls by MCP tool (5a-3), each refused with that reason. */
const TOOL_POLL_KEYS = new Set(['uses', 'with', 'items']);
const TIMEOUT_FORMAT = 'Write the timeout as `<n>s`, `<n>m` or `<n>h`, e.g. `10m`.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const quoted = (keys: string[]) => keys.map((key) => `\`${key}\``).join(', ');

/** `value` is what stands after `poll:`; `rest` the keys of `on` after it. Returns null once anything was reported. */
export function parsePollTrigger(
  value: unknown,
  rest: string[],
  fail: Fail,
  notAConnection: (id: string) => string,
  connectionIdPattern: RegExp,
): PollTrigger | null {
  let ok = true;
  const bad: Fail = (message, path = []) => {
    ok = false;
    fail(message, ['poll', ...path]);
  };
  if (rest.length > 0) {
    ok = false;
    fail(`A poll trigger takes no parameters; remove ${quoted(rest)}.`, [rest[0]]);
  }
  if (!isRecord(value)) {
    bad(
      'Expected `poll:` to be a mapping with `run` and `every`, e.g. `poll: { every: 30m, run: …, key: .id }`.',
    );
    return null;
  }
  const unlisted = Object.keys(value).filter(
    (key) => !(POLL_KEYS as readonly string[]).includes(key),
  );
  for (const key of unlisted.filter((key) => TOOL_POLL_KEYS.has(key))) {
    bad(`\`${key}\` in a poll arrives with polls by MCP tool; it is not supported yet.`, [key]);
  }
  const unknown = unlisted.filter((key) => !TOOL_POLL_KEYS.has(key));
  if (unknown.length > 0) {
    bad(
      `Unrecognized key in \`poll\`: ${unknown.join(', ')}. Expected run, every, key, item, changed, timeout or secrets.`,
      [unknown[0]],
    );
  }

  let everyMs = 0;
  if (value.every === undefined) {
    bad('Say how often to check, e.g. `every: 30m`.', ['every']);
  } else {
    const text = typeof value.every === 'string' ? value.every.trim() : '';
    const ms = /^\d+[mh]$/.test(text) ? parseDurationMs(text) : null;
    if (ms === null || ms < MIN_POLL_EVERY_MS || ms > MAX_POLL_EVERY_MS) {
      bad('`every` is `<n>m` or `<n>h`, from 1m to 24h.', ['every']);
    } else everyMs = ms;
  }

  const run = typeof value.run === 'string' ? value.run : '';
  if (!run.trim()) {
    bad(
      'Say what to run, e.g. `run: gh api graphql …`: its stdout is a JSON array of objects, one per item.',
      ['run'],
    );
  } else if (run.includes('{{')) {
    // `{{ secrets.X }}` says how a secret reaches a command, as a step's `run:` does.
    const [root, name] = (/\{\{[^}]*\}\}/.exec(run)?.[0] ?? '{{').slice(2, -2).trim().split('.');
    bad(
      root === 'secrets'
        ? secretTemplateReason(name)
        : 'A check command takes no `{{ }}`: it runs before there is an item, and values reach commands only as environment variables.',
      ['run'],
    );
  }

  let timeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  if (value.timeout !== undefined) {
    const ms = parseDurationMs(value.timeout);
    if (ms === null) bad(TIMEOUT_FORMAT, ['timeout']);
    else if (ms < 1000) bad('A timeout is at least 1s.', ['timeout']);
    else if (ms > MAX_CHECK_TIMEOUT_MS) bad('A check times out after at most 5m.', ['timeout']);
    else timeoutMs = ms;
  }

  const has = (key: string) => value[key] !== undefined;
  let key: string | undefined;
  let item: PollTrigger['item'];
  if (has('key') && has('item')) {
    bad('A poll item has one identity: `key:` or `item:`, not both.');
  } else if (!has('key') && !has('item')) {
    bad('Say what identifies an item: `key: .id`, or `item: { github: .url }`.');
  } else if (has('key')) {
    const parsed = parseFieldPath(value.key);
    if (parsed.ok) key = parsed.path.text;
    else bad(parsed.problem, ['key']);
  } else {
    const written = value.item;
    const names = isRecord(written) ? Object.keys(written) : [];
    if (names.length !== 1) {
      bad('`item:` names one connection, e.g. `{ github: .url }`.', ['item']);
    } else if (!connectionIdPattern.test(names[0])) {
      bad(notAConnection(names[0]), ['item', names[0]]);
    } else if ((RESERVED_TRIGGER_NAMES as readonly string[]).includes(names[0])) {
      bad(`\`${names[0]}\` is not a connection.`, ['item', names[0]]);
    } else {
      const parsed = parseFieldPath((written as Record<string, unknown>)[names[0]]);
      if (parsed.ok) item = { connection: names[0], path: parsed.path.text };
      else bad(parsed.problem, ['item', names[0]]);
    }
  }

  let changed: string | undefined;
  if (has('changed')) {
    const parsed = parseFieldPath(value.changed);
    if (parsed.ok) changed = parsed.path.text;
    else bad(parsed.problem, ['changed']);
  }

  // A check has no `env:`, so nothing for a name to repeat.
  const secrets = has('secrets')
    ? parseSecretNames(value.secrets, (message, path = []) => bad(message, ['secrets', ...path]))
    : null;

  if (!ok) return null;
  return {
    kind: 'poll',
    run,
    everyMs,
    timeoutMs,
    ...(key ? { key } : {}),
    ...(item ? { item } : {}),
    ...(changed ? { changed } : {}),
    // Only when it names any, so a poll without one parses, and hashes, as before the key existed.
    ...(secrets && secrets.length > 0 ? { secrets } : {}),
  };
}

/** `on: manual`, or `on: { manual: {} }` / `{ manual: null }`. */
export function parseManualTrigger(
  value: unknown,
  rest: string[],
  fail: Fail,
): ManualTrigger | null {
  if (rest.length > 0) {
    fail(`A manual trigger takes no parameters; remove ${quoted(rest)}.`, [rest[0]]);
    return null;
  }
  if (
    value !== undefined &&
    value !== null &&
    !(isRecord(value) && Object.keys(value).length === 0)
  ) {
    fail('`manual` takes nothing: write `on: manual`.', ['manual']);
    return null;
  }
  return { kind: 'manual' };
}

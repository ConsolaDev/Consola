/**
 * What reading a value the other side sent gives: the value as the contract types it, or why it
 * was refused. A reason names the field, never what the field held, so it can be logged.
 */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export const read = <T>(value: T): ReadResult<T> => ({ ok: true, value });

export const refused = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An id one side gave a thing: a string with something in it. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A whole number that survives JSON both ways. */
export function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** One of `list`'s words. */
export const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** Text of 1 to `max` UTF-16 code units (`String.length`). */
export const isTextUpTo = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** A whole number from 1. */
export const isPositiveWhole = (value: unknown): value is number =>
  isWholeNumber(value) && value >= 1;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO 8601 time with its offset, to the millisecond at most: its form only, since the package
 * may not reach the clock (`Date`). A reader that needs the moment parses it itself.
 */
export const isIsoTime = (value: unknown): value is string =>
  typeof value === 'string' && ISO_TIME.test(value);

/**
 * The first problem with a record's fields: one of `fields` it lacks, or one it has that the
 * contract names neither in `fields` nor in `optional`. An unnamed field is refused rather than
 * ignored, so nothing the contract does not name (an email, say) can ride along to a cell.
 */
export function fieldProblem(
  record: Record<string, unknown>,
  fields: readonly string[],
  what: string,
  optional: readonly string[] = [],
): string | null {
  const missing = fields.find((field) => !Object.hasOwn(record, field));
  if (missing !== undefined) return `${what} has no \`${missing}\``;
  const extra = Object.keys(record).find(
    (field) => !fields.includes(field) && !optional.includes(field),
  );
  if (extra !== undefined) return `${what} has \`${extra}\`, which the contract does not name`;
  return null;
}

/** Reads each item of an array field, naming the field (never the item) on a refusal. */
export function readList<T>(
  value: unknown,
  field: string,
  isItem: (item: unknown) => item is T,
): ReadResult<T[]> {
  if (!Array.isArray(value)) return refused(`\`${field}\` is not a list`);
  if (!value.every(isItem)) return refused(`\`${field}\` holds an item that is not valid`);
  return read([...value]);
}

/**
 * A reader of one value at a place in a message (`at`, such as `run.steps[2]`), which a reason
 * names. The combinators below build a strict structural reader from them: every field present
 * and of its type, no field the protocol does not name, every list bounded.
 */
export type Reader<T> = (value: unknown, at: string) => ReadResult<T>;

/** A reader from a predicate; `what` says in a reason what the value is not (`a step status`). */
export const readerOf =
  <T>(is: (value: unknown) => value is T, what: string): Reader<T> =>
  (value, at) =>
    is(value) ? read(value) : refused(`\`${at}\` is not ${what}`);

/** Any string, the empty one included. */
export const text: Reader<string> = (value, at) =>
  typeof value === 'string' ? read(value) : refused(`\`${at}\` is not text`);

/** A number JSON can carry: finite. */
export const number: Reader<number> = (value, at) =>
  typeof value === 'number' && Number.isFinite(value)
    ? read(value)
    : refused(`\`${at}\` is not a number`);

export const boolean: Reader<boolean> = (value, at) =>
  typeof value === 'boolean' ? read(value) : refused(`\`${at}\` is not true or false`);

/** One of `list`'s words; `what` names the vocabulary in a reason (`a step status`). */
export const oneOf = <T extends string>(list: readonly T[], what: string): Reader<T> =>
  readerOf((value: unknown): value is T => isOneOf(list, value), what);

/** `null`, or what `reader` reads. */
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (value, at) =>
    value === null ? read(null) : reader(value, at);

/** A list of at most `max` items, each read by `reader`. */
export const listOf =
  <T>(reader: Reader<T>, max: number): Reader<T[]> =>
  (value, at) => {
    if (!Array.isArray(value)) return refused(`\`${at}\` is not a list`);
    if (value.length > max) return refused(`\`${at}\` holds more than ${max} items`);
    const items: T[] = [];
    for (const [index, item] of value.entries()) {
      const one = reader(item, `${at}[${index}]`);
      if (!one.ok) return one;
      items.push(one.value);
    }
    return read(items);
  };

/**
 * An object of at most `max` entries, each value read by `reader`. A key is any string the sender
 * chose, so a reason never names one. Built with `Object.fromEntries`, so a key such as
 * `__proto__` is kept as an entry, never taken for the object's prototype.
 */
export const mapOf =
  <T>(reader: Reader<T>, max: number): Reader<Record<string, T>> =>
  (value, at) => {
    if (!isRecord(value)) return refused(`\`${at}\` is not an object`);
    const entries = Object.entries(value);
    if (entries.length > max) return refused(`\`${at}\` holds more than ${max} entries`);
    const kept: [string, T][] = [];
    for (const [key, entry] of entries) {
      const one = reader(entry, `${at}.<entry>`);
      if (!one.ok) return one;
      kept.push([key, one.value]);
    }
    return read(Object.fromEntries(kept));
  };

/**
 * An object with exactly `fields`, each read by its reader: one missing, or one the protocol does
 * not name, is refused. The value is built anew from what each reader read.
 */
export const objectOf =
  <T extends object>(fields: { readonly [K in keyof T]-?: Reader<T[K]> }): Reader<T> =>
  (value, at) => {
    if (!isRecord(value)) return refused(`\`${at}\` is not an object`);
    const readers = fields as unknown as Record<string, Reader<unknown>>;
    const names = Object.keys(readers);
    const problem = fieldProblem(value, names, `\`${at}\``);
    if (problem !== null) return refused(problem);
    const built: Record<string, unknown> = {};
    for (const name of names) {
      const one = (readers[name] as Reader<unknown>)(value[name], `${at}.${name}`);
      if (!one.ok) return one;
      built[name] = one.value;
    }
    return read(built as T);
  };

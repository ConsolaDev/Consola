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

/**
 * The first problem with a record's fields: one of `fields` it lacks, or one it has that the
 * contract does not name. An unnamed field is refused rather than ignored, so nothing the
 * contract does not name (an email, say) can ride along to a cell.
 */
export function fieldProblem(
  record: Record<string, unknown>,
  fields: readonly string[],
  what: string,
): string | null {
  const missing = fields.find((field) => !Object.hasOwn(record, field));
  if (missing !== undefined) return `${what} has no \`${missing}\``;
  const extra = Object.keys(record).find((field) => !fields.includes(field));
  if (extra !== undefined) return `${what} has \`${extra}\`, which the contract does not name`;
  return null;
}

/** Postgres's code for a unique constraint a write would break. */
export const UNIQUE_VIOLATION = '23505';

/** Postgres's code for a foreign key a write would break: a row it points at, or one at it. */
export const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Whether a failed statement failed with the SQLSTATE `code`. Drizzle wraps the driver's error,
 * so its causes are read too; both PGlite's and pg's errors carry the SQLSTATE as `code`.
 */
export function failedWith(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = current.cause;
  }
  return false;
}

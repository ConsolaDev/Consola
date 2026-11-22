import { isSandboxError, type SandboxError, type SandboxErrorCode } from '../domain/errors';

/**
 * The contract's own assertions. It runs inside any test framework, and in none, so it uses
 * none: a broken promise throws a `ContractFailure` that says what the provider did.
 */
export class ContractFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractFailure';
  }
}

/** `value` as text two equal values share: bytes as their values, object keys sorted. */
const shown = (value: unknown): string =>
  value instanceof Uint8Array
    ? `bytes [${[...value].join(', ')}]`
    : JSON.stringify(value, (_key, inner: unknown) =>
        inner !== null && typeof inner === 'object' && !Array.isArray(inner)
          ? Object.fromEntries(
              Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : inner,
      );

export function holds(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractFailure(message);
}

/** `actual` is `expected`, compared as JSON (bytes as their values). */
export function same(actual: unknown, expected: unknown, what: string): void {
  if (shown(actual) !== shown(expected)) {
    throw new ContractFailure(`${what}: expected ${shown(expected)}, got ${shown(actual)}.`);
  }
}

/** `attempt` rejects with a `SandboxError` of `code`, which it returns. */
export async function rejectsWith(
  attempt: () => Promise<unknown>,
  code: SandboxErrorCode,
  what: string,
): Promise<SandboxError> {
  try {
    await attempt();
  } catch (error) {
    if (isSandboxError(error, code)) return error;
    throw new ContractFailure(
      `${what}: expected a SandboxError coded ${code}, got ${describeError(error)}.`,
    );
  }
  throw new ContractFailure(`${what}: expected a SandboxError coded ${code}, but it succeeded.`);
}

function describeError(error: unknown): string {
  if (isSandboxError(error)) return `a SandboxError coded ${error.code} (${error.message})`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

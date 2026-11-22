/**
 * What went wrong, in terms code can act on. Every failure that leaves this package is a
 * `SandboxError` with one of these codes: a provider maps its own failures onto them, and
 * `sandboxesFrom` wraps anything else as `provider`.
 */
export type SandboxErrorCode =
  /** The request was malformed, and was refused before any provider saw it. */
  | 'invalid'
  /** The template, file or sandbox it names does not exist. */
  | 'not-found'
  /** The sandbox has stopped, or is paused, so it takes no work. */
  | 'not-running'
  /** The provider lacks the capability the code asked for. */
  | 'unsupported'
  /** Anything else the provider reported. The message is the provider's own. */
  | 'provider';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** Whether `error` is a `SandboxError`, and, when `code` is given, one with that code. */
export function isSandboxError(error: unknown, code?: SandboxErrorCode): error is SandboxError {
  return error instanceof SandboxError && (code === undefined || error.code === code);
}

/**
 * `error` as a `SandboxError`: itself when it is one, else a `provider` error carrying its
 * message and, as its cause, the original.
 */
export function asSandboxError(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SandboxError(
    'provider',
    message.trim() === '' ? 'The sandbox provider failed without saying why.' : message,
    { cause: error },
  );
}

import {
  CommandExitError,
  SandboxError as E2BError,
  FileNotFoundError,
  SandboxNotFoundError,
  SandboxNotRunningError,
} from 'e2b';
import { SandboxError } from '../../domain/errors';

/**
 * What E2B's failures mean in the interface's codes. A missing file or template is
 * `not-found`; a sandbox that is gone is `not-running` to a handle on it and `not-found` to
 * code reaching for it by its id (`gone`); anything else is a `provider` error in E2B's own
 * words. No message carries the key.
 */
export function translate(
  error: unknown,
  apiKey: string,
  gone: 'not-running' | 'not-found' = 'not-running',
): SandboxError {
  if (error instanceof SandboxError) return error;
  const message = redact(error instanceof Error ? error.message : String(error), apiKey);
  const options = carriesKey(error, apiKey) ? undefined : { cause: error };
  if (error instanceof FileNotFoundError) return new SandboxError('not-found', message, options);
  if (error instanceof SandboxNotRunningError || error instanceof SandboxNotFoundError) {
    return new SandboxError(gone, message, options);
  }
  if (hasStatus(error, 404)) return new SandboxError('not-found', message, options);
  return new SandboxError(
    'provider',
    message.trim() === '' ? 'E2B failed without saying why.' : message,
    options,
  );
}

/** Whether E2B's API answered `error` with HTTP `status`. */
export function hasStatus(error: unknown, status: number): boolean {
  return error instanceof E2BError && error.statusCode === status;
}

/**
 * The exit code E2B reports for a command that ended badly, or null when a signal ended it
 * (E2B reports -1 then), or undefined when `error` is no exit at all.
 */
export function exitCodeOf(error: unknown): number | null | undefined {
  if (!(error instanceof CommandExitError)) return undefined;
  return Number.isInteger(error.exitCode) && error.exitCode >= 0 ? error.exitCode : null;
}

const KEY_STAND_IN = '[the E2B API key]';

function redact(message: string, apiKey: string): string {
  return apiKey === '' ? message : message.split(apiKey).join(KEY_STAND_IN);
}

function carriesKey(error: unknown, apiKey: string): boolean {
  if (apiKey === '') return false;
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return text.includes(apiKey);
}

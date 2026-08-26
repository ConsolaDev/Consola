/**
 * The one place `InboxService`, `launchWorkItem` and `cloneRepo` turn a
 * caught value into a label.
 *
 * Deliberately shallow: every subprocess error a service sees has already
 * been normalised and scrubbed inside its driver (argv stripped, stderr
 * folded into `.message`) before it gets here. Reading `.stderr` or
 * embedding argv in this function would re-open the credential-leak that
 * scrubbing closed, for a driver that no longer needs it.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

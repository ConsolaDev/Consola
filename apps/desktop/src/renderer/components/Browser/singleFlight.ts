/**
 * Runs `task` unless an earlier call is still pending, so a button that starts
 * slow work cannot start it twice. Answers false when it did not run.
 */
export function singleFlight(): (task: () => Promise<void>) => Promise<boolean> {
  let pending = false;
  return async (task) => {
    if (pending) return false;
    pending = true;
    try {
      await task();
    } finally {
      pending = false;
    }
    return true;
  };
}

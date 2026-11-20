/**
 * Runs `step`, and logs rather than throws whatever it throws: one listener
 * that fails must not keep the others from hearing, nor stop the work it was
 * told in the middle of (a page let go of half way, a workspace delete cut
 * short after its record is gone). `what` names the step in the warning.
 */
export function isolated(what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.warn(`${what} failed:`, error instanceof Error ? error.message : error);
  }
}

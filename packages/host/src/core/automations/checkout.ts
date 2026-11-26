import { isRepository } from '@consola/runner-protocol';
import type { RunItem } from '@consola/runner-protocol';
import type { StepCheckout } from '../steps/ports.ts';

/**
 * Where a run's steps work, from its record alone, so a runner that restarted rebuilds it from
 * the record the cell sends with `run.answered`: a pull request's run works on its repository
 * (`item.repo`) at the head commit the run was recorded on (`item.headSha`), its changes read
 * against its base branch (`item.baseRef`), its head fetched by number (`item.number`). A run on
 * no pull request works in no checkout. A pull request's record missing any of them is refused
 * in one sentence, never guessed: a later head would be commits nobody approved.
 */
export function checkoutOf(
  item: RunItem | null,
):
  | { readonly ok: true; readonly checkout: StepCheckout | null }
  | { readonly ok: false; readonly error: string } {
  if (item === null || item.kind !== 'pr') return { ok: true, checkout: null };
  if (item.headSha === null) {
    return {
      ok: false,
      error:
        "Its record does not name the pull request's head commit, so this runner has no commit to check out.",
    };
  }
  if (item.repo === null || !isRepository(item.repo) || item.number === null) {
    return {
      ok: false,
      error:
        'Its record does not name the pull request’s repository and number, so this runner has nothing to check out.',
    };
  }
  return {
    ok: true,
    checkout: {
      repository: item.repo,
      commit: item.headSha,
      pullRequest: item.number,
      baseRef: item.baseRef,
    },
  };
}

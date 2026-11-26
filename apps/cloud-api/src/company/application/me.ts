import type { Caller } from '../domain/caller.js';

/** The caller as the cell sees them: ids, role and region, since the cell holds no accounts. */
export type CallerView = Pick<Caller, 'personId' | 'workspaceId' | 'role' | 'region'>;

/** Who is asking, as their checked token says. */
export function describeMe(caller: Caller): CallerView {
  const { personId, workspaceId, role, region } = caller;
  return { personId, workspaceId, role, region };
}

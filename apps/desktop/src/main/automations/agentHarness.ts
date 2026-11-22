import { launchFieldsFor, type Harness } from '../../shared/harness';
import { stepTurnProblem, toolPolicyProblem } from '../drivers';

/**
 * What the engine's `agentHarness` port answers for a workspace's default
 * harness (none: the built-in Claude). `problem`: why it cannot run a
 * read-only session at all, which refuses every agent entry. `stepProblem`:
 * why its steps' reporting turns would not launch as Consola compiles them,
 * which refuses every steps entry with an agent step (Call 15).
 */
export function agentHarnessView(harness: Harness | undefined): {
  name: string;
  problem: string | null;
  stepProblem: string | null;
} {
  const fields = launchFieldsFor(harness);
  return {
    name: harness?.name ?? 'Claude',
    problem: toolPolicyProblem(fields, 'read-only'),
    stepProblem: stepTurnProblem(fields),
  };
}

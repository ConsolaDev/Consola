import { leafSteps, type AgentDefinition, type StepsAutomation } from '@consola/factory-spec';

/**
 * The write keys the format accepts before the engine runs them (slice 3-B,
 * Call 2, as 3-A's `flowNotYet` was): an entry that writes one has the
 * problem below, so no file asks for a write agent before the launch path
 * holds it to its environment. Each key leaves the list for a rule that
 * stays: `checkout.repo` left it when the engine began making a run's own
 * checkout (Task 12: `NO_RUN_CHECKOUTS` on a host without one), and
 * `tools.edit` and `tools.write` leave it when a host says its launch holds
 * a write agent (Task 13, which deletes this file).
 */
export const NOT_YET = ['tools.edit', 'tools.write'] as const;

const notYet = (key: string) =>
  `\`${key}\` runs from the next update; this automation does not run yet.`;

/**
 * Why an entry cannot run yet, or null: the first leaf agent step (a loop's
 * steps included) whose agent's `tools:` is not `read-only`.
 */
export function writesNotYet(
  automation: StepsAutomation,
  agents: Readonly<Record<string, AgentDefinition>>,
): string | null {
  for (const step of leafSteps(automation.steps)) {
    if (step.kind !== 'agent' || step.agent === undefined) continue;
    const tools = agents[step.agent]?.tools ?? 'read-only';
    if (tools !== 'read-only') return notYet(`tools: ${tools}`);
  }
  return null;
}

import { leafSteps, type StepsAutomation } from '@consola/factory-spec';

/*
 * Temporary, for slice 3's build (Call 2): the format accepts a control-flow
 * key a task before the engine runs it, so until then an entry that writes
 * one does not run, and says why. Each engine task that runs a key deletes it
 * from `NOT_YET`; the last deletes this file.
 */

export type FlowKey = 'gate' | 'then' | 'repeat' | 'on_failure' | 'budget';

const NOT_YET: readonly FlowKey[] = ['gate', 'then', 'repeat', 'on_failure', 'budget'];

/** Whether the entry writes `key`, a loop's steps included. */
function writes(automation: StepsAutomation, key: FlowKey): boolean {
  switch (key) {
    case 'gate':
      return leafSteps(automation.steps).some((step) => step.kind === 'gate');
    case 'then':
      return leafSteps(automation.steps).some((step) => step.stop === true);
    case 'repeat':
      return automation.steps.some((step) => step.kind === 'repeat');
    case 'on_failure':
      return (
        automation.onFailure !== undefined ||
        leafSteps(automation.steps).some(
          (step) => step.kind !== 'gate' && step.onFailure !== undefined,
        )
      );
    case 'budget':
      return automation.budget !== undefined;
  }
}

/** The first key of an entry the engine does not run yet, in the words `<key>` runs from the next update; …, or null. */
export function flowNotYet(automation: StepsAutomation): string | null {
  const key = NOT_YET.find((candidate) => writes(automation, candidate));
  return key ? `\`${key}\` runs from the next update; this automation does not run yet.` : null;
}

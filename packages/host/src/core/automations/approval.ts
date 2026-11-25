import type { StepsAutomation } from '@consola/factory-spec';

/**
 * How a matched run starts: `ask`, recorded `needs-approval` until a person answers it on the web
 * (`run.answered`); or `run`, walked at once.
 *
 * This is the one place that decides it. Stage 1 asks a person for every run, whatever the
 * entry's `mode:` says (`auto` included): accepting a version once, so later runs of it go
 * unattended, is Linear CON-122 ("Accept a factory version once"), and it changes this function
 * alone. The ring already walks a run this answers `run` for.
 */
export type Admission = 'ask' | 'run';

export function admissionOf(_automation: StepsAutomation): Admission {
  return 'ask';
}

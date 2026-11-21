import type { RunDefinition } from '../../../shared/automations';

type DefinitionStep = RunDefinition['automation']['steps'][number];

const hasCommand = (definition: RunDefinition) =>
  definition.automation.steps.some((step) => step.kind === 'run');

/**
 * What a steps run's approval says besides its steps: whose logins a command
 * uses, and, for a pull request, whose code a build or test may run. Both are
 * said only when there is a command to run: an agent step is read-only.
 */
export function approvalNotes(
  definition: RunDefinition,
  itemType: 'pr' | 'issue' | null,
): string[] {
  if (!hasCommand(definition)) return [];
  return [
    'Its commands run as you (your logins, the bound GitHub account).',
    ...(itemType === 'pr'
      ? [
          "In a pull request's worktree, a command that builds or tests runs the author's code with your logins.",
        ]
      : []),
  ];
}

/**
 * The commands marked `dry_run: run`, in file order: the ones that run even
 * when the run only reports. The approved version includes the key, so the
 * card names them whether or not this run is a dry run.
 */
export function dryRunCommands(definition: RunDefinition): string[] {
  return definition.automation.steps
    .filter(
      (step): step is Extract<DefinitionStep, { kind: 'run' }> =>
        step.kind === 'run' && step.dryRun === 'run',
    )
    .map((step) => step.id);
}

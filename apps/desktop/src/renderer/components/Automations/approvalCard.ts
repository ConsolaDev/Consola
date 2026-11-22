import type { RunDefinition } from '../../../shared/automations';
import { agentStepHead, serverGrantLine, skillsLine } from './agentGrantWords';

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

/**
 * What a step's agent is, as the approval card shows it from the run's
 * definition: the node's words (`reviewer · claude-work · opus`), its file,
 * its description when it has one and its body, exactly as approved; the
 * step's head, a line per server it names (no tool names: a definition holds
 * no probe), its skills, and whether its run reads text other people wrote
 * (`readsItems`, absent from a cron entry's definition and one from before
 * 2-C). Null for a step with no agent.
 */
export function approvalAgent(
  definition: RunDefinition,
  stepId: string,
): {
  words: string;
  file: string;
  description?: string;
  body: string;
  head: string;
  servers: string[];
  skills: string | null;
  readsOthers: boolean;
} | null {
  const agent = definition.agents?.[stepId];
  if (!agent) return null;
  const words = [agent.name, agent.harnessId, agent.model]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  return {
    words,
    file: `agents/${agent.name}.md`,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    body: agent.body,
    head: agentStepHead(agent.mcpServers),
    servers: agent.mcpServers.map((server) => serverGrantLine(server)),
    skills: skillsLine(agent.skills),
    readsOthers: definition.readsItems === true,
  };
}

import type { RunDefinition, StepDetail } from '../../../shared/automations';
import { agentStepHead, serverGrantLine, skillsLine } from './agentGrantWords';

type DefinitionEntry = RunDefinition['automation']['steps'][number];
type DefinitionStep = Exclude<DefinitionEntry, { kind: 'repeat' }>;

/*
 * The renderer's copy of factory-spec's `flatSteps` and `leafSteps`: the
 * renderer loads no factory-spec runtime (its `run.ts` imports Node's
 * crypto), only its types. `src/main/automations/stepTree.parity.test.ts`
 * keeps the two one rule.
 */

/** Record order: each entry, and right after a loop its steps, each with `loop`, the loop's id. */
export function definitionEntries(
  entries: readonly DefinitionEntry[],
): Array<{ step: DefinitionEntry; loop?: string }> {
  return entries.flatMap(
    (step): Array<{ step: DefinitionEntry; loop?: string }> =>
      step.kind === 'repeat'
        ? [{ step }, ...step.steps.map((inner) => ({ step: inner, loop: step.id }))]
        : [{ step }],
  );
}

/** Every leaf step, a loop's included, in file order: what every "does any step…" question reads. */
export function definitionLeaves(entries: readonly DefinitionEntry[]): DefinitionStep[] {
  return entries.flatMap((step) => (step.kind === 'repeat' ? step.steps : [step]));
}

const hasCommand = (definition: RunDefinition) =>
  definitionLeaves(definition.automation.steps).some((step) => step.kind === 'run');

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
  return definitionLeaves(definition.automation.steps)
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
 * step's head, a line per server it names (a whole server's tools named as
 * the definition keeps them, from its harness's CLI when the run was made:
 * review S1), its skills, and whether its run reads text other people wrote
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

/**
 * What the approval card shows of a step's skills, from its step detail:
 * each `SKILL.md` as the run's own copy holds it, by its file, or why it
 * cannot (review M4). The card asks only for a step whose agent names skills.
 */
export function approvalSkills(
  detail: StepDetail | null,
): { texts: Array<{ file: string; text: string }> } | { problem: string } {
  if (detail?.skillsProblem !== undefined) return { problem: detail.skillsProblem };
  if (!detail?.skillTexts) return { problem: "Its skills can't be shown from this run's folder." };
  return {
    texts: detail.skillTexts.map(({ name, text }) => ({ file: `skills/${name}/SKILL.md`, text })),
  };
}
